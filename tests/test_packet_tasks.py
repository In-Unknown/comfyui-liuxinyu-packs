"""Exercise packet ordering with the real ComfyUI executor, including cache-none."""

import asyncio
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import execution
import nodes
import packet_tasks
from PIL import Image
import torch
from aiohttp import web
from comfy_api.latest import io
from comfy_execution.graph_utils import GraphBuilder
with patch("server.PromptServer.instance", SimpleNamespace(routes=web.RouteTableDef()), create=True):
    from image_path_nodes import MatchPath, LoadImageBatchFromPath
from preview_long_image_node import LiuxinyuPreviewLongImage
from stitch_batch_node import LiuxinyuStitchImageBatchList
from split_preview_nodes import LiuxinyuSplitLook

EVENTS = []


class Values(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="PacketTestValues", inputs=[io.AnyType.Input("payload")],
                         outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, payload):
        return io.NodeOutput(payload["value"])


class ListValues(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="PacketTestListValues", inputs=[io.AnyType.Input("payload")],
                         outputs=[io.AnyType.Output(is_output_list=True)])

    @classmethod
    def execute(cls, payload):
        return io.NodeOutput(payload["value"])


class Process(io.ComfyNode):
    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="PacketTestProcess", inputs=[io.AnyType.Input("value"),
                         io.String.Input("label", default="work"), io.AnyType.Input("other", optional=True)],
                         outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, value, label="work", other=None):
        EVENTS.append((label, value, other))
        if label == "fail" and value == 2:
            raise ValueError("deliberate failure")
        return io.NodeOutput(value)


class Slow(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        schema = Process.define_schema()
        schema.node_id = "PacketTestSlow"
        return schema

    @classmethod
    async def execute(cls, value, label="slow", other=None):
        EVENTS.append(("begin", value, None))
        await asyncio.sleep(0.01)
        EVENTS.append(("end", value, None))
        return io.NodeOutput(value)


class FanOut(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="PacketTestFanOut", inputs=[io.AnyType.Input("value")],
                         outputs=[io.AnyType.Output(is_output_list=True)])

    @classmethod
    def execute(cls, value):
        return io.NodeOutput([value * 10, value * 10 + 1])


class Group(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="PacketTestGroup", is_input_list=True,
                         inputs=[io.AnyType.Input("value")], outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(value)


class Capture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="PacketTestCapture", is_input_list=True, accept_all_inputs=True,
                         inputs=[io.AnyType.Input("value0")], outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, **kwargs):
        return io.NodeOutput(ui=kwargs)


class Expand(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        schema = Process.define_schema()
        schema.node_id = "PacketTestExpand"
        schema.enable_expand = True
        return schema

    @classmethod
    def execute(cls, value, label="expanded", other=None):
        graph = GraphBuilder()
        process = graph.node("PacketTestProcess", value=value, label=label)
        return io.NodeOutput(process.out(0), expand=graph.finalize())


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def workflow(values=(1, 2, 3), list_source=False):
    return {
        "values": node("PacketTestListValues" if list_source else "PacketTestValues", payload={"value": list(values)}),
        "start": node("LiuxinyuPacketStart", value0=["values", 0]),
        "work": node("PacketTestProcess", value=["start", 1], label="work"),
        "end": node("LiuxinyuPacketEnd", condition=["start", 0], value0=["work", 0]),
        "out": node("PacketTestCapture", value0=["end", 0]),
    }


class PacketTests(unittest.TestCase):
    def setUp(self):
        EVENTS.clear()
        classes = [Values, ListValues, Process, Slow, FanOut, Group, Capture, Expand]
        classes += [value for value in vars(packet_tasks).values()
                    if isinstance(value, type) and issubclass(value, io.ComfyNode)]
        self.mapping = {cls.define_schema().node_id: cls for cls in classes}
        self.mapping.update({cls.__name__: cls for cls in
                             (MatchPath, LoadImageBatchFromPath, LiuxinyuPreviewLongImage, LiuxinyuStitchImageBatchList,
                              LiuxinyuSplitLook)})
        self.patcher = patch.dict(nodes.NODE_CLASS_MAPPINGS, self.mapping)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def run_graph(self, prompt, cache_type=execution.CacheType.RAM_PRESSURE, executor=None, success=True):
        prompt = deepcopy(prompt)
        validation = asyncio.run(execution.validate_prompt("packet-test", prompt, None))
        self.assertTrue(validation[0], validation)
        if executor is None:
            executor = execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *a: None),
                                                cache_type, {"ram": 0, "ram_inactive": 0, "lru": 100})
        executor.execute(prompt, "packet-test", execute_outputs=validation[2])
        self.assertEqual(executor.success, success, executor.status_messages)
        return executor

    def test_zip_repeat_last_and_scalars_all_cache_modes(self):
        for cache in execution.CacheType:
            with self.subTest(cache=cache):
                EVENTS.clear()
                prompt = workflow()
                prompt["short"] = node("PacketTestValues", payload={"value": [10, 20]})
                prompt["start"]["inputs"].update(value1=["short", 0], value2="fixed")
                prompt["work"]["inputs"]["other"] = ["start", 2]
                prompt["end"]["inputs"]["value1"] = ["start", 3]
                prompt["out"]["inputs"]["value1"] = ["end", 1]
                result = self.run_graph(prompt, cache)
                self.assertEqual(EVENTS, [("work", 1, 10), ("work", 2, 20), ("work", 3, 20)])
                self.assertEqual(result.history_result["outputs"]["out"],
                                 {"value0": [1, 2, 3], "value1": ["fixed"] * 3})

    def test_waits_for_every_branch(self):
        prompt = workflow(list_source=True)
        prompt["slow"] = node("PacketTestSlow", value=["start", 1], label="slow")
        prompt["end"]["inputs"]["value1"] = ["slow", 0]
        self.run_graph(prompt, execution.CacheType.NONE)
        for index, event in enumerate(EVENTS):
            if event[1] > 1:
                self.assertIn(("end", event[1] - 1, None), EVENTS[:index])

    def test_partial_execution_includes_second_return_branch(self):
        for selected in (["end"], ["out"], ["preview"]):
            with self.subTest(selected=selected):
                prompt = workflow([torch.zeros(1, 210, 7, 3), torch.ones(1, 310, 7, 3)])
                prompt["work"] = node("LiuxinyuStitchImageBatchList", images=["start", 1],
                                      direction="从上到下", target_format="PNG")
                prompt["split"] = node("LiuxinyuSplitLook", image=["work", 0], block_height=100)
                prompt["preview"] = node("PreviewImage", images=["split", 0])
                prompt["end"]["inputs"]["value1"] = ["preview", 0]
                prompt["out"]["inputs"]["value1"] = ["end", 1]
                validation = asyncio.run(execution.validate_prompt("packet-partial", prompt, selected))
                self.assertTrue(validation[0], validation)
                self.assertTrue({"work", "split", "preview"}.issubset(prompt["start"]["_loop_body"]))
                executor = execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *a: None),
                                                    execution.CacheType.NONE, {"ram": 0, "ram_inactive": 0})
                with patch.object(Image.Image, "save"), patch.object(nodes.args, "disable_metadata", True):
                    executor.execute(prompt, "packet-partial", execute_outputs=validation[2])
                self.assertTrue(executor.success, executor.status_messages)

                if selected == ["out"]:
                    result = executor.history_result["outputs"]["out"]
                    self.assertEqual([image.shape[1] for image in result["value0"]], [210, 310])
                    self.assertEqual([image.shape[1] for image in result["value1"]],
                                     [100, 100, 10, 100, 100, 100, 10])

    def test_list_consumer_runs_separately_per_packet(self):
        prompt = workflow()
        prompt["work"] = node("PacketTestFanOut", value=["start", 1])
        prompt["group"] = node("PacketTestGroup", value=["work", 0])
        prompt["end"]["inputs"]["value0"] = ["group", 0]
        result = self.run_graph(prompt)
        self.assertEqual(result.history_result["outputs"]["out"]["value0"], [[10, 11], [20, 21], [30, 31]])

    def test_execution_list_and_atomic_nested_arrays(self):
        for values in ([[1, 2], [3, 4]], [[1, 2]]):
            for is_list in (False, True):
                result = self.run_graph(workflow(values, list_source=is_list))
                self.assertEqual(result.history_result["outputs"]["out"]["value0"], values)

    def test_tensor_batch_is_one_value(self):
        tensor = torch.zeros(3, 2, 4, 3)
        prompt = workflow()
        prompt["values"]["inputs"]["payload"]["value"] = tensor
        result = self.run_graph(prompt)
        output = result.history_result["outputs"]["out"]["value0"]
        self.assertEqual(len(output), 1)
        self.assertEqual(tuple(output[0].shape), (3, 2, 4, 3))

    def test_real_directory_loading_stitch_and_preview(self):
        root = PACK.parents[1] / "temp" / f"packet-test-{uuid.uuid4().hex}"
        root.mkdir(parents=True)
        folders = []
        for index, count in enumerate((2, 3, 1)):
            folder = root / str(index)
            folder.mkdir()
            folders.append(str(folder))
            for image_index in range(count):
                Image.new("RGB", (8, 4), (index * 60, image_index * 50, 200)).save(folder / f"{image_index}.png")
        prompt = workflow(folders, list_source=True)
        prompt["work"] = node("MatchPath", directory=["start", 1], match_mode="正则表达式",
                              match_text=r"\.png$", match_target="文件", recursive=False, match_full_path=False)
        prompt["load"] = node("LoadImageBatchFromPath", path=["work", 0], target_width=8, target_height=0)
        prompt["stitch"] = node("LiuxinyuStitchImageBatchList", images=["load", 0],
                                direction="从上到下", target_format="PNG")
        prompt["end"]["inputs"]["value0"] = ["stitch", 0]
        prompt["out"] = node("LiuxinyuPreviewLongImage", image=["end", 0],
                             scroll_direction="从左向右", tall_scroll_direction="从上到下")
        try:
            with patch("folder_paths.get_temp_directory", return_value=str(root)):
                executor = self.run_graph(prompt)
            images = executor.history_result["outputs"]["out"]["images"]
            self.assertEqual([image["preview_size"] for image in images], [[8, 8], [8, 12], [8, 4]])
            for index, meta in enumerate(images):
                with Image.open(root / meta["filename"]) as image:
                    self.assertEqual(image.getpixel((0, 0)), (index * 60, 0, 200))
        finally:
            for path in sorted(root.rglob("*"), key=lambda path: len(path.parts), reverse=True):
                if path.is_file():
                    path.unlink()
                else:
                    path.rmdir()
            root.rmdir()

    def test_empty_and_missing_inputs(self):
        result = self.run_graph(workflow([]))
        self.assertEqual(EVENTS, [])
        self.assertEqual(result.history_result["outputs"]["out"]["value0"], [])
        prompt = workflow()
        prompt["empty"] = node("PacketTestValues", payload={"value": []})
        prompt["start"]["inputs"]["value1"] = ["empty", 0]
        self.run_graph(prompt, success=False)
        self.assertEqual(EVENTS, [])
        prompt = workflow()
        prompt["end"]["inputs"]["value1"] = ["start", 2]
        self.run_graph(prompt, success=False)
        self.assertEqual(EVENTS, [])

    def test_failure_stops_later_packets(self):
        prompt = workflow()
        prompt["work"]["inputs"]["label"] = "fail"
        self.run_graph(prompt, success=False)
        self.assertEqual(EVENTS, [("fail", 1, None), ("fail", 2, None)])

    def test_repeated_runs_and_expanding_body(self):
        prompt = workflow()
        prompt["work"]["class_type"] = "PacketTestExpand"
        executor = self.run_graph(prompt)
        self.run_graph(prompt, executor=executor)
        self.assertEqual([item[1] for item in EVENTS], [1, 2, 3] * 2)

    def test_nested_pairs(self):
        prompt = workflow([1, 2])
        prompt["inner"] = node("LiuxinyuPacketStart", value0=["start", 1], value1=["values", 0])
        prompt["work"]["inputs"]["value"] = ["inner", 2]
        prompt["work"]["inputs"]["other"] = ["inner", 1]
        prompt["inner_end"] = node("LiuxinyuPacketEnd", condition=["inner", 0], value0=["work", 0])
        prompt["end"]["inputs"]["value0"] = ["inner_end", 0]
        result = self.run_graph(prompt)
        self.assertEqual(EVENTS, [("work", 1, 1), ("work", 2, 1), ("work", 1, 2), ("work", 2, 2)])
        self.assertEqual(result.history_result["outputs"]["out"]["value0"], [1, 2, 1, 2])

    def test_round_number_and_nested_reset(self):
        prompt = workflow([10, 20, 30])
        prompt["work"]["inputs"]["other"] = ["start", 101]
        self.run_graph(prompt)
        self.assertEqual(EVENTS, [("work", 10, 1), ("work", 20, 2), ("work", 30, 3)])
        EVENTS.clear()
        prompt = workflow([10, 20])
        prompt["inner"] = node("LiuxinyuPacketStart", value0=["start", 1], value1=["values", 0])
        prompt["work"]["inputs"].update(value=["inner", 101], other=["start", 101])
        prompt["inner_end"] = node("LiuxinyuPacketEnd", condition=["inner", 0], value0=["work", 0])
        prompt["end"]["inputs"]["value0"] = ["inner_end", 0]
        self.run_graph(prompt)
        self.assertEqual(EVENTS, [("work", 1, 1), ("work", 2, 1), ("work", 1, 2), ("work", 2, 2)])

    def test_round_number_direct_return(self):
        for values in ([], [99], [4, 5, 6]):
            prompt = workflow(values)
            prompt["end"]["inputs"]["value1"] = ["start", 101]
            prompt["out"]["inputs"]["value1"] = ["end", 1]
            result = self.run_graph(prompt)
            self.assertEqual(result.history_result["outputs"]["out"]["value1"], list(range(1, len(values)+1)))

    def test_unclosed_side_branch_is_rejected(self):
        prompt = workflow()
        prompt["escape"] = node("PacketTestCapture", value0=["work", 0])
        validation = asyncio.run(execution.validate_prompt("packet-test", prompt, None))
        self.assertFalse(validation[0], validation)

    def test_last_socket_keeps_its_index(self):
        prompt = workflow([7])
        prompt["start"]["inputs"]["value99"] = 99
        prompt["end"]["inputs"]["value99"] = ["start", 100]
        prompt["out"]["inputs"]["value99"] = ["end", 99]
        result = self.run_graph(prompt)
        self.assertEqual(result.history_result["outputs"]["out"]["value99"], [99])


if __name__ == "__main__":
    unittest.main()
