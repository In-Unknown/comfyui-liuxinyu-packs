"""Check arbitrary values and list mapping using ComfyUI's executor."""

import asyncio
from pathlib import Path
import sys
import unittest

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import execution
import torch
from execution_list_node import LiuxinyuRepeatAnyToExecutionList as Repeat
from packet_tasks import packet_columns


def run_node(values, counts):
    output, _, _, _ = asyncio.run(execution.get_output_data(
        "repeat-test", "repeat", Repeat, {"value": values, "count": counts}))
    return output[0]


class RepeatTests(unittest.TestCase):
    def test_arbitrary_values_preserve_type_and_identity(self):
        image = torch.zeros(3, 2, 4, 3)
        for value in ("文本", 7, 0.2, True, None, {"a": [1, 2]}, [1, 2],
                      image, {"samples": torch.zeros(2, 16, 4, 4)}, object()):
            with self.subTest(kind=type(value).__name__):
                output = run_node([value], [3])
                self.assertEqual(len(output), 3)
                self.assertTrue(all(item is value for item in output))

    def test_zero_and_one(self):
        self.assertEqual(run_node(["A"], [0]), [])
        self.assertEqual(run_node(["A"], [1]), ["A"])

    def test_execution_lists_repeat_each_item_in_order(self):
        self.assertEqual(run_node(["A", "B"], [2]), ["A", "A", "B", "B"])
        self.assertEqual(run_node(["A", "B"], [1, 3]), ["A", "B", "B", "B"])

    def test_array_values_remain_whole_packets(self):
        value = [1, 2]
        for count in (1, 3):
            output = run_node([value], [count])
            columns, packets = packet_columns({"value0": output}, execution_lists={"value0"})
            self.assertEqual(packets, count)
            self.assertTrue(all(item is value for item in columns[0]))

    def test_invalid_count(self):
        for count in (-1, 1.5, "2", True):
            with self.subTest(count=count), self.assertRaises(ValueError):
                Repeat.execute("A", count)


if __name__ == "__main__":
    unittest.main()
