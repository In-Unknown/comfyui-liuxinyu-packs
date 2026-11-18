"""Dictionary-array ordering and native execution-list mapping; no API calls."""

import asyncio
import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]

import execution
from array_sort_node import LiuxinyuSortDictionaryArray as Sort


class ArraySortTests(unittest.TestCase):
    def test_stable_numeric_order_without_mutation(self):
        data = [{"n": 2, "payload": []}, {"n": 1.5}, {"n": 2}]
        ascending = Sort.execute(data, "n", "升序").result[0]
        descending = Sort.execute(data, "n", "降序").result[0]
        self.assertEqual(ascending, [data[1], data[0], data[2]])
        self.assertEqual(descending, [data[0], data[2], data[1]])
        self.assertEqual([x["n"] for x in data], [2, 1.5, 2])
        self.assertIsNot(ascending, data)
        self.assertIs(ascending[1], data[0])
        self.assertIs(ascending[1]["payload"], data[0]["payload"])

    def test_string_and_literal_key(self):
        data = [{"a.b": "2"}, {"a.b": "10"}]
        self.assertEqual(Sort.execute(data, "a.b", "升序").result[0], data[::-1])
        self.assertEqual(Sort.execute([{"": 1}], "", "升序").result[0], [{"": 1}])

    def test_random_keeps_records_and_ignores_key(self):
        data = [{"a": 1}, {"b": 2}, {"a": 1}]
        with patch("array_sort_node.random.shuffle", side_effect=lambda items: items.reverse()) as shuffle:
            result = Sort.execute(data, "missing", "随机").result[0]
        shuffle.assert_called_once()
        self.assertEqual(result, data[::-1])
        self.assertIs(result[0], data[-1])
        self.assertEqual(data[0], {"a": 1})

    def test_invalid_inputs_and_values(self):
        for value in [{"n": 1}, '[{"n":1}]', ({"n": 1},), None, 1]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "完整数组"):
                Sort.execute(value, "n", "升序")
        for method in ["随机", "升序", "降序"]:
            with self.assertRaisesRegex(ValueError, "第 2 项不是字典"):
                Sort.execute([{}, 1], "n", method)
        with self.assertRaisesRegex(ValueError, "第 2 项缺少键"):
            Sort.execute([{"n": 1}, {}], "n", "升序")
        for value in [None, {}, [], float("nan")]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                Sort.execute([{"n": value}], "n", "降序")
        with self.assertRaisesRegex(ValueError, "无法互相比较"):
            Sort.execute([{"n": 1}, {"n": "2"}], "n", "升序")
        with self.assertRaises(ValueError):
            Sort.execute([], "n", "unknown")

    def test_empty_and_single_array(self):
        for method in ["随机", "升序", "降序"]:
            self.assertEqual(Sort.execute([], "n", method).result, ([],))
            self.assertEqual(Sort.execute([{"n": 0}], "n", method).result, ([{"n": 0}],))

    def test_schema_and_cache(self):
        info = Sort.GET_NODE_INFO_V1()
        self.assertEqual(info["input"]["required"]["array"][0], "ARRAY")
        self.assertEqual(info["output"], ["ARRAY"])
        self.assertEqual(info["output_is_list"], [False])
        self.assertFalse(Sort.define_schema().is_input_list)
        self.assertTrue(math.isnan(Sort.fingerprint_inputs("随机")))
        self.assertEqual(Sort.fingerprint_inputs("升序"), Sort.fingerprint_inputs("升序"))

    def test_native_execution_list_maps_each_array(self):
        arrays = [[{"n": 3}, {"n": 1}], [{"n": 4}, {"n": 2}]]
        results = asyncio.run(execution._async_map_node_over_list(
            "array-sort-test", "sort", Sort,
            {"array": arrays, "key": ["n"], "method": ["升序"]}, Sort.FUNCTION))
        self.assertEqual([r.result[0] for r in results],
                         [[{"n": 1}, {"n": 3}], [{"n": 2}, {"n": 4}]])
        with self.assertRaisesRegex(ValueError, "完整数组"):
            asyncio.run(execution._async_map_node_over_list(
                "array-sort-test", "sort", Sort,
                {"array": [{"n": 1}, {"n": 2}], "key": ["n"], "method": ["升序"]}, Sort.FUNCTION))


if __name__ == "__main__":
    unittest.main()
