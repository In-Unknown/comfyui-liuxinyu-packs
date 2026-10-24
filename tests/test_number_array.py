"""Run with ComfyUI's bundled Python to check types and executor boundaries."""

import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import execution
import nodes
import numpy as np
from comfy_api.latest import io
from number_node import LiuxinyuNumberArray as NumberArray, LiuxinyuNumberConvert


class ArrayReceiver(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="TestArrayReceiver", inputs=[io.Array.Input("array")],
                         outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, array):
        return io.NodeOutput(ui={"arrays": [array]})


class NumberArrayTests(unittest.TestCase):
    def test_numeric_promotion(self):
        for values, expected, kind in [
            ([2, -3, 9007199254740993], [2, -3, 9007199254740993], int),
            ([1.0, -0.5], [1.0, -0.5], float),
            ([2, 1.0, -3], [2.0, 1.0, -3.0], float),
            ([np.int64(4), np.int32(-2)], [4, -2], int),
            ([np.int64(4), np.float32(0.5)], [4.0, 0.5], float),
        ]:
            with self.subTest(values=values):
                output = NumberArray.execute(**{f"number{i}": v for i, v in enumerate(values)})[0]
                self.assertEqual(output, expected)
                self.assertTrue(all(type(value) is kind for value in output))

    def test_numeric_socket_order_and_disconnected_gaps(self):
        self.assertEqual(NumberArray.execute(number10=10, number2=2, number0=0)[0], [0, 2, 10])

    def test_empty_array(self):
        self.assertEqual(NumberArray.execute()[0], [])

    def test_reject_non_numeric_inputs(self):
        for value in (True, "3", None, [3], 1j):
            with self.subTest(value=value), self.assertRaises(ValueError):
                NumberArray.execute(number0=value)

    def test_more_than_100_inputs_remain_one_array_in_executor(self):
        values = {f"number{i}": i for i in reversed(range(150))}
        inputs, missing, v3_data = execution.get_input_data(values, NumberArray, "array")
        self.assertFalse(missing)
        outputs, _, _, _ = asyncio.run(execution.get_output_data(
            "array-test", "array", NumberArray, inputs, v3_data=v3_data))
        self.assertEqual(outputs, [[list(range(150))]])

    def test_linked_values_and_array_consumer(self):
        classes = {cls.define_schema().node_id: cls for cls in
                   (NumberArray, LiuxinyuNumberConvert, ArrayReceiver)}
        prompt = {
            "int": {"class_type": "LiuxinyuNumberConvert", "inputs": {"value": 7}},
            "float": {"class_type": "LiuxinyuNumberConvert", "inputs": {"value": 0.5}},
            "array": {"class_type": "LiuxinyuNumberArray", "inputs": {
                "number0": ["int", 1], "number101": ["float", 0]}},
            "out": {"class_type": "TestArrayReceiver", "inputs": {"array": ["array", 0]}},
        }
        with patch.dict(nodes.NODE_CLASS_MAPPINGS, classes):
            validation = asyncio.run(execution.validate_prompt("array-test", prompt, None))
            self.assertTrue(validation[0], validation)
            executor = execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *args: None),
                                                execution.CacheType.RAM_PRESSURE, {"ram": 0, "ram_inactive": 0})
            executor.execute(prompt, "array-test", execute_outputs=["out"])
            self.assertTrue(executor.success, executor.status_messages)
            arrays = executor.history_result["outputs"]["out"]["arrays"]
            self.assertEqual(arrays, [[7.0, 0.5]])
            self.assertTrue(all(type(value) is float for value in arrays[0]))


if __name__ == "__main__":
    unittest.main()
