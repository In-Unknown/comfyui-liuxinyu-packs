"""Same-type array contract, including native validation and list execution."""
import asyncio
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
from any_array_node import LiuxinyuAnyArray as Array


class Source(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="AnyArraySource", inputs=[], outputs=[
            io.Int.Output(is_output_list=True), io.Int.Output(), io.Float.Output()])

    @classmethod
    def execute(cls):
        return io.NodeOutput([1, 2], 9, 0.5)


class Capture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="AnyArrayCapture", inputs=[io.Array.Input("value")],
                         outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(ui={"arrays": [value]})


class AnyArrayTests(unittest.TestCase):
    def test_schema_and_empty(self):
        schema = Array.GET_NODE_INFO_V1()
        self.assertEqual(schema["output"], ["ARRAY"])
        self.assertEqual(schema["output_is_list"], [False])
        self.assertEqual(schema["input"]["optional"]["value0"][0], "*")
        self.assertEqual(Array.execute().result, ([],))

    def test_preserve_types_nested_values_and_references(self):
        for values in ([1, 2], [1.0, 2.0], [False, True], ["", "text"],
                       [None, None], [[1, "x"], [False]], [{"a": 1}, {"b": 2}],
                       [object(), object()]):
            result = Array.execute(value0=values[0], value1=values[1]).result[0]
            for actual, expected in zip(result, values):
                self.assertIs(actual, expected)

    def test_reject_mixed_runtime_values(self):
        for a, b in ((1, 1.0), (1, True), (None, ""), ({}, []), ("1", 1)):
            with self.subTest(a=a, b=b), self.assertRaisesRegex(ValueError, "必须同类型"):
                Array.execute(value0=a, value1=b)

    def test_declared_types_and_union_intersection(self):
        for types in (("IMAGE", "MASK"), ("INT", "FLOAT"), ("FLOAT,INT", "INT", "FLOAT")):
            self.assertIsInstance(Array._validate_member_types({f"value{i}": t for i, t in enumerate(types)}), str)
        self.assertIs(Array._validate_member_types({"value0": "*", "value1": "DICT"}), True)
        self.assertIs(Array._validate_member_types({"value0": "FLOAT,INT", "value1": "INT"}), True)

    def test_numeric_order_gaps_and_more_than_100(self):
        self.assertEqual(Array.execute(value10="c", value0="a", value2="b").result[0], ["a", "b", "c"])
        values = {f"value{i}": i for i in reversed(range(150))}
        inputs, missing, extra = execution.get_input_data(values, Array, "array")
        self.assertFalse(missing)
        result = asyncio.run(execution.get_output_data("test", "array", Array, inputs, v3_data=extra))[0]
        self.assertEqual(result, [[list(range(150))]])

    def test_executor_maps_lists_and_validation_rejects_mixed_links(self):
        prompt = {
            "source": {"class_type": "AnyArraySource", "inputs": {}},
            "array": {"class_type": "LiuxinyuAnyArray", "inputs": {"value0": ["source", 0], "value1": ["source", 1]}},
            "out": {"class_type": "AnyArrayCapture", "inputs": {"value": ["array", 0]}},
        }
        mapping = {cls.define_schema().node_id: cls for cls in (Array, Source, Capture)}
        with patch.dict(nodes.NODE_CLASS_MAPPINGS, mapping), patch("logging.error"):
            valid = asyncio.run(execution.validate_prompt("array", prompt, None))
            self.assertTrue(valid[0], valid)
            runner = execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *a: None),
                                             execution.CacheType.RAM_PRESSURE, {"ram": 0, "ram_inactive": 0})
            runner.execute(prompt, "array", execute_outputs=["out"])
            self.assertTrue(runner.success, runner.status_messages)
            self.assertEqual(runner.history_result["outputs"]["out"]["arrays"], [[1, 9], [2, 9]])
            prompt["array"]["inputs"]["value1"] = ["source", 2]
            runner.execute(prompt, "mixed", execute_outputs=["out"])
            self.assertFalse(runner.success)
            self.assertIn("所有数组成员必须同类型", str(runner.status_messages))


if __name__ == "__main__":
    unittest.main()
