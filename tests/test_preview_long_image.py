"""Exercise real PNG encoding using ComfyUI's Python environment."""

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import numpy as np
from PIL import Image, ImageChops, ImageDraw
import torch

from preview_long_image_node import LiuxinyuPreviewLongImage as Preview, save_display_previews


class LongPreviewTests(unittest.TestCase):
    def test_tiles_cover_source_exactly_and_thumbnails_follow_direction(self):
        for size in ((257, 5003), (5003, 257), (790, 4000)):
            for reverse in (False, True):
                with self.subTest(size=size, reverse=reverse), tempfile.TemporaryDirectory() as temp:
                    source = Image.new("RGBA", size, (12, 34, 56, 128))
                    draw = ImageDraw.Draw(source)
                    draw.rectangle((0, 0, 256, 256), fill=(200, 10, 20, 255))
                    draw.rectangle((size[0] - 257, size[1] - 257, size[0], size[1]), fill=(10, 200, 20, 255))
                    original = Path(temp) / "original.png"
                    source.save(original)
                    with patch("folder_paths.get_temp_directory", return_value=temp):
                        display = save_display_previews(source, "test", original.name,
                                                        "从右向左" if reverse else "从左向右",
                                                        "从下到上" if reverse else "从上到下")
                    full = display["levels"][0]
                    reconstructed = Image.new("RGBA", size)
                    for row, y in enumerate(range(0, size[1], full["tile_size"])):
                        for col, x in enumerate(range(0, size[0], full["tile_size"])):
                            with Image.open(Path(temp) / f'{full["prefix"]}{row}_{col}.png') as tile:
                                self.assertLessEqual(max(tile.size), 1024)
                                reconstructed.paste(tile, (x, y))
                    self.assertIsNone(ImageChops.difference(source, reconstructed).getbbox(alpha_only=False))
                    overview = display["levels"][-1]
                    self.assertLessEqual(max(overview["width"], overview["height"]), 1024)
                    crop_size = (min(size[0], round(size[1] * 16 / 9)), min(size[1], round(size[0] * 16 / 9)))
                    for thumb in display["thumbnails"]:
                        with Image.open(Path(temp) / thumb["filename"]) as image:
                            self.assertLessEqual(max(image.size), max(crop_size))
                            point = (image.width - 1, image.height - 1) if reverse else (0, 0)
                            self.assertEqual(image.getpixel(point), (10, 200, 20, 255) if reverse else (200, 10, 20, 255))
                    with Image.open(Path(temp) / display["thumbnails"][-1]["filename"]) as native:
                        self.assertEqual(native.size, crop_size)
                        left, top = (size[0] - crop_size[0], size[1] - crop_size[1]) if reverse else (0, 0)
                        crop = source.crop((left, top, left + crop_size[0], top + crop_size[1]))
                        self.assertEqual(native.tobytes(), crop.tobytes())
                    with Image.open(original) as image:
                        self.assertIsNone(ImageChops.difference(source, image).getbbox(alpha_only=False))

    def test_long_previews_preserve_dimensions_and_pixels(self):
        # Cover the removed 16384 cap and images that JPEG cannot encode.
        for width, height in [(19, 36153), (65536, 3)]:
            with self.subTest(size=(width, height)), tempfile.TemporaryDirectory() as temp:
                pixels = np.arange(width * height * 3, dtype=np.uint8).reshape(height, width, 3)
                tensor = torch.from_numpy(pixels).float().div_(255).unsqueeze(0)
                with patch("folder_paths.get_temp_directory", return_value=temp):
                    result = Preview.execute(tensor, "从左向右", "从上到下")
                self.assertNotIn("text", result.ui)
                meta = result.ui["images"][0]
                self.assertEqual(meta["preview_size"], [width, height])
                with Image.open(Path(temp) / meta["filename"]) as saved:
                    self.assertEqual(saved.format, "PNG")
                    self.assertEqual(saved.size, (width, height))
                    np.testing.assert_array_equal(np.array(saved), pixels)

    def test_alpha_and_grayscale_survive_preview_encoding(self):
        for channels, mode in [(1, "L"), (4, "RGBA")]:
            with self.subTest(channels=channels), tempfile.TemporaryDirectory() as temp:
                pixels = np.arange(7 * 11 * channels, dtype=np.uint8).reshape(7, 11, channels)
                tensor = torch.from_numpy(pixels).float().div_(255).unsqueeze(0)
                with patch("folder_paths.get_temp_directory", return_value=temp):
                    result = Preview.execute(tensor, "从右向左", "从下到上")
                with Image.open(Path(temp) / result.ui["images"][0]["filename"]) as saved:
                    self.assertEqual(saved.mode, mode)
                    np.testing.assert_array_equal(np.array(saved), pixels[..., 0] if channels == 1 else pixels)


if __name__ == "__main__":
    unittest.main()
