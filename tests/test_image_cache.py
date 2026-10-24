"""Exercise the actual ComfyUI executor and RAM cache, plus preview transactions."""

import asyncio
import copy
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

from aiohttp import web
import execution
import nodes
import torch
from PIL import Image
from server import PromptServer
from comfy_execution.utils import CurrentNodeContext
from comfy_api.latest import io

PromptServer.instance = SimpleNamespace(routes=web.RouteTableDef())
from image_path_nodes import LoadImageBatchFromPath, LoadImageFromPath, LoadPath, MatchPath, SaveImageToAbsolutePath, _path_preview, _cleanup_path_previews
from batch_node import SaveSelectedFromBatch
from preview_long_image_node import LiuxinyuPreviewLongImage
from stitch_batch_node import LiuxinyuStitchImageBatchList
from split_preview_nodes import LiuxinyuSplitLook
from string_node import LiuxinyuLoadTextFile
from liuxinyu_cache import clear_previews, file_changes
from ratio_paint_node import LiuxinyuRatioPaint, save_editor_bundle


class StringSource(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="CacheTestString", inputs=[io.String.Input("text")], outputs=[io.String.Output()])

    @classmethod
    def execute(cls, text):
        return io.NodeOutput(text)


def unexpected_execute(cls, **kwargs):
    raise AssertionError("cached node executed again")


class ImageCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=PACK.parents[1] / "temp", prefix="test-image-cache-")
        self.root = Path(self.directory.name)
        self.temp = self.root / "previews"
        self.source = self.root / "source.png"
        Image.new("RGB", (7, 11), (40, 80, 120)).save(self.source, compress_level=0)
        self.temp_patch = patch("folder_paths.get_temp_directory", return_value=str(self.temp))
        self.temp_patch.start()
        clear_previews()
        file_changes.nodes.clear()
        classes = [LoadImageBatchFromPath, LoadImageFromPath, LoadPath, MatchPath, SaveSelectedFromBatch,
                   LiuxinyuPreviewLongImage, LiuxinyuStitchImageBatchList, LiuxinyuSplitLook, LiuxinyuLoadTextFile]
        self.node_patch = patch.dict(nodes.NODE_CLASS_MAPPINGS, {cls.__name__: cls for cls in classes} | {"CacheTestString": StringSource})
        self.node_patch.start()
        server = SimpleNamespace(client_id=None, send_sync=lambda *args: None)
        self.executor = execution.PromptExecutor(server, execution.CacheType.RAM_PRESSURE,
                                                 {"ram": 0, "ram_inactive": 0})

    def tearDown(self):
        clear_previews()
        _cleanup_path_previews()
        file_changes.nodes.clear()
        self.node_patch.stop()
        self.temp_patch.stop()
        self.directory.cleanup()

    def run_prompt(self, prompt, outputs=("out",)):
        self.executor.execute(copy.deepcopy(prompt), uuid.uuid4().hex, execute_outputs=list(outputs))
        errors = [data for name, data in self.executor.status_messages if name == "execution_error"]
        self.assertFalse(errors, errors)
        self.assertTrue(self.executor.success)
        return self.executor.history_result["outputs"]

    def pipeline(self, linked=True):
        prompt = {
            "source": {"class_type": "CacheTestString", "inputs": {"text": str(self.source)}},
            "load": {"class_type": "LoadImageBatchFromPath", "inputs": {
                "path": ["source", 0] if linked else str(self.source), "target_width": 7, "target_height": 0}},
            "stitch": {"class_type": "LiuxinyuStitchImageBatchList", "inputs": {
                "images": ["load", 0], "direction": "从上到下", "target_format": "PNG"}},
            "split": {"class_type": "LiuxinyuSplitLook", "inputs": {"image": ["stitch", 0], "block_height": 7}},
            "out": {"class_type": "LiuxinyuPreviewLongImage", "inputs": {
                "image": ["split", 0], "scroll_direction": "从左向右", "tall_scroll_direction": "从上到下"}},
        }
        if not linked:
            del prompt["source"]
        return prompt

    def paths(self, ui):
        return [self.temp / item["filename"] for item in ui["images"]]

    def test_native_cache_reuses_loader_stitch_split_for_literal_and_linked_paths(self):
        for linked in (False, True):
            with self.subTest(linked=linked):
                prompt = self.pipeline(linked)
                first = self.run_prompt(prompt)["out"]
                with patch.object(LoadImageBatchFromPath, "execute", side_effect=AssertionError("loader reran")), \
                     patch.object(LiuxinyuStitchImageBatchList, "execute", new=classmethod(unexpected_execute)), \
                     patch.object(LiuxinyuSplitLook, "execute", new=classmethod(unexpected_execute)), \
                     patch.object(Image.Image, "save", side_effect=AssertionError("preview was encoded again")):
                    second = self.run_prompt(prompt)["out"]
                self.assertEqual(first, second)
                self.assertTrue(all(path.is_file() for path in self.paths(second)))

    def test_same_name_same_size_and_timestamp_overwrite_invalidates(self):
        prompt = self.pipeline()
        first = self.run_prompt(prompt)["out"]
        before = self.source.stat()
        Image.new("RGB", (7, 11), (230, 10, 20)).save(self.source, compress_level=0)
        import os
        os.utime(self.source, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(self.source.stat().st_size, before.st_size)
        second = self.run_prompt(prompt)["out"]
        self.assertNotEqual(first["images"], second["images"])
        self.assertTrue(all(not path.exists() for path in self.paths(first)))
        with Image.open(self.paths(second)[0]) as image:
            self.assertEqual(image.getpixel((image.width - 1, 0)), (230, 10, 20))

    def test_settings_and_enums_invalidate_but_A_B_A_has_no_broken_files(self):
        prompt = self.pipeline()
        first = self.run_prompt(prompt)["out"]
        prompt["load"]["inputs"]["target_width"] = 9
        second = self.run_prompt(prompt)["out"]
        self.assertTrue(all(not path.exists() for path in self.paths(first)))
        prompt["load"]["inputs"]["target_width"] = 7
        third = self.run_prompt(prompt)["out"]
        self.assertTrue(all(path.is_file() for path in self.paths(third)))
        self.assertTrue(all(not path.exists() for path in self.paths(second)))
        prompt["out"]["inputs"]["scroll_direction"] = "从右向左"
        fourth = self.run_prompt(prompt)["out"]
        self.assertEqual(fourth["scroll_direction"], ["从右向左"] * len(fourth["images"]))
        self.assertNotEqual(third["images"], fourth["images"])

    def test_directory_add_remove_detected_behind_link(self):
        directory = self.root / "inputs"
        directory.mkdir()
        Image.new("RGB", (7, 11)).save(directory / "1.png")
        prompt = self.pipeline()
        prompt["source"]["inputs"]["text"] = str(directory)
        first = self.run_prompt(prompt)["out"]
        Image.new("RGB", (7, 11), "white").save(directory / "2.png")
        second = self.run_prompt(prompt)["out"]
        self.assertGreater(len(second["images"]), len(first["images"]))
        (directory / "2.png").unlink()
        third = self.run_prompt(prompt)["out"]
        self.assertEqual(len(first["images"]), len(third["images"]))
        self.assertTrue(all(not path.exists() for path in self.paths(second)))

    def test_revisited_linked_source_still_detects_changes(self):
        other = self.root / "other.png"
        Image.new("RGB", (7, 11), "white").save(other)
        prompt = self.pipeline()
        self.run_prompt(prompt)
        prompt["source"]["inputs"]["text"] = str(other)
        self.run_prompt(prompt)
        prompt["source"]["inputs"]["text"] = str(self.source)
        first = self.run_prompt(prompt)["out"]
        Image.new("RGB", (7, 11), "red").save(self.source)
        second = self.run_prompt(prompt)["out"]
        self.assertNotEqual(first["images"], second["images"])

    def preview(self, tensors, node_id="preview", direction="从左向右"):
        with CurrentNodeContext(uuid.uuid4().hex, node_id):
            return LiuxinyuPreviewLongImage.execute(tensors, [direction], ["从上到下"]).ui

    def test_equal_new_tensor_reuses_and_single_float_change_invalidates(self):
        tensor = torch.zeros(1, 8, 9, 3)
        first = self.preview([tensor])
        with patch.object(Image.Image, "save", side_effect=AssertionError("encoded")):
            self.assertEqual(first, self.preview([tensor.clone()]))
        tensor[0, 0, 0, 0] = 0.00001  # Would quantize to the same uint8 value.
        second = self.preview([tensor])
        self.assertNotEqual(first, second)

    def test_preview_rebuilds_deleted_temp_and_keeps_other_nodes(self):
        tensor = torch.zeros(1, 8, 9, 3)
        first = self.preview([tensor])
        other = self.preview([tensor], "another")
        self.paths(first)[0].unlink()
        rebuilt = self.preview([tensor])
        self.assertTrue(all(path.is_file() for path in self.paths(rebuilt) + self.paths(other)))

    def test_tiles_and_thumbnails_share_preview_generation_cleanup(self):
        tensor = torch.zeros(1, 2051, 35, 4)
        first = self.preview([tensor])
        old_files = set(self.temp.iterdir())
        meta = first["images"][0]
        (self.temp / meta["display"]["thumbnails"][0]["filename"]).unlink()
        second = self.preview([tensor])
        self.assertNotEqual(first, second)
        self.assertTrue(all(not path.exists() for path in old_files))
        self.assertTrue(all((self.temp / item["filename"]).is_file()
                            for item in second["images"][0]["display"]["thumbnails"]))
        self.preview([])
        self.assertEqual(list(self.temp.iterdir()), [])

    def test_shorter_list_retires_entire_old_generation(self):
        tensors = [torch.zeros(1, height, 9, 3) for height in (8, 5, 2)]
        old = self.preview(tensors)
        new = self.preview(tensors[:1])
        self.assertEqual(len(new["images"]), 1)
        self.assertTrue(all(not path.exists() for path in self.paths(old)))
        empty = self.preview([])
        self.assertEqual(empty["images"], [])
        self.assertTrue(all(not path.exists() for path in self.paths(new)))

    def test_failure_mid_list_preserves_old_generation_and_removes_partial_files(self):
        self.preview([torch.zeros(1, 8, 9, 3)])
        old_files = set(self.temp.iterdir())
        original_save = Image.Image.save
        count = 0

        def failing_save(image, path, **kwargs):
            nonlocal count
            original_save(image, path, **kwargs)
            count += 1
            if count == len(old_files) + 1:
                raise OSError("simulated disk error")

        with patch.object(Image.Image, "save", failing_save), self.assertRaisesRegex(OSError, "disk error"):
            self.preview([torch.ones(1, 8, 9, 3), torch.ones(1, 5, 9, 3)])
        self.assertEqual(set(self.temp.iterdir()), old_files)

    def test_saved_selection_is_not_duplicated_and_manual_button_still_appends(self):
        dest = self.root / "saved"
        def run():
            with CurrentNodeContext(uuid.uuid4().hex, "saver"):
                return SaveSelectedFromBatch().execute([torch.ones(1, 8, 9, 3)], [str(dest)], ["x.png"], ["0"])["ui"]
        first = run()
        self.assertEqual(first, run())
        self.assertEqual(len(list(dest.iterdir())), 1)
        result = SaveSelectedFromBatch.save_selected_from_temp(first["session_id"][0], [0], str(dest), "x.png")
        self.assertEqual(len(result["saved"]), 1)
        self.assertEqual(len(list(dest.iterdir())), 2)
        self.paths(first)[0].unlink()
        rebuilt = run()
        self.assertTrue(all(path.is_file() for path in self.paths(rebuilt)))
        self.assertEqual(len(list(dest.iterdir())), 2)

    def test_absolute_save_rebuild_does_not_duplicate_permanent_outputs(self):
        for batch_size in (1, 2):
            with self.subTest(batch_size=batch_size):
                dest = self.root / f"absolute-{batch_size}"
                def run():
                    with CurrentNodeContext(uuid.uuid4().hex, f"absolute-{batch_size}"):
                        return SaveImageToAbsolutePath().save(
                            [torch.ones(batch_size, 3, 4, 3)], [str(dest)], ["x.png"], [False])["ui"]
                first = run()
                original_files = sorted(dest.rglob("*"))
                self.paths(first)[0].unlink()
                rebuilt = run()
                self.assertTrue(all(path.is_file() for path in self.paths(rebuilt)))
                self.assertEqual(first["text"], rebuilt["text"])
                self.assertEqual(sorted(dest.rglob("*")), original_files)

    def test_source_preview_A_B_A_and_missing_file(self):
        other = self.root / "other.png"
        Image.new("RGB", (9, 5), "white").save(other)
        prompt = {"out": {"class_type": "LoadImageFromPath", "inputs": {"path": str(self.source)}}}
        first = self.run_prompt(prompt)["out"]
        prompt["out"]["inputs"]["path"] = str(other)
        second = self.run_prompt(prompt)["out"]
        self.assertTrue(all(not path.exists() for path in self.paths(first)))
        prompt["out"]["inputs"]["path"] = str(self.source)
        third = self.run_prompt(prompt)["out"]
        self.assertTrue(all(not path.exists() for path in self.paths(second)))
        self.assertTrue(all(path.is_file() for path in self.paths(third)))
        self.paths(third)[0].unlink()
        fourth = self.run_prompt(prompt)["out"]
        self.assertTrue(all(path.is_file() for path in self.paths(fourth)))
        with patch.object(LoadImageFromPath, "execute", side_effect=AssertionError("redecoded")):
            self.assertEqual(fourth, self.run_prompt(prompt)["out"])

    def test_source_list_shrink_and_failure_preserve_valid_files(self):
        other = self.root / "other.png"
        Image.new("RGB", (9, 5), "white").save(other)
        def run(paths):
            return asyncio.run(execution.get_output_data(
                uuid.uuid4().hex, "loader", LoadImageFromPath(), {"path": paths}))
        outputs, first, _, _ = run([str(self.source), str(other)])
        self.assertEqual([tuple(image.shape) for image in outputs[0]], [(1, 11, 7, 3), (1, 5, 9, 3)])
        _, second, _, _ = run([str(self.source)])
        self.assertTrue(all(not path.exists() for path in self.paths(first)))
        with self.assertRaises(ValueError):
            run([str(other), str(self.root / "missing.png")])
        self.assertEqual(set(self.temp.iterdir()), set(self.paths(second)))

    def test_linked_text_file_cache_detects_overwrite(self):
        text_file = self.root / "input.txt"
        text_file.write_text("first", encoding="utf-8")
        prompt = {
            "source": {"class_type": "CacheTestString", "inputs": {"text": str(text_file)}},
            "out": {"class_type": "LiuxinyuLoadTextFile", "inputs": {"path": ["source", 0]}},
        }
        self.run_prompt(prompt)
        with patch.object(LiuxinyuLoadTextFile, "execute", new=classmethod(unexpected_execute)):
            self.run_prompt(prompt)
        text_file.write_text("other", encoding="utf-8")
        self.run_prompt(prompt)
        cached = asyncio.run(self.executor.caches.outputs.get("out"))
        self.assertEqual(cached.outputs[0], ["other"])

    def test_directory_match_refreshes_when_files_added(self):
        directory = self.root / "match"
        directory.mkdir()
        (directory / "a.png").write_bytes(b"a")
        prompt = {"out": {"class_type": "MatchPath", "inputs": {
            "directory": str(directory), "match_mode": "字符串匹配", "match_text": ".png",
            "match_target": "文件", "recursive": True, "match_full_path": False,
        }}}
        self.run_prompt(prompt)
        with patch.object(MatchPath, "execute", side_effect=AssertionError("directory matched again")):
            self.run_prompt(prompt)
        (directory / "b.png").write_bytes(b"b")
        self.run_prompt(prompt)
        cached = asyncio.run(self.executor.caches.outputs.get("out"))
        self.assertEqual(set(cached.outputs[0]), {str(directory / "a.png"), str(directory / "b.png")})

    def test_paint_layer_content_changes_fingerprint_without_deleting_layers(self):
        with patch("folder_paths.get_input_directory", return_value=str(self.root)):
            ref = save_editor_bundle(Image.new("RGB", (3, 4)), Image.new("RGBA", (3, 4)), Image.new("L", (3, 4), 255))
            name = f"{ref['subfolder']}/{ref['filename']} [input]"
            with CurrentNodeContext("first", "paint"):
                first = LiuxinyuRatioPaint.fingerprint_inputs(image=name)
                self.assertEqual(first, LiuxinyuRatioPaint.fingerprint_inputs(image=name))
                directory = self.root / ref["subfolder"]
                paint = next(directory.glob("clipspace-paint-*.png"))
                Image.new("RGBA", (3, 4), "red").save(paint)
                self.assertNotEqual(first, LiuxinyuRatioPaint.fingerprint_inputs(image=name))
            clear_previews()
            self.assertEqual(len(list(directory.glob("*.png"))), 4)

    def test_immediate_path_preview_reuses_and_invalidates(self):
        data = {"session": uuid.uuid4().hex, "revision": 1, "kind": "LoadImageFromPath", "path": str(self.source)}
        first = _path_preview(data)
        data["revision"] = 2
        with patch.object(Image.Image, "save", side_effect=AssertionError("encoded")):
            self.assertEqual(first, _path_preview(data))
        Image.new("RGB", (7, 11), "red").save(self.source)
        data["revision"] = 3
        second = _path_preview(data)
        self.assertNotEqual(first, second)
        self.assertTrue(all(not path.exists() for path in self.paths(first)))


if __name__ == "__main__":
    unittest.main()
