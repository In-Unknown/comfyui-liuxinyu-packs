"""Array chunks stay nested and preserve each input execution item."""

import asyncio
from pathlib import Path
import sys
import unittest

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]

import execution
from array_chunk_node import LiuxinyuArrayChunk as Chunk


class ArrayChunkTests(unittest.TestCase):
    def test_chunks_and_boundaries(self):
        for data, size, expected in [
            (list(range(1, 11)), 3, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]),
            ([1, 2, 3, 4], 2, [[1, 2], [3, 4]]),
            ([1, 2], 5, [[1, 2]]),
            ([1, 2], 1, [[1], [2]]),
            ([], 3, []),
        ]:
            with self.subTest(data=data, size=size):
                self.assertEqual(Chunk.execute(data, size).result, (expected,))

    def test_preserves_nested_elements_without_mutation(self):
        nested = [1, 2]
        item = {"a": 3}
        data = [nested, item, None, item]
        result = Chunk.execute(data, 3).result[0]
        self.assertEqual(result, [[nested, item, None], [item]])
        self.assertIs(result[0][0], nested)
        self.assertIs(result[0][1], item)
        self.assertIs(result[1][0], item)
        result[0].append(5)
        self.assertEqual(data, [nested, item, None, item])
        self.assertIsNot(Chunk.execute(data, 10).result[0][0], data)

    def test_invalid_inputs(self):
        for value in ['[1,2]', (1, 2), {}, None, 1]:
            with self.subTest(array=value), self.assertRaisesRegex(ValueError, "完整数组"):
                Chunk.execute(value, 3)
        for value in [True, 3.0, "3", None]:
            with self.subTest(size=value), self.assertRaisesRegex(ValueError, "正整数"):
                Chunk.execute([1], value)
        for data in [[], [1, 2]]:
            for size in [0, -1]:
                with self.subTest(data=data, size=size), self.assertRaisesRegex(ValueError, "必须大于 0"):
                    Chunk.execute(data, size)

    def test_schema_and_native_mapping(self):
        info = Chunk.GET_NODE_INFO_V1()
        self.assertEqual(info["input"]["required"]["array"][0], "ARRAY")
        self.assertEqual(info["input"]["required"]["chunk_size"][0], "INT")
        self.assertEqual(info["input"]["required"]["chunk_size"][1]["default"], 3)
        self.assertEqual(info["output"], ["ARRAY"])
        self.assertEqual(info["output_is_list"], [False])
        self.assertFalse(Chunk.define_schema().is_input_list)
        results = asyncio.run(execution._async_map_node_over_list(
            "array-chunk-test", "chunk", Chunk,
            {"array": [[1, 2, 3], [4, 5]], "chunk_size": [2]}, Chunk.FUNCTION))
        self.assertEqual([result.result[0] for result in results], [[[1, 2], [3]], [[4, 5]]])


if __name__ == "__main__":
    unittest.main()
