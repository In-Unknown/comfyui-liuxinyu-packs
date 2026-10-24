"""Regression tests; run with ComfyUI's bundled Python (requires torch)."""

import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import execution
import torch
from PIL import Image
from batch_node import SaveSelectedFromBatch as Saver
from split_preview_nodes import LiuxinyuSplitLook as Look


class SaveSelectedTests(unittest.TestCase):
    def setUp(self):
        self.root = PACK.parents[1] / "temp" / ("test-save-selected-" + uuid.uuid4().hex)
        self.root.mkdir(parents=True)
        self.temp = self.root / "previews"
        self.dest = self.root / "saved"
        self.temp_patch = patch("folder_paths.get_temp_directory", return_value=str(self.temp))
        self.temp_patch.start()
        self.addCleanup(self.temp_patch.stop)
        self.image = torch.stack((torch.zeros(9, 7, 3), torch.ones(9, 7, 3)))

    def tearDown(self):
        for path in sorted(self.root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            path.rmdir() if path.is_dir() else path.unlink()
        self.root.rmdir()

    def test_manual_preview_needs_no_destination(self):
        for folder in ("", "   "):
            with self.subTest(folder=folder):
                ui = Saver().execute(self.image, folder, "image.png", "")["ui"]
                self.assertEqual(len(ui["images"]), 2)
                for meta in ui["images"]:
                    with Image.open(self.temp / meta["filename"]) as img:
                        self.assertEqual(img.size, (7, 9))
                self.assertFalse(self.dest.exists())

    def test_split_list_manual_selection_across_sessions_preserves_pixels(self):
        source = torch.linspace(0, 1, 23 * 7 * 3).reshape(1, 23, 7, 3)
        output, _, _, _ = asyncio.run(execution.get_output_data(
            "regression", "165", Look, {"image": [source], "block_height": [10]}))
        _, ui, _, _ = asyncio.run(execution.get_output_data(
            "regression", "170", Saver(), {
                "image": output[0], "folder": [""], "filename": ["image.png"], "selection": [""]}))
        self.assertEqual(len(ui["images"]), 3)
        self.assertEqual(len(set(ui["session_id"])), 3)
        files = [meta["filename"] for meta in ui["images"]]
        # Global index 2 belongs to a different execution session than index 0.
        result = Saver.save_selected_from_temp("", [2, 0], str(self.dest), "image.png", files)
        self.assertEqual(result["skipped"], [])
        self.assertEqual([Path(p).name for p in result["saved"]], ["image_1.png", "image_2.png"])
        for index, saved in zip((2, 0), result["saved"]):
            with Image.open(saved) as actual, Image.open(self.temp / files[index]) as expected:
                self.assertEqual(actual.size, (52, 3 if index == 2 else 10))
                self.assertEqual(actual.tobytes(), expected.tobytes())
        again = Saver.save_selected_from_temp("", [1], str(self.dest), "image.png", files)
        self.assertEqual(Path(again["saved"][0]).name, "image_3.png")

    def test_auto_save_requires_destination_before_writing_previews(self):
        for folder, message in (("", "选择保存文件夹"), ("   ", "选择保存文件夹"),
                                ("relative", "绝对路径")):
            with self.subTest(folder=folder), patch.object(Image.Image, "save") as save:
                with self.assertRaisesRegex(ValueError, message):
                    Saver().execute(self.image, folder, "image.png", "0")
                save.assert_not_called()
        self.assertFalse(self.temp.exists())

    def test_manual_save_reports_missing_or_relative_destination(self):
        for folder, message in (("", "选择保存文件夹"), ("   ", "选择保存文件夹"),
                                ("relative", "绝对路径")):
            with self.subTest(folder=folder):
                result = Saver.save_selected_from_temp("a" * 32, [0], folder, "image.png")
                self.assertIn(message, result["error"])
        self.assertFalse(self.dest.exists())

    def test_auto_save_selection_order_and_appending_are_preserved(self):
        for _ in range(2):
            Saver().execute(self.image, str(self.dest), "image.PNG", "1,0,1,999")
        files = sorted(self.dest.iterdir())
        self.assertEqual([p.name for p in files], [f"image_{i}.PNG" for i in range(1, 5)])
        for index, path in enumerate(files):
            with Image.open(path) as img:
                self.assertEqual(img.getpixel((0, 0)), (255, 255, 255) if index % 2 == 0 else (0, 0, 0))

    def test_preview_marks_only_actual_auto_saved_images(self):
        ui = Saver().execute(self.image, str(self.dest), "image.png", "1,1,999,-1,bad")["ui"]
        self.assertEqual([meta["selected"] for meta in ui["images"]], [False, True])
        self.assertEqual(len(list(self.dest.iterdir())), 1)
        ui = Saver().execute(self.image, "", "image.png", "")["ui"]
        self.assertEqual([meta["selected"] for meta in ui["images"]], [False, False])

    def test_mapped_and_cached_previews_keep_each_batch_selection(self):
        inputs = {"image": [self.image, self.image[:1]], "folder": [str(self.dest)],
                  "filename": ["image.png"], "selection": ["1", "0"]}

        def run():
            return asyncio.run(execution.get_output_data("selection", "170", Saver(), inputs))[1]

        first = run()
        self.assertEqual([meta["selected"] for meta in first["images"]], [False, True, True])
        self.assertEqual(run(), first)
        self.assertEqual(len(list(self.dest.iterdir())), 2)
        inputs["selection"] = ["0", ""]
        changed = run()
        self.assertEqual([meta["selected"] for meta in changed["images"]], [True, False, False])

    def test_both_save_paths_still_validate_filenames(self):
        for name in ("", "../escape.png", "sub/image.png", "image", "image.txt"):
            with self.subTest(filename=name):
                with self.assertRaises(ValueError):
                    Saver().execute(self.image, str(self.dest), name, "0")
                result = Saver.save_selected_from_temp("a" * 32, [0], str(self.dest), name)
                self.assertIn("error", result)
        self.assertFalse(self.temp.exists())
        self.assertFalse(self.dest.exists())

    def test_missing_batch_dimension_is_rejected_before_writing(self):
        with patch.object(Image.Image, "save") as save:
            with self.assertRaisesRegex(ValueError, "IMAGE"):
                Saver().execute(self.image[0], str(self.dest), "image.png", "")
            save.assert_not_called()

    def test_gray_and_rgba_preview_and_jpeg_save(self):
        for channels in (1, 4):
            with self.subTest(channels=channels):
                image = torch.ones(1, 9, 7, channels)
                ui = Saver().execute(image, "", "image.jpg", "")["ui"]
                result = Saver.save_selected_from_temp(ui["session_id"][0], [0], str(self.dest), "image.jpg")
                with Image.open(result["saved"][0]) as img:
                    self.assertEqual(img.size, (7, 9))
                    self.assertEqual(img.mode, "RGB")


if __name__ == "__main__":
    unittest.main()
