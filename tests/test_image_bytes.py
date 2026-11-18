"""Image byte contracts tested with Pillow and the real ComfyUI executor; no network."""
import asyncio
import base64
import importlib.util
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import execution
import nodes
import numpy as np
import torch
from PIL import Image, JpegImagePlugin
from aiohttp import web
from server import PromptServer
PromptServer.instance = SimpleNamespace(routes=web.RouteTableDef())
from image_path_nodes import SaveImageToAbsolutePath as Absolute
from batch_node import SaveSelectedFromBatch as Selected
from image_bytes_nodes import (LiuxinyuEncodeImage as Encode, LiuxinyuTranscodeImageBytes as Transcode,
    LiuxinyuDecodeImageBytes as Decode, LiuxinyuExtractImageBytes as Extract, LiuxinyuLoadFileBytes as Load)
from liuxinyu_image_bytes import encode_frame, validate_bytes, decode_frames, format_input, save_encoded
from liuxinyu_cache import clear_previews, file_changes


def run_node(cls, inputs):
    inputs = dict(inputs)
    if "format" in inputs:
        option = next(option for option in format_input().options if option.key == inputs["format"])
        for widget in option.inputs:
            inputs.setdefault("format." + widget.id, widget.default)
    data, missing, extra = execution.get_input_data(inputs, cls, cls.__name__)
    assert not missing, missing
    return asyncio.run(execution.get_output_data("bytes-test", cls.__name__, cls, data, v3_data=extra))[0]


class ImageBytesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.previews = self.root / "previews"
        self.patch = patch("folder_paths.get_temp_directory", return_value=str(self.previews))
        self.patch.start()
        clear_previews()
        self.pixels = np.random.default_rng(23).integers(0, 256, (17, 19, 4), dtype=np.uint8)
        self.image = Image.fromarray(self.pixels)
        self.tensor = torch.from_numpy(self.pixels.astype(np.float32) / 255).unsqueeze(0)
        self.jpeg = encode_frame(self.image, {"format": "JPEG", "quality": 71})

    def tearDown(self):
        clear_previews()
        file_changes.nodes.clear()
        self.patch.stop()
        self.tmp.cleanup()

    def test_dynamic_combo_every_format_through_executor(self):
        for option in format_input().options:
            with self.subTest(format=option.key):
                raw = {"image": self.tensor, "format": option.key}
                for widget in option.inputs:
                    raw["format." + widget.id] = widget.default
                output = run_node(Encode, raw)[0]
                self.assertEqual(len(output), 1)
                self.assertIsInstance(output[0], bytes)
                self.assertEqual(validate_bytes(output[0]), option.key)
                self.assertEqual(next(decode_frames(output[0])).size, (19, 17))

    def test_adam7_is_lossless_and_independent_of_alpha(self):
        for size in ((1, 1), (1, 9), (8, 1), (19, 17), (16, 16)):
            for alpha in (True, False):
                image = self.image.resize(size)
                for interlace in (True, False):
                    with self.subTest(size=size, alpha=alpha, interlace=interlace):
                        data = encode_frame(image, {"format": "PNG", "interlace": interlace, "alpha": alpha})
                        self.assertEqual(data[28], int(interlace))
                        decoded = next(decode_frames(data))
                        if alpha:
                            self.assertEqual(decoded.tobytes(), image.tobytes())
                        else:
                            expected = Image.new("RGB", size, "white")
                            expected.paste(image, mask=image.getchannel("A"))
                            self.assertEqual(decoded.mode, "RGB")
                            self.assertEqual(decoded.tobytes(), expected.tobytes())

    def test_jpeg_quality_sampling_progressive_and_no_resizing(self):
        low = encode_frame(self.image, {"format": "JPEG", "quality": 10})
        high = encode_frame(self.image, {"format": "JPEG", "quality": 100, "progressive": True, "subsampling": "4:2:0"})
        self.assertLess(len(low), len(high))
        with Image.open(BytesIO(high)) as img:
            self.assertTrue(img.info.get("progressive"))
            self.assertEqual(JpegImagePlugin.get_sampling(img), 2)
            self.assertEqual(img.size, self.image.size)

    def test_webp_lossless_and_tiff_preserve_rgba(self):
        for fmt in ("WEBP", "TIFF"):
            data = encode_frame(self.image, {"format": fmt, "lossless": True})
            self.assertEqual(next(decode_frames(data)).tobytes(), self.image.tobytes())

    def test_gif_dither_and_transparency(self):
        # A smooth gradient makes the selected dithering algorithm observable.
        gradient = np.tile(np.arange(256, dtype=np.uint8), (32, 1))
        image = Image.fromarray(gradient).convert("RGBA")
        image.putpixel((0, 0), (30, 20, 10, 0))
        outputs = []
        for dither in (False, True):
            data = encode_frame(image, {"format": "GIF", "colors": 4, "dither": dither})
            decoded = next(decode_frames(data))
            self.assertEqual(decoded.getpixel((0, 0))[3], 0)
            self.assertEqual(decoded.getpixel((255, 0))[3], 255)
            outputs.append(decoded.tobytes())
        self.assertNotEqual(*outputs)

    def test_decode_and_mask_roundtrip(self):
        source = encode_frame(self.image, {"format": "PNG"})
        images, masks = run_node(Decode, {"data": source})
        self.assertEqual(tuple(images[0].shape), (1, 17, 19, 3))
        self.assertEqual(tuple(masks[0].shape), (1, 17, 19))
        result = run_node(Encode, {"image": images[0], "mask": masks[0], "format": "PNG"})[0][0]
        self.assertEqual(next(decode_frames(result)).tobytes(), self.image.tobytes())
        for mask in (torch.zeros(3, 17, 19), torch.zeros(1, 16, 19), torch.full((1, 17, 19), float("nan"))):
            with self.assertRaises(ValueError):
                run_node(Encode, {"image": self.tensor, "mask": mask, "format": "PNG"})
        batch = self.tensor.repeat(2, 1, 1, 1)
        output = run_node(Encode, {"image": batch, "mask": torch.ones(1, 17, 19), "format": "PNG"})[0]
        self.assertEqual(len(output), 2)
        self.assertEqual(next(decode_frames(output[1])).getchannel("A").getextrema(), (0, 0))

    def test_extract_same_format_identity_transcode_reencodes(self):
        result = run_node(Extract, {"data": self.jpeg, "format": "JPEG", "format.quality": 10})[0][0]
        self.assertIs(result, self.jpeg)
        other = run_node(Transcode, {"data": self.jpeg, "format": "JPEG", "format.quality": 10})[0][0]
        self.assertNotEqual(other, self.jpeg)
        png = run_node(Extract, {"data": self.jpeg, "format": "PNG"})[0][0]
        self.assertEqual(validate_bytes(png), "PNG")

    def test_invalid_and_truncated_data_rejected(self):
        png = encode_frame(self.image, {"format": "PNG"})
        for data in (b"", b"not an image", self.jpeg[:100], self.jpeg[:-30], png[:-20], "x.jpg", bytearray(self.jpeg), {}):
            with self.subTest(kind=type(data).__name__), self.assertRaises((TypeError, ValueError, OSError, SyntaxError)):
                run_node(Extract, {"data": data, "format": "JPEG"})

    def test_animation_preserved_for_same_format_and_split_for_transcode(self):
        stream = BytesIO()
        Image.new("RGB", (7, 9), "red").save(stream, "GIF", save_all=True,
            append_images=[Image.new("RGB", (7, 9), "blue")], duration=80, loop=0)
        data = stream.getvalue()
        self.assertIs(run_node(Extract, {"data": data, "format": "GIF"})[0][0], data)
        self.assertEqual(len(run_node(Extract, {"data": data, "format": "PNG"})[0]), 2)
        self.assertEqual(len(run_node(Decode, {"data": data})[0]), 2)
        save_encoded(data, self.root / "same.gif", ".gif")
        self.assertEqual((self.root / "same.gif").read_bytes(), data)
        with self.assertRaises(ValueError):
            save_encoded(data, self.root / "other.png", ".png")

    def test_file_loader_raw_bytes_and_fingerprint(self):
        path = self.root / "file.bin"
        path.write_bytes(b"abc\x00")
        self.assertEqual(run_node(Load, {"path": str(path)})[0], [b"abc\x00"])
        before = Load.fingerprint_inputs(str(path))
        path.write_bytes(b"def\x00")
        self.assertNotEqual(before, Load.fingerprint_inputs(str(path)))
        path.write_bytes(b"")
        self.assertEqual(run_node(Load, {"path": str(path)})[0], [b""])
        with self.assertRaises(ValueError):
            run_node(Load, {"path": "relative.bin"})

    def test_absolute_save_and_cross_format(self):
        saver = Absolute()
        saver.save(self.jpeg, str(self.root), "exact.jpg", True)
        self.assertEqual((self.root / "exact.jpg").read_bytes(), self.jpeg)
        saver.save(self.jpeg, str(self.root), "changed.png", True)
        self.assertEqual(validate_bytes((self.root / "changed.png").read_bytes()), "PNG")
        with self.assertRaises(ValueError):
            saver.save(self.jpeg, str(self.root), "unknown.txt", True)

    def test_manual_and_auto_selection_save_original_bytes(self):
        ui = Selected().execute(self.jpeg, str(self.root), "auto.jpg", "0")["ui"]
        self.assertEqual((self.root / "auto_1.jpg").read_bytes(), self.jpeg)
        result = Selected.save_selected_from_temp("", [0], str(self.root), "manual.jpg",
            [item["filename"] for item in ui["images"]])
        self.assertEqual(Path(result["saved"][0]).read_bytes(), self.jpeg)
        source = self.previews / (ui["images"][0]["filename"] + ".source")
        source.unlink()
        result = Selected.save_selected_from_temp(ui["session_id"][0], [0], str(self.root), "manual.jpg")
        self.assertIn("error", result)

    def test_bytes_preview_cache_rebuild_and_cleanup(self):
        data = {"image": [self.jpeg], "folder": [str(self.root)], "filename": ["cache.jpg"], "selection": ["0"]}
        def run():
            return asyncio.run(execution.get_output_data("bytes-cache", "save", Selected(), data))[1]
        first = run()
        self.assertEqual(first, run())
        self.assertEqual(len(list(self.root.glob("cache_*.jpg"))), 1)
        source = self.previews / (first["images"][0]["filename"] + ".source")
        source.unlink()
        rebuilt = run()
        self.assertEqual(len(list(self.root.glob("cache_*.jpg"))), 1)
        source = self.previews / (rebuilt["images"][0]["filename"] + ".source")
        self.assertEqual(source.read_bytes(), self.jpeg)
        data["image"] = [encode_frame(self.image, {"format": "JPEG", "quality": 60})]
        run()
        self.assertEqual(len(list(self.root.glob("cache_*.jpg"))), 2)
        self.assertFalse(source.exists())
        clear_previews()
        self.assertEqual(list(self.previews.iterdir()), [])

    def test_native_validated_pipeline_and_cached_reload(self):
        source = self.root / "source.jpg"
        source.write_bytes(self.jpeg)
        def config(fmt):
            option = next(opt for opt in format_input().options if opt.key == fmt)
            return {"format": fmt, **{"format." + widget.id: widget.default for widget in option.inputs}}
        prompt = {
            "load": {"class_type": Load.__name__, "inputs": {"path": str(source)}},
            "extract": {"class_type": Extract.__name__, "inputs": {"data": ["load", 0], **config("JPEG")}},
            "transcode": {"class_type": Transcode.__name__, "inputs": {"data": ["extract", 0], **config("PNG")}},
            "decode": {"class_type": Decode.__name__, "inputs": {"data": ["transcode", 0]}},
            "encode": {"class_type": Encode.__name__, "inputs": {"image": ["decode", 0], "mask": ["decode", 1], **config("PNG")}},
            "save": {"class_type": Absolute.__name__, "inputs": {"image": ["encode", 0], "folder": str(self.root), "filename": "pipeline.png", "overwrite": True}},
            "selected": {"class_type": Selected.__name__, "inputs": {"image": ["extract", 0], "folder": str(self.root), "filename": "selected.jpg", "selection": "0"}},
        }
        classes = (Load, Extract, Transcode, Decode, Encode, Absolute, Selected)
        with patch.dict(nodes.NODE_CLASS_MAPPINGS, {cls.__name__: cls for cls in classes}):
            valid = asyncio.run(execution.validate_prompt("pipeline", prompt, None))
            self.assertTrue(valid[0], valid)
            server = SimpleNamespace(client_id=None, send_sync=lambda *args: None)
            executor = execution.PromptExecutor(server, execution.CacheType.RAM_PRESSURE, {"ram": 0, "ram_inactive": 0})
            for _ in range(2):
                executor.execute(deepcopy(prompt), "pipeline", execute_outputs=["save", "selected"])
                self.assertTrue(executor.success, executor.status_messages)
            self.assertEqual((self.root / "selected_1.jpg").read_bytes(), self.jpeg)
            self.assertFalse((self.root / "selected_2.jpg").exists())
            source.write_bytes(encode_frame(self.image, {"format": "JPEG", "quality": 20}))
            executor.execute(deepcopy(prompt), "changed-pipeline", execute_outputs=["save", "selected"])
            self.assertTrue(executor.success, executor.status_messages)
            self.assertEqual((self.root / "selected_2.jpg").read_bytes(), source.read_bytes())
            self.assertEqual(validate_bytes((self.root / "pipeline.png").read_bytes()), "PNG")

    def test_harness_receives_exact_bytes_with_actual_mime(self):
        path = PACK.parent / "comfyui-llm_harness_engineering/image_inputs.py"
        if not path.exists():
            self.skipTest("Harness package is not installed")
        spec = importlib.util.spec_from_file_location("byte_contract_harness", path)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        data = run_node(Encode, {"image": self.tensor, "format": "JPEG"})[0][0]
        mime, encoded = helper.encode_image_bytes(data)
        self.assertEqual(mime, "image/jpeg")
        self.assertEqual(base64.b64decode(encoded), data)
        self.assertIs(helper.image_frames(data)[0], data)


if __name__ == "__main__":
    unittest.main()
