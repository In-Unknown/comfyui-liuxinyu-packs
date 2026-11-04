"""Python operator contracts and real ComfyUI lazy execution, without remote calls."""

import asyncio
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]
import execution
import nodes
from comfy_api.latest import io
from comfy_extras.nodes_logic import SwitchNode
from operator_node import LiuxinyuCompare as Compare, LiuxinyuBooleanOperator as Boolean, LiuxinyuBitwiseOperator as Bitwise


VALUES = {}
CALLS = []
CAPTURED = []


class OperatorTestSource(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="OperatorTestSource", inputs=[io.String.Input("key")],
                         outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, key):
        CALLS.append(key)
        if key == "explode":
            raise ValueError("The unselected branch must not execute")
        return io.NodeOutput(VALUES[key])


class OperatorTestCapture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="OperatorTestCapture", inputs=[io.AnyType.Input("value")],
                         outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, value):
        CAPTURED.append(value)
        return io.NodeOutput(ui={"value": [value]})


class OperatorTests(unittest.TestCase):
    def test_comparisons(self):
        options = Compare.define_schema().inputs[0].options
        self.assertEqual(options, ["等于", "不等于", "小于", "小于或等于", "大于", "大于或等于",
                                   "同一对象", "不是同一对象", "属于", "不属于"])
        same = [1, 2]
        cases = [("==", 1, True, True), ("!=", "1", 1, True),
                 ("<", 1, 1.5, True), ("<=", 2, 2, True), (">", "2", "10", True),
                 (">=", "中", "A", True), ("<", [1, 2], [1, 3], True),
                 ("is", same, same, True), ("is", same, [1, 2], False),
                 ("is not", same, [1, 2], True), ("in", "重", "承重", True),
                 ("in", "topic", {"topic": "承重"}, True),
                 ("not in", "承重", {"topic": "承重"}, True), ("==", None, None, True),
                 ("==", float("nan"), float("nan"), False)]
        for op, a, b, expected in cases:
            with self.subTest(op=op, a=a, b=b):
                result = Compare.execute(op, a, b).result[0]
                self.assertIs(type(result), bool)
                self.assertIs(result, expected)
        self.assertIs(Compare.execute("等于", 1, 1).result[0], True)
        self.assertIs(Compare.execute("不属于", "x", ["a"]).result[0], True)
        self.assertTrue(math.isnan(Compare.fingerprint_inputs("is")))
        with self.assertRaises(TypeError): Compare.execute("<", 1, "2")
        with self.assertRaises(TypeError): Compare.execute("in", "x", 2)

    def test_ambiguous_comparison_is_not_silently_reduced(self):
        import numpy as np
        with self.assertRaises(ValueError):
            Compare.execute("==", np.array([1, 2]), np.array([1, 2]))

    def test_boolean_returns_original_operand(self):
        for a in [0, 1, "", "abc", [], [1], {}, {"a": 1}, None, False, True]:
            self.assertIs(Boolean.execute(a, "not").result[0], not a)
            for b in [None, 0, "abc", [], [2], {"b": 2}]:
                for op in ["and", "or"]:
                    expected = a and b if op == "and" else a or b
                    result = Boolean.execute(a, op, b).result[0]
                    self.assertIs(result, expected)
        self.assertEqual(Boolean.execute(0, "and").result, (0,))
        self.assertEqual(Boolean.execute(1, "or").result, (1,))

    def test_bitwise_values_and_types(self):
        cases = [("&", 6, 3, 2), ("|", 6, 3, 7), ("^", 6, 3, 5),
                 ("&", True, False, False), ("|", True, False, True),
                 ("^", True, True, False), ("&", True, 2, 0),
                 ("&", {1, 2}, {2, 3}, {2}), ("|", {1, 2}, {2, 3}, {1, 2, 3}),
                 ("^", {1, 2}, {2, 3}, {1, 3}), ("<<", 3, 2, 12),
                 (">>", -8, 2, -2), ("<<", True, True, 2)]
        for op, a, b, expected in cases:
            with self.subTest(op=op, a=a, b=b):
                result = Bitwise.execute(a, op, b).result[0]
                self.assertEqual(result, expected)
                self.assertIs(type(result), type(expected))
        for a, expected in [(True, -2), (False, -1), (3, -4), (-1, 0)]:
            result = Bitwise.execute(a, "~").result[0]
            self.assertEqual(result, expected)
            self.assertIs(type(result), int)
        for op, a, b in [("&", 1.5, 2), ("|", [1], [2]), ("&", {1}, 1),
                         ("<<", 1, 1.5), ("~", {1}, None)]:
            with self.subTest(op=op, a=a):
                with self.assertRaises(TypeError): Bitwise.execute(a, op, b)
        with self.assertRaises(ValueError): Bitwise.execute(1, "<<", -1)

    def run_graph(self, graph):
        CALLS.clear()
        CAPTURED.clear()
        classes = [Compare, Boolean, Bitwise, OperatorTestSource, OperatorTestCapture, SwitchNode]
        with patch.dict(nodes.NODE_CLASS_MAPPINGS, {c.define_schema().node_id: c for c in classes}), \
                patch('server.PromptServer.instance', SimpleNamespace(client_id=None), create=True):
            valid = asyncio.run(execution.validate_prompt("operators", graph, None))
            self.assertTrue(valid[0], valid)
            runner = execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *a: None),
                execution.CacheType.RAM_PRESSURE, {"ram": 0, "ram_inactive": 0})
            runner.execute(graph, "operators", execute_outputs=valid[2])
        self.assertTrue(runner.success, runner.status_messages)
        self.assertEqual(runner.history_result["outputs"]["out"]["value"], [CAPTURED[-1]])
        return CAPTURED[-1]

    def graph(self, kind, op, a, b="b"):
        graph = {
            "a": {"class_type": "OperatorTestSource", "inputs": {"key": "a"}},
            "b": {"class_type": "OperatorTestSource", "inputs": {"key": b}},
            "op": {"class_type": kind, "inputs": {"a": ["a", 0], "operation": op}},
            "out": {"class_type": "OperatorTestCapture", "inputs": {"value": ["op", 0]}},
        }
        VALUES["a"] = a
        if op not in ["not", "~"]: graph["op"]["inputs"]["b"] = ["b", 0]
        return graph

    def test_real_executor_short_circuits(self):
        for op, a in [("and", 0), ("and", []), ("and", None), ("or", 1), ("or", {"x": 1})]:
            with self.subTest(op=op, a=a):
                result = self.run_graph(self.graph("LiuxinyuBooleanOperator", op, a, "explode"))
                self.assertIs(result, a)
                self.assertEqual(CALLS, ["a"])

    def test_real_executor_requests_b_and_preserves_none_arrays(self):
        for op, a in [("and", 1), ("or", 0)]:
            for b in [None, [[1], [], [2]], {"x": 1}]:
                with self.subTest(op=op, b=b):
                    VALUES["b"] = b
                    result = self.run_graph(self.graph("LiuxinyuBooleanOperator", op, a))
                    self.assertIs(result, b)
                    self.assertEqual(CALLS, ["a", "b"])

    def test_real_executor_unary_and_eager_bitwise(self):
        self.assertIs(self.run_graph(self.graph("LiuxinyuBooleanOperator", "not", 0)), True)
        self.assertEqual(CALLS, ["a"])
        self.assertEqual(self.run_graph(self.graph("LiuxinyuBitwiseOperator", "~", True)), -2)
        self.assertEqual(CALLS, ["a"])
        VALUES["b"] = False
        self.assertIs(self.run_graph(self.graph("LiuxinyuBitwiseOperator", "&", False)), False)
        self.assertCountEqual(CALLS, ["a", "b"])

    def test_compare_drives_native_switch(self):
        VALUES.update(a="综合", b="综合", selected="comprehensive.json")
        graph = {
            k: {"class_type": "OperatorTestSource", "inputs": {"key": k}}
            for k in ["a", "b", "selected", "explode"]
        }
        graph.update(
            compare={"class_type": "LiuxinyuCompare", "inputs": {"a": ["a", 0], "b": ["b", 0], "operation": "等于"}},
            switch={"class_type": "ComfySwitchNode", "inputs": {"switch": ["compare", 0],
                "on_true": ["selected", 0], "on_false": ["explode", 0]}},
            out={"class_type": "OperatorTestCapture", "inputs": {"value": ["switch", 0]}})
        self.assertEqual(self.run_graph(graph), "comprehensive.json")
        self.assertNotIn("explode", CALLS)
        graph['compare']['inputs']['operation'] = '=='
        self.assertEqual(self.run_graph(graph), 'comprehensive.json')

    def test_real_executor_identity(self):
        VALUES.update(a=[1, 2], b=[1, 2])
        graph = {
            "a": {"class_type": "OperatorTestSource", "inputs": {"key": "a"}},
            "b": {"class_type": "OperatorTestSource", "inputs": {"key": "b"}},
            "op": {"class_type": "LiuxinyuCompare", "inputs": {"a": ["a", 0], "b": ["a", 0], "operation": "同一对象"}},
            "out": {"class_type": "OperatorTestCapture", "inputs": {"value": ["op", 0]}},
        }
        self.assertIs(self.run_graph(graph), True)
        graph["op"]["inputs"]["b"] = ["b", 0]
        self.assertIs(self.run_graph(graph), False)

    def test_missing_binary_b_is_rejected(self):
        classes = [Boolean, Bitwise, OperatorTestSource, OperatorTestCapture]
        with patch.dict(nodes.NODE_CLASS_MAPPINGS, {c.define_schema().node_id: c for c in classes}):
            for kind, op in [("LiuxinyuBooleanOperator", "and"), ("LiuxinyuBitwiseOperator", "&")]:
                graph = self.graph(kind, op, 0)
                del graph["op"]["inputs"]["b"]
                valid = asyncio.run(execution.validate_prompt("missing-b", graph, None))
                self.assertFalse(valid[0])
                self.assertIn("需要连接 B", str(valid[3]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
