"""Run with ComfyUI's bundled Python; no server or external requests needed."""

import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import execution
import numpy as np
import torch

import image_info_node
from image_info_node import LiuxinyuImageInfo as ImageInfo


def stats(image):
    output = ImageInfo.execute(image)
    return tuple(output[index][0] for index in range(12))


class ImageInfoTests(unittest.TestCase):
    def test_known_rgb_colors_and_duplicate_pixels(self):
        image = torch.tensor([[[[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
                               [[0., 0., 0.], [1., 1., 1.], [1., 0., 0.]]]])
        self.assertEqual(stats(image), (3, 2, 5, 76.245, 255., 0., 255, 0, 255, 0, 255, 0))
        for color, brightness in [([1., 0., 0.], 76.245),
                                  ([0., 1., 0.], 149.685),
                                  ([0., 0., 1.], 29.07)]:
            with self.subTest(color=color):
                self.assertEqual(stats(torch.tensor([[color]]))[3:6], (brightness,) * 3)

    def test_even_median_and_grayscale(self):
        image = torch.tensor([[[[0.], [1.]]]])
        self.assertEqual(stats(image), (2, 1, 2, 127.5, 255., 0., 255, 0, 255, 0, 255, 0))

    def test_alpha_does_not_change_rgb_counts(self):
        image = torch.tensor([[[[1., 0., 0., 0.], [1., 0., 0., 1.]]]])
        self.assertEqual(stats(image), (2, 1, 1, 76.245, 76.245, 76.245, 255, 255, 0, 0, 0, 0))

    def test_quantization_clamping_and_input_unchanged(self):
        image = torch.tensor([[[[-0.1, 0.5, 1.1], [0., 128. / 255., 1.]]]], requires_grad=True)
        original = image.detach().clone()
        self.assertEqual(stats(image), (2, 1, 1, 104.206, 104.206, 104.206, 0, 0, 128, 128, 255, 255))
        self.assertTrue(torch.equal(image, original))

    def test_chunks_and_noncontiguous_tensor_match_independent_reference(self):
        rng = np.random.default_rng(123)
        pixels = rng.integers(0, 256, size=(7, 9, 3), dtype=np.uint8)
        image = torch.from_numpy(pixels.astype(np.float32) / 255.).transpose(0, 1)
        rgb = pixels.transpose(1, 0, 2).reshape(-1, 3).astype(np.float64)
        brightness = rgb @ np.array([0.299, 0.587, 0.114])
        expected = (7, 9, len(set(map(tuple, rgb))), np.median(brightness), brightness.max(), brightness.min(),
                    rgb[:, 0].max(), rgb[:, 0].min(), rgb[:, 1].max(), rgb[:, 1].min(),
                    rgb[:, 2].max(), rgb[:, 2].min())
        with patch.object(image_info_node, "_CHUNK_PIXELS", 16):
            np.testing.assert_allclose(stats(image), expected, rtol=0, atol=1e-10)

    def test_batches_and_execution_lists_preserve_image_order(self):
        batch = torch.stack([torch.zeros(2, 3, 3), torch.ones(2, 3, 3)])
        red = torch.tensor([[[[1., 0., 0.]]]])
        _, missing, v3_data = execution.get_input_data({}, ImageInfo, "info")
        self.assertFalse(missing)
        outputs, _, _, _ = asyncio.run(execution.get_output_data(
            "image-info-test", "info", ImageInfo, {"image": [batch, red]}, v3_data=v3_data))
        self.assertEqual(outputs, [
            [3, 3, 1], [2, 2, 1], [1, 1, 1],
            [0., 255., 76.245], [0., 255., 76.245], [0., 255., 76.245],
            [0, 255, 255], [0, 255, 255], [0, 255, 0], [0, 255, 0], [0, 255, 0], [0, 255, 0],
        ])
        for index, output in enumerate(outputs):
            expected_type = float if 3 <= index <= 5 else int
            self.assertTrue(all(type(value) is expected_type for value in output))

    def test_invalid_images_report_errors(self):
        for image in [None, torch.zeros(2, 2), torch.zeros(1, 2, 2, 2),
                      torch.zeros(0, 2, 2, 3), torch.zeros(1, 0, 2, 3),
                      torch.full((1, 1, 1, 3), float("nan")),
                      torch.full((1, 1, 1, 3), float("inf"))]:
            with self.subTest(image=image), self.assertRaises(ValueError):
                ImageInfo.execute(image)


if __name__ == "__main__":
    unittest.main()
