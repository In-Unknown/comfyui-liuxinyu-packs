"""Closed index ranges and native array execution-list semantics."""

import asyncio
from pathlib import Path
import sys
import unittest

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]

import execution
from array_range_node import LiuxinyuArrayRange as Extract


class ArrayRangeTests(unittest.TestCase):
    def test_closed_interval_single_and_whole(self):
        data = [10, 20, 30, 40]
        self.assertEqual(Extract.execute(data, 1, 2).result, ([20, 30],))
        self.assertEqual(Extract.execute(data, 2, 2).result, ([30],))
        whole = Extract.execute(data, 0, 3).result[0]
        self.assertEqual(whole, data)
        self.assertIsNot(whole, data)

    def test_preserves_nested_elements_and_input(self):
        item = {"data": [1, 2]}
        data = [0, item, [3], None, item]
        result = Extract.execute(data, 1, 4).result[0]
        self.assertEqual(result, [item, [3], None, item])
        self.assertIs(result[0], item)
        self.assertIs(result[1], data[2])
        self.assertIs(result[3], item)
        self.assertEqual(data, [0, item, [3], None, item])

    def test_invalid_types(self):
        for value in ['[1,2]', (1, 2), {}, None, 1]:
            with self.subTest(array=value), self.assertRaisesRegex(ValueError, "完整数组"):
                Extract.execute(value, 0, 0)
        for value in [True, 1.0, "1", None]:
            for lo, hi, name in [(value, 1, "min"), (0, value, "max")]:
                with self.subTest(min=lo, max=hi), self.assertRaisesRegex(ValueError, name + " 必须是整数"):
                    Extract.execute([0, 1], lo, hi)

    def test_empty_out_of_bounds_and_reversed(self):
        for data, lo, hi, message in [
            ([], 0, 0, "min 下标 0 超出范围，数组共 0 个元素"),
            ([0, 1], -1, 1, "min 下标 -1"),
            ([0, 1], 0, -1, "max 下标 -1"),
            ([0, 1], 2, 2, "min 下标 2"),
            ([0, 1], 0, 2, "max 下标 2"),
            ([0, 1], 1, 0, "不能大于"),
        ]:
            with self.subTest(min=lo, max=hi), self.assertRaisesRegex(ValueError, message):
                Extract.execute(data, lo, hi)

    def test_schema_and_native_mapping(self):
        info = Extract.GET_NODE_INFO_V1()
        self.assertEqual(info["input"]["required"]["array"][0], "ARRAY")
        for name in ["min", "max"]:
            self.assertEqual(info["input"]["required"][name][0], "INT")
            self.assertEqual(info["input"]["required"][name][1]["default"], 0)
        self.assertEqual(info["output"], ["ARRAY"])
        self.assertEqual(info["output_is_list"], [False])
        self.assertFalse(Extract.define_schema().is_input_list)
        results = asyncio.run(execution._async_map_node_over_list(
            "array-range-test", "range", Extract,
            {"array": [[0, 1, 2], [3, 4, 5]], "min": [1], "max": [2]}, Extract.FUNCTION))
        self.assertEqual([result.result[0] for result in results], [[1, 2], [4, 5]])


if __name__ == "__main__":
    unittest.main()
