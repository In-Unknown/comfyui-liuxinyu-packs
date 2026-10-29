"""Minimal execution tests for the feedback loop nodes."""

import asyncio
from copy import deepcopy
from contextlib import nullcontext
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import faulthandler

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import execution
import nodes
import torch
from comfy_api.latest import io
import conditional_loop
import packet_tasks
from conditional_loop import (
    LiuxinyuConditionalReturn,
    LiuxinyuConditionalStep,
    LiuxinyuReturnPoint,
    LiuxinyuReturnSource,
)

EVENTS = []


class Seed(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ConditionalTestSeed", inputs=[], outputs=[io.Int.Output(), io.String.Output()])

    @classmethod
    def execute(cls):
        return io.NodeOutput(0, "start")


class Advance(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ConditionalTestAdvance", inputs=[io.Int.Input("value"), io.String.Input("label")],
                         outputs=[io.Int.Output(), io.String.Output(), io.Boolean.Output()])

    @classmethod
    def execute(cls, value, label):
        EVENTS.append((value, label))
        return io.NodeOutput(value + 1, f"{label}:{value + 1}", value + 1 < 3)


class StopAdvance(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        schema = Advance.define_schema()
        schema.node_id = "ConditionalTestStopAdvance"
        return schema

    @classmethod
    def execute(cls, value, label):
        return io.NodeOutput(value + 1, f"{label}:{value + 1}", False)


class Capture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ConditionalTestCapture", inputs=[io.Int.Input("value"), io.String.Input("label")],
                         outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, value, label):
        return io.NodeOutput(ui={"value": [value], "label": [label]})


class Payload(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ConditionalTestPayload", inputs=[io.AnyType.Input("payload")],
                         outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, payload):
        return io.NodeOutput(payload["value"])


class ListPayload(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ConditionalTestListPayload", inputs=[io.AnyType.Input("payload")],
                         outputs=[io.AnyType.Output(is_output_list=True)])

    @classmethod
    def execute(cls, payload):
        return io.NodeOutput(payload["value"])


class ChangePayload(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ConditionalTestChange", inputs=[io.AnyType.Input("value")],
                         outputs=[io.AnyType.Output(), io.Boolean.Output()])

    @classmethod
    def execute(cls, value):
        if isinstance(value, torch.Tensor):
            value = value + 1
            repeat = value.max().item() < 3
        elif isinstance(value, dict):
            value = {**value, "count": value["count"] + 1}
            repeat = value["count"] < 3
        elif isinstance(value, list):
            value = [*value, len(value)]
            repeat = len(value) < 3
        else:
            value, repeat = "wrong type", False
        return io.NodeOutput(value, repeat)


class Record(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="ConditionalTestRecord", inputs=[io.AnyType.Input("value")],
                         outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(ui={"value": [value]})


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def workflow():
    return {
        "seed": node("ConditionalTestSeed"),
        "start": node("LiuxinyuReturnPoint", value0=["seed", 0], value1=["seed", 1]),
        "advance": node("ConditionalTestAdvance", value=["start", 1], label=["start", 2]),
        "end": node("LiuxinyuConditionalReturn", handle=["start", 0], repeat=["advance", 2],
                    value0=["advance", 0], value1=["advance", 1]),
        "out": node("ConditionalTestCapture", value=["end", 0], label=["end", 1]),
    }


class ConditionalLoopTests(unittest.TestCase):
    def setUp(self):
        EVENTS.clear()
        classes = [Seed, Advance, StopAdvance, Capture, Payload, ListPayload, ChangePayload, Record,
                   LiuxinyuReturnPoint, LiuxinyuConditionalReturn, LiuxinyuReturnSource, LiuxinyuConditionalStep]
        classes += [value for value in vars(packet_tasks).values()
                    if isinstance(value, type) and issubclass(value, io.ComfyNode)]
        self.patch = patch.dict(nodes.NODE_CLASS_MAPPINGS, {
            cls.define_schema().node_id: cls for cls in classes
        })
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def run_graph(self, prompt, expected_success=True, executor=None, cache=execution.CacheType.NONE, selected=None):
        prompt = deepcopy(prompt)
        valid, errors, outputs, node_errors = asyncio.run(execution.validate_prompt("conditional-test", prompt, selected))
        self.assertTrue(valid, errors)
        if executor is None:
            executor = execution.PromptExecutor(
                SimpleNamespace(client_id=None, send_sync=lambda *args: None),
                cache, {"ram": 0, "ram_inactive": 0, "lru": 100},
            )
        with nullcontext() if expected_success else self.assertLogs(level="ERROR"):
            executor.execute(prompt, "conditional-test", execute_outputs=outputs)
        self.assertEqual(executor.success, expected_success, executor.status_messages)
        return executor

    def test_repeats_and_returns_final_values(self):
        result = self.run_graph(workflow())
        output = result.history_result["outputs"]["out"]
        self.assertEqual(output["value"], [3])
        self.assertEqual(output["label"], ["start:1:2:3"])
        self.assertEqual([event[0] for event in EVENTS], [0, 1, 2])

    def test_false_first_round_does_not_repeat(self):
        prompt = workflow()
        prompt["advance"]["class_type"] = "ConditionalTestStopAdvance"
        result = self.run_graph(prompt)
        self.assertEqual(result.history_result["outputs"]["out"]["value"], [1])

    def test_array_dict_and_image_batch_are_atomic_feedback(self):
        for value in ([], {"count": 0}, torch.zeros(2, 3, 4, 3)):
            with self.subTest(value=type(value)):
                prompt = {
                    "seed": node("ConditionalTestPayload", payload={"value": value}),
                    "start": node("LiuxinyuReturnPoint", value0=["seed", 0]),
                    "change": node("ConditionalTestChange", value=["start", 1]),
                    "end": node("LiuxinyuConditionalReturn", handle=["start", 0],
                                repeat=["change", 1], value0=["change", 0]),
                    "out": node("ConditionalTestRecord", value=["end", 0]),
                }
                output = self.run_graph(prompt).history_result["outputs"]["out"]["value"]
                self.assertEqual(len(output), 1)
                if isinstance(value, torch.Tensor):
                    self.assertTrue(torch.equal(output[0], torch.full_like(value, 3)))
                else:
                    self.assertEqual(output[0], [0, 1, 2] if isinstance(value, list) else {"count": 3})

    def test_repeated_execution_all_cache_modes(self):
        for cache in execution.CacheType:
            with self.subTest(cache=cache):
                EVENTS.clear()
                executor = self.run_graph(workflow(), cache=cache)
                self.run_graph(workflow(), executor=executor)
                self.assertEqual([event[0] for event in EVENTS], [0, 1, 2] * 2)

    def test_missing_and_incompatible_feedback_fail(self):
        for mode in ("missing", "static_type", "runtime_type"):
            prompt = workflow()
            if mode == "missing":
                del prompt["end"]["inputs"]["value1"]
            elif mode == "static_type":
                prompt["end"]["inputs"]["value0"] = ["advance", 1]
            else:
                prompt["wrong"] = node("ConditionalTestChange", value=["start", 1])
                prompt["end"]["inputs"]["value0"] = ["wrong", 0]
            with self.subTest(mode=mode):
                self.run_graph(prompt, expected_success=False)

    def test_empty_or_multiple_execution_values_fail(self):
        for values in ([], [0, 1]):
            for target in ("start", "end"):
                prompt = workflow()
                prompt["list"] = node("ConditionalTestListPayload", payload={"value": values})
                prompt[target]["inputs"]["value0"] = ["list", 0]
                with self.subTest(values=values, target=target):
                    result = self.run_graph(prompt, expected_success=False)
                    error = next(data for event, data in result.status_messages if event == "execution_error")
                    self.assertIn("执行列表", error["exception_message"])

    def test_iteration_limit(self):
        with patch.object(conditional_loop, "MAX_ITERATIONS", 2):
            result = self.run_graph(workflow(), expected_success=False)
        self.assertEqual(len(EVENTS), 2)
        error = next(data for event, data in result.status_messages if event == "execution_error")
        self.assertIn("2 轮", error["exception_message"])

    def test_nested_feedback(self):
        prompt = workflow()
        prompt["inner"] = node("LiuxinyuReturnPoint", value0=["seed", 0], value1=["start", 2])
        prompt["inner_work"] = node("ConditionalTestAdvance", value=["inner", 1], label=["inner", 2])
        prompt["inner_end"] = node("LiuxinyuConditionalReturn", handle=["inner", 0],
                                  repeat=["inner_work", 2], value0=["inner_work", 0], value1=["inner_work", 1])
        prompt["advance"]["inputs"]["label"] = ["inner_end", 1]
        output = self.run_graph(prompt).history_result["outputs"]["out"]
        self.assertEqual(output["value"], [3])
        self.assertEqual(len(EVENTS), 12)  # Three outer rounds, three inner rounds per outer round.

    def test_packet_outer_feedback_inner(self):
        prompt = workflow()
        prompt["packet"] = node("LiuxinyuPacketStart", value0=["seed", 0])
        prompt["start"]["inputs"]["value0"] = ["packet", 1]
        prompt["packet_end"] = node("LiuxinyuPacketEnd", condition=["packet", 0], value0=["end", 0], value1=["end", 1])
        prompt["out"]["inputs"].update(value=["packet_end", 0], label=["packet_end", 1])
        self.assertEqual(self.run_graph(prompt).history_result["outputs"]["out"]["value"], [3])

    def test_partial_execution_and_last_socket(self):
        prompt = workflow()
        prompt["start"]["inputs"]["value99"] = ["seed", 1]
        prompt["end"]["inputs"]["value99"] = ["start", 100]
        self.run_graph(prompt, selected=["end"])
        prompt["out"]["inputs"]["label"] = ["end", 99]
        self.assertEqual(self.run_graph(prompt).history_result["outputs"]["out"]["label"], ["start"])


if __name__ == "__main__":
    faulthandler.dump_traceback_later(45, exit=True)
    unittest.main()
