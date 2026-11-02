"""Exercise carried packet loops through the native executor, without model calls."""

import asyncio
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK.parents[1]), str(PACK)]
import execution
import nodes
import packet_return
import packet_tasks
import conditional_loop
from execution_list_node import LiuxinyuArrayToExecutionList
from comfy_api.latest import io
from comfy.model_management import InterruptProcessingException

EVENTS = []


class Value(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="CarryTestValue", inputs=[io.AnyType.Input("box")], outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, box): return io.NodeOutput(box["value"])


class ListValue(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="CarryTestList", inputs=[io.AnyType.Input("box")],
                         outputs=[io.AnyType.Output(is_output_list=True)])

    @classmethod
    def execute(cls, box): return io.NodeOutput(box["value"])


class Append(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="CarryTestAppend",
                         inputs=[io.AnyType.Input("packet"), io.AnyType.Input("state"),
                                 io.Int.Input("round"),
                                 io.Int.Input("until", default=100)],
                         outputs=[io.AnyType.Output(), io.Boolean.Output()])

    @classmethod
    def execute(cls, packet, state, round, until):
        EVENTS.append((packet, list(state), round))
        return io.NodeOutput([*state, packet], round < until)


class Capture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="CarryTestCapture", inputs=[io.AnyType.Input("value")],
                         outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, value): return io.NodeOutput(ui={"value": [value]})


def node(kind, **inputs): return {"class_type": kind, "inputs": inputs}


def graph(packets=(1, 2, 3), operation="与", until=100):
    return {
        "packets": node("CarryTestValue", box={"value": list(packets)}),
        "list": node("LiuxinyuArrayToExecutionList", array=["packets", 0]),
        "seed": node("CarryTestValue", box={"value": []}),
        "start": node("LiuxinyuPacketReturnStart", **{"packets.packet0": ["list", 0], "states.state0": ["seed", 0]}),
        "body": node("CarryTestAppend", packet=["start", 2], state=["start", 1], round=["start", 3], until=until),
        "end": node("LiuxinyuPacketReturnEnd", handle=["start", 0], condition=["body", 1], operation=operation,
                    **{"states.state0": ["body", 0]}),
        "out": node("CarryTestCapture", value=["end", 0]),
    }


class PacketReturnTests(unittest.TestCase):
    def setUp(self):
        EVENTS.clear()
        classes = [Value, ListValue, Append, Capture, LiuxinyuArrayToExecutionList]
        for module in (packet_return, packet_tasks, conditional_loop):
            classes += [v for v in vars(module).values() if isinstance(v, type) and issubclass(v, io.ComfyNode)]
        self.patcher = patch.dict(nodes.NODE_CLASS_MAPPINGS, {c.define_schema().node_id: c for c in classes})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def run_graph(self, prompt, success=True, executor=None, cache=execution.CacheType.NONE):
        prompt = deepcopy(prompt)
        valid = asyncio.run(execution.validate_prompt("carry-test", prompt, None))
        self.assertTrue(valid[0], valid)
        executor = executor or execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *args: None),
                                                       cache, {"ram": 0, "ram_inactive": 0, "lru": 100})
        with patch("logging.error"):
            executor.execute(prompt, "carry-test", execute_outputs=valid[2])
        self.assertEqual(executor.success, success, executor.status_messages)
        return executor

    def output(self, prompt): return self.run_graph(prompt).history_result["outputs"]["out"]["value"][0]

    def test_truth_table(self):
        expected = {(False, False): [False, False, True, True, False, True],
                    (False, True): [False, True, True, False, True, False],
                    (True, False): [False, True, True, False, True, False],
                    (True, True): [True, True, False, False, False, True]}
        for (a, b), row in expected.items():
            for op, value in zip(packet_return.OPERATORS, row):
                with self.subTest(a=a, b=b, op=op): self.assertIs(packet_return.combine(a, b, op), value)

    def test_accumulate_and_early_exit(self):
        self.assertEqual(self.output(graph()), [1, 2, 3])
        self.assertEqual([e[1] for e in EVENTS], [[], [1], [1, 2]])
        self.assertEqual(self.output(graph(until=1)), [1])

    def test_executor_obeys_all_twenty_four_continuation_cases(self):
        expected = {(False, False): [False, False, True, True, False, True],
                    (False, True): [False, True, True, False, True, False],
                    (True, False): [False, True, True, False, True, False],
                    (True, True): [True, True, False, False, False, True]}
        for (a, b), row in expected.items():
            for operation, repeat in zip(packet_return.OPERATORS, row):
                with self.subTest(a=a, b=b, operation=operation):
                    EVENTS.clear()
                    prompt = graph(packets=[10, 20] if a else [10], operation=operation)
                    prompt['end']['inputs']['condition'] = b
                    def interrupt_after_second_body():
                        if len(EVENTS) >= 2: raise InterruptProcessingException()
                    with patch.object(packet_return, 'throw_exception_if_processing_interrupted', interrupt_after_second_body):
                        self.run_graph(prompt, success=not repeat)
                    self.assertEqual(len(EVENTS), 2 if repeat else 1)

    def test_highest_lane_and_partial_execution(self):
        prompt = graph()
        prompt['start']['inputs']['states.state99'] = ['seed', 0]
        prompt['end']['inputs']['states.state99'] = ['start', 2]
        prompt['body']['inputs'].update(packet=['start', 3], round=['start', 4])
        prompt['out']['inputs']['value'] = ['end', 1]
        self.assertEqual(self.output(prompt), [])

    def test_replay_last_packet_and_keep_advancing_state(self):
        self.assertEqual(self.output(graph(operation="或", until=5)), [1, 2, 3, 3, 3])
        self.assertEqual([e[2] for e in EVENTS], [1, 2, 3, 4, 5])

    def test_empty_skips_body_with_every_operator(self):
        for op in packet_return.OPERATORS:
            prompt = graph(packets=[], operation=op)
            prompt["seed"]["inputs"]["box"]["value"] = ["unchanged"]
            self.assertEqual(self.output(prompt), ["unchanged"])
        self.assertEqual(EVENTS, [])

    def test_nested_arrays_stay_whole_packets(self):
        for source, data in (("CarryTestValue", [[1, 2], [3]]), ("CarryTestList", [[1, 2]])):
            prompt = graph(packets=data)
            prompt["packets"]["class_type"] = source
            if source == 'CarryTestList':
                prompt['start']['inputs']['packets.packet0'] = ['packets', 0]
            self.assertEqual(self.output(prompt), data)

    def test_multiple_columns_and_states(self):
        prompt = graph()
        prompt["short"] = node("CarryTestList", box={"value": [10, 20]})
        prompt["seed2"] = node("CarryTestValue", box={"value": []})
        prompt["start"]["inputs"].update({"packets.packet1": ["short", 0], "states.state1": ["seed2", 0]})
        prompt["body"]["inputs"].update(packet=["start", 3], round=["start", 5])
        prompt["body2"] = node("CarryTestAppend", packet=["start", 4], state=["start", 2],
                               round=["start", 5], until=100)
        prompt["end"]["inputs"]["states.state1"] = ["body2", 0]
        prompt["out2"] = node("CarryTestCapture", value=["end", 1])
        out = self.run_graph(prompt).history_result["outputs"]
        self.assertEqual(out["out"]["value"], [[1, 2, 3]])
        self.assertEqual(out["out2"]["value"], [[10, 20, 20]])

    def test_missing_state_and_mixed_empty_columns_fail(self):
        for mode in ("missing", "empty"):
            prompt = graph()
            if mode == "missing": del prompt["end"]["inputs"]["states.state0"]
            else:
                prompt["empty"] = node("CarryTestList", box={"value": []})
                prompt["start"]["inputs"]["packets.packet1"] = ["empty", 0]
            with self.subTest(mode=mode): self.run_graph(prompt, success=False)

    def test_state_is_one_value_and_same_type(self):
        for value, kind in (([[], []], "CarryTestList"), ([], "CarryTestList"), ({}, "CarryTestValue")):
            prompt = graph()
            prompt["wrong"] = node(kind, box={"value": value})
            prompt["end"]["inputs"]["states.state0"] = ["wrong", 0]
            with self.subTest(value=value, kind=kind): self.run_graph(prompt, success=False)

    def test_all_cache_modes_rerun(self):
        for cache in execution.CacheType:
            EVENTS.clear()
            executor = self.run_graph(graph(), cache=cache)
            self.run_graph(graph(), executor=executor)
            self.assertEqual([e[0] for e in EVENTS], [1, 2, 3] * 2)

    def test_manual_interrupt_of_unbounded_replay(self):
        def interrupt():
            if len(EVENTS) == 5: raise InterruptProcessingException()
        prompt = graph(operation="与非", until=1)
        with patch.object(packet_return, "throw_exception_if_processing_interrupted", interrupt):
            self.run_graph(prompt, success=False)
        self.assertEqual([e[0] for e in EVENTS], [1, 2, 3, 3, 3])

    def test_nested_carried_loops(self):
        prompt = graph(packets=[[1, 2], [3]])
        prompt["inner_list"] = node("LiuxinyuArrayToExecutionList", array=["start", 2])
        prompt["inner"] = node("LiuxinyuPacketReturnStart", **{"packets.packet0": ["inner_list", 0], "states.state0": ["start", 1]})
        for key in ("packet", "state", "round"):
            prompt["body"]["inputs"][key][0] = "inner"
        prompt["inner_end"] = node("LiuxinyuPacketReturnEnd", handle=["inner", 0], condition=True,
                                  operation="与", **{"states.state0": ["body", 0]})
        prompt["end"]["inputs"].update(condition=True, **{"states.state0": ["inner_end", 0]})
        self.assertEqual(self.output(prompt), [1, 2, 3])

    def test_plain_packet_array_is_rejected_but_state_array_is_valid(self):
        for value in ([], [1], [1, 2], [[1, 2]], 42, {'a': 1}):
            with self.subTest(value=value):
                prompt = graph()
                prompt['packets']['inputs']['box']['value'] = value
                prompt['start']['inputs']['packets.packet0'] = ['packets', 0]
                result = self.run_graph(prompt, success=False)
                errors = [msg[1]['exception_message'] for msg in result.status_messages if msg[0] == 'execution_error']
                self.assertIn('将任意数组转为执行列表', errors[0])
                self.assertEqual(EVENTS, [])


if __name__ == "__main__": unittest.main()
