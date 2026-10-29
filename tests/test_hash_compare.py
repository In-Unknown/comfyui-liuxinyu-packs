"""Exact typed-content equality, including collisions and whole execution lists."""

from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import numpy as np
import torch
import hash_compare_node as compare


class HashEqualTests(unittest.TestCase):
    def test_base_values(self):
        for value in (None, True, 1, 2**200, 1.1, 2+3j, "中文\0", b"data", bytearray(b"data")):
            with self.subTest(value=value):
                self.assertTrue(compare.content_equal(value, value))
        for left, right in ((1, True), (1, 1.0), ("1", 1), (b"a", bytearray(b"a")), ("a", "b")):
            self.assertFalse(compare.content_equal(left, right))

    def test_containers_and_order(self):
        self.assertTrue(compare.content_equal({"x": [1, 2], "y": None}, {"y": None, "x": [1, 2]}))
        self.assertTrue(compare.content_equal({"x", 2}, {2, "x"}))
        self.assertFalse(compare.content_equal([1, 2], [2, 1]))
        self.assertFalse(compare.content_equal([1, 2], (1, 2)))
        self.assertFalse(compare.content_equal({1: "a"}, {True: "a"}))
        self.assertFalse(compare.content_equal(["ab", "c"], ["a", "bc"]))

    def test_float_bits(self):
        self.assertFalse(compare.content_equal(0.0, -0.0))
        nan = struct.unpack("!d", bytes.fromhex("7ff8000000000001"))[0]
        other_nan = struct.unpack("!d", bytes.fromhex("7ff8000000000002"))[0]
        self.assertTrue(compare.content_equal(nan, nan))
        self.assertFalse(compare.content_equal(nan, other_nan))

    def test_image_pixels_and_dtype(self):
        value = torch.zeros(2, 3, 4, 3)
        self.assertTrue(compare.content_equal(value, value.clone()))
        other = value.clone()
        other[1, 2, 3, 2] = 1e-7
        self.assertFalse(compare.content_equal(value, other))
        self.assertFalse(compare.content_equal(value, value.double()))
        self.assertFalse(compare.content_equal(value, value.reshape(1, 6, 4, 3)))

    def test_scalar_empty_noncontiguous_and_bfloat(self):
        for value in (torch.tensor(2.), torch.zeros(0, 3), torch.arange(12).reshape(3, 4).T,
                      torch.ones(2, 3, dtype=torch.bfloat16), torch.tensor([complex(1, 2)]).conj()):
            self.assertTrue(compare.content_equal(value, value.clone().contiguous()))

    def test_nested_latents(self):
        value = {"samples": torch.zeros(1, 4, 3, 3), "meta": {"steps": [1, 2]}}
        other = {"meta": {"steps": [1, 2]}, "samples": value["samples"].clone()}
        self.assertTrue(compare.content_equal(value, other))
        other["samples"][0, 0, 0, 0] = 1
        self.assertFalse(compare.content_equal(value, other))

    def test_numpy(self):
        for value in (np.arange(12).reshape(3, 4).T, np.array(2.), np.zeros((0, 3)), np.float32(1),
                      np.array([{"x": 1}, "a"], dtype=object), np.array([(1, 2.)], dtype=[("a", "i4"), ("b", "f4")])):
            self.assertTrue(compare.content_equal(value, value.copy()))
        self.assertFalse(compare.content_equal(np.array([1], dtype="i4"), np.array([1], dtype="i8")))
        self.assertFalse(compare.content_equal(np.array([1]), torch.tensor([1])))

    def test_mutated_input_is_rechecked(self):
        a, b = torch.zeros(2), torch.zeros(2)
        self.assertTrue(compare.content_equal(a, b))
        b[0] = 1
        self.assertFalse(compare.content_equal(a, b))

    def test_forced_digest_collision_is_not_equal(self):
        with patch.object(compare, "digests", return_value=(b"same", b"same")):
            self.assertFalse(compare.content_equal([1, 2], [1, 3]))
            self.assertFalse(compare.content_equal([], [1]))

    def test_streamed_multiple_blocks(self):
        with patch.object(compare, "BLOCK_SIZE", 7):
            self.assertTrue(compare.content_equal(torch.arange(50), torch.arange(50)))
            self.assertTrue(compare.content_equal(b"123456789" * 20, b"123456789" * 20))

    def test_cycles_and_opaque_objects_fail_explicitly(self):
        cyclic = []
        cyclic.append(cyclic)
        with self.assertRaises(ValueError):
            compare.content_equal(cyclic, cyclic)
        with self.assertRaises(TypeError):
            compare.content_equal(object(), object())

    def test_whole_execution_lists(self):
        self.assertTrue(compare.LiuxinyuHashEqual.execute([1, 2], [1, 2]).result[0])
        self.assertFalse(compare.LiuxinyuHashEqual.execute([1], [1, 1]).result[0])
        self.assertTrue(compare.LiuxinyuHashEqual.execute([], []).result[0])
        self.assertFalse(compare.LiuxinyuHashEqual.execute([[1, 2]], [1, 2]).result[0])


if __name__ == "__main__":
    unittest.main()
