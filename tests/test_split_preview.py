"""Run with ComfyUI's Python: python tests/test_split_preview.py -v."""

import asyncio
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACK.parents[1]))
sys.path.insert(0, str(PACK))

import torch
from PIL import Image, ImageDraw
import execution
import nodes
from split_preview_nodes import (
    LiuxinyuSplitLook as Look,
    LiuxinyuSplitBoundaryPreview as Boundary,
    LiuxinyuSplitSegments as Segments,
    _draw_horizontal_ruler,
)
from preview_long_image_node import LiuxinyuPreviewLongImage as LongPreview
from number_node import LiuxinyuNumberArray as NumberArray
from number_node import LiuxinyuStringToLiteral as Literal
from stitch_batch_node import LiuxinyuStitchImageBatchList as Stitch
from comfy.model_management import InterruptProcessingException


def run_node(node, **inputs):
    return asyncio.run(execution.get_output_data("regression", "1", node, inputs))


class SplitPreviewTests(unittest.TestCase):
    def setUp(self):
        self.image = torch.linspace(0, 1, 205 * 790 * 3).reshape(1, 205, 790, 3)
        self.boundaries = [{"percent": 25}, {"percent": 75}]

    def test_look_to_builtin_preview_writes_one_image_per_block(self):
        output, _, _, _ = run_node(Look, image=[self.image], block_height=[100])
        saved_sizes = []
        with patch("folder_paths.get_save_image_path", return_value=(str(PACK), "test", 1, "", "test")):
            preview = nodes.PreviewImage()
            with patch.object(Image.Image, "save", lambda img, *a, **k: saved_sizes.append(img.size)):
                _, ui, _, _ = run_node(preview, images=output[0])
        self.assertEqual(saved_sizes, [(835, 100), (835, 100), (835, 5)])
        self.assertEqual(len(ui["images"]), 3)

    def test_all_split_outputs_keep_batch_dimension(self):
        for node, kwargs, count in (
            (Look, {"block_height": 100}, 3),
            (Boundary, {"boundaries": self.boundaries, "crop_margin": 50}, 2),
            (Segments, {"boundaries": self.boundaries}, 3),
        ):
            with self.subTest(node=node.__name__):
                images = node.execute(self.image, **kwargs)[0]
                self.assertEqual(len(images), count)
                for image in images:
                    self.assertEqual(image.ndim, 4)
                    self.assertEqual(image.shape[0], 1)

    def test_every_frame_of_a_batch_is_processed(self):
        batch = torch.cat([torch.zeros_like(self.image), torch.ones_like(self.image)])
        for node, kwargs, per_frame in (
            (Look, {"block_height": 100}, 3),
            (Boundary, {"boundaries": self.boundaries, "crop_margin": 50}, 2),
            (Segments, {"boundaries": self.boundaries}, 3),
        ):
            with self.subTest(node=node.__name__):
                images = node.execute(batch, **kwargs)[0]
                self.assertEqual(len(images), 2 * per_frame)
                if node is Look:
                    self.assertEqual(images[0][0, 0, 45].tolist(), [0, 0, 0])
                    self.assertEqual(images[3][0, 0, 45].tolist(), [1, 1, 1])

    def test_list_dispatch_preserves_different_image_sizes(self):
        output, _, _, _ = run_node(
            Look, image=[self.image, self.image[:, :50, :80]], block_height=[100]
        )
        self.assertEqual([tuple(t.shape) for t in output[0]], [
            (1, 100, 835, 3), (1, 100, 835, 3), (1, 5, 835, 3), (1, 50, 125, 3)
        ])

    def test_final_segments_preserve_pixels_channels_and_order(self):
        for channels in (3, 4):
            with self.subTest(channels=channels):
                batch = torch.linspace(0, 1, 2 * 21 * 7 * channels).reshape(2, 21, 7, channels)
                boundaries = [{"percent": 75}, {"percent": 25}]
                pieces = Segments.execute(batch, boundaries)[0]
                self.assertEqual(len(pieces), 6)
                for index in range(2):
                    rebuilt = torch.cat(pieces[index * 3:(index + 1) * 3], dim=1)
                    self.assertTrue(torch.equal(rebuilt, batch[index:index + 1]))
                    self.assertEqual(rebuilt.dtype, batch.dtype)

    def test_stitched_image_accepts_numeric_array_for_both_split_nodes(self):
        numbers, _, _, _ = run_node(NumberArray, number0=[0.1], number1=[0.2])
        source = torch.linspace(0, 1, 100 * 32 * 3).reshape(1, 100, 32, 3)
        for direction, stitch_direction, axis in (
            ("上下切分", "从上到下", 1), ("左右切分", "从左到右", 2),
        ):
            with self.subTest(direction=direction):
                image = source if axis == 1 else source.transpose(1, 2)
                stitched, _, _, _ = run_node(
                    Stitch, images=[image.narrow(axis, 0, 40), image.narrow(axis, 40, 60)],
                    direction=[stitch_direction], target_format=["PNG"])
                pieces, _, _, _ = run_node(Segments, image=stitched[0], boundaries=numbers[0],
                                           direction=[direction])
                self.assertEqual([piece.shape[axis] for piece in pieces[0]], [10, 10, 80])
                self.assertTrue(torch.equal(torch.cat(pieces[0], dim=axis), image))
                previews, _, _, _ = run_node(Boundary, image=stitched[0], boundaries=numbers[0],
                                             crop_margin=[10], direction=[direction])
                expected = Boundary.execute(image, [{"percent": 10}, {"percent": 20}],
                                            10, direction=direction)[0]
                self.assertEqual(len(previews[0]), 2)
                self.assertTrue(all(torch.equal(actual, original)
                                    for actual, original in zip(previews[0], expected)))

    def test_numeric_ratios_and_object_percentages_have_distinct_units(self):
        source = torch.zeros(1, 1000, 4, 3)
        ratios = Segments.execute(source, [0.1, 0.2])[0]
        percentages = Segments.execute(source, [{"percent": 0.1}, {"percent": 0.2}])[0]
        self.assertEqual([piece.shape[1] for piece in ratios], [100, 100, 800])
        self.assertEqual([piece.shape[1] for piece in percentages], [1, 1, 998])

    def test_deserialized_arrays_reach_both_split_nodes_as_one_value(self):
        for text in ('[0.1, 0.2]', '[{"percent": 10}, {"percent": 20}]',
                     '```json\n[{"percent": 10}, {"percent": 20}]\n```'):
            parsed, _, _, _ = run_node(Literal, text=[text])
            self.assertEqual(len(parsed[0]), 2)
            self.assertEqual(len(parsed[1]), 1)
            for direction, axis in (("上下切分", 1), ("左右切分", 2)):
                with self.subTest(text=text, direction=direction):
                    source = torch.arange(3000).float().reshape(1, 100, 10, 3)
                    if axis == 2:
                        source = source.transpose(1, 2)
                    pieces, _, _, _ = run_node(Segments, image=[source], boundaries=parsed[1],
                                               direction=[direction])
                    self.assertEqual([piece.shape[axis] for piece in pieces[0]], [10, 10, 80])
                    self.assertTrue(torch.equal(torch.cat(pieces[0], dim=axis), source))
                    previews, _, _, _ = run_node(Boundary, image=[source], boundaries=parsed[1],
                                                 crop_margin=[10], direction=[direction])
                    self.assertEqual(len(previews[0]), 2)

    def test_deserialization_preserves_objects_and_separate_text_executions(self):
        value = {"name": "边界", "values": [10, 0.2, True, None, {"percent": 20}]}
        text = '{"name":"边界","values":[10,0.2,true,null,{"percent":20}]}'
        for wrapper in ("{}", "```\n{}\n```", " \n```JSON\r\n{}\r\n```\n "):
            with self.subTest(wrapper=wrapper):
                result = Literal.execute(wrapper.format(text))
                self.assertEqual(result[0], [value])
                self.assertEqual(result[1], value)
        parsed, _, _, _ = run_node(Literal, text=['[0.1, 0.2]', '[0.3, 0.4]'])
        self.assertEqual(parsed[0], [0.1, 0.2, 0.3, 0.4])
        self.assertEqual(parsed[1], [[0.1, 0.2], [0.3, 0.4]])
        self.assertEqual(Literal.execute('[]')[1], [])
        self.assertEqual(Literal.execute('{}')[1], {})

    def test_invalid_objects_preserve_original_string_fallback(self):
        for text in ('{broken}', "[{'percent': 10}]", '[{"percent":NaN}]',
                     '[{"percent":Infinity}]', '__import__("os")'):
            with self.subTest(text=text):
                result = Literal.execute(text)
                self.assertEqual(result[0], [text])
                self.assertEqual(result[1], text)
                self.assertEqual(result.ui["liuxinyu_literal_type"], ["字符串"])

    def test_literal_legacy_types_and_list_expansion_are_preserved(self):
        for text, value, kind in (
            ('42', 42, '整数'), ('0.5', 0.5, '浮点数（双精度）'),
            ('#ff8800', '#ff8800', '颜色（十六进制字符串）'),
            ('“你好”', '你好', '字符串'), ('"0.1"', '0.1', '字符串'),
            ('1，2，3', [1, 2, 3], '整数数组'),
            ('[0.1, 0.2]', [0.1, 0.2], '浮点数（双精度）数组'),
            ('["a,b", "c"]', ['a,b', 'c'], '字符串数组'),
            ('[[1,2],[3,4]]', [[1, 2], [3, 4]], '整数数组数组'),
            ('[{"percent":10,"name":"第一刀"},{"percent":20}]',
             [{"percent": 10, "name": "第一刀"}, {"percent": 20}], '对象数组'),
        ):
            with self.subTest(text=text):
                result = Literal.execute(text)
                self.assertEqual(result[0], value if isinstance(value, list) else [value])
                self.assertEqual(result[1], value)
                self.assertEqual(result.ui["liuxinyu_literal_type"], [kind])

    def test_removed_boundary_formats_are_rejected_in_both_directions(self):
        for boundaries in ({"boundaries": [0.1, 0.2]}, {"percent": 10},
                           [{"y_percent": 10}], [{"x_percent": 10}], [0.1, {"percent": 20}], []):
            for direction in ("上下切分", "左右切分"):
                for node, kwargs in ((Boundary, {"crop_margin": 10}), (Segments, {})):
                    with self.subTest(boundaries=boundaries, direction=direction, node=node.__name__):
                        with self.assertRaises(ValueError):
                            node.execute(self.image, boundaries, direction=direction, **kwargs)

    def test_invalid_object_percentages_are_rejected(self):
        for value in (None, True, "10", 0, 100, -10, float("nan"), float("inf")):
            for node, kwargs in ((Boundary, {"crop_margin": 10}), (Segments, {})):
                with self.subTest(value=value, node=node.__name__), self.assertRaisesRegex(ValueError, "边界"):
                    node.execute(self.image, [{"percent": value}], **kwargs)

    def test_invalid_numeric_boundaries_have_clear_errors(self):
        for value in (0, 1, -0.1, 10, float("nan"), float("inf"), True, "0.1"):
            for node, kwargs in ((Boundary, {"crop_margin": 10}), (Segments, {})):
                with self.subTest(value=value, node=node.__name__), self.assertRaisesRegex(ValueError, "边界"):
                    node.execute(self.image, [value], **kwargs)

    def test_preview_rejects_missing_batch_dimension_before_writing(self):
        with patch.object(Image.Image, "save") as save:
            with self.assertRaisesRegex(ValueError, "IMAGE"):
                LongPreview.execute(self.image[0], "从左向右", "从上到下")
            save.assert_not_called()

    def test_empty_batches_produce_no_images(self):
        empty = self.image[:0]
        self.assertEqual(Look.execute(empty, 100)[0], [])
        self.assertEqual(Boundary.execute(empty, self.boundaries, 50)[0], [])
        self.assertEqual(Segments.execute(empty, self.boundaries)[0], [])

    def test_nonpositive_block_height_is_rejected(self):
        for height in (0, -100):
            with self.subTest(height=height), self.assertRaises(ValueError):
                Look.execute(self.image, height)

    def test_split_nodes_honor_cancellation(self):
        for node, kwargs in (
            (Look, {"block_height": 100}),
            (Boundary, {"boundaries": self.boundaries, "crop_margin": 50}),
            (Segments, {"boundaries": self.boundaries}),
        ):
            with self.subTest(node=node.__name__):
                with patch("split_preview_nodes.throw_exception_if_processing_interrupted",
                           side_effect=InterruptProcessingException):
                    with self.assertRaises(InterruptProcessingException):
                        node.execute(self.image, **kwargs)

    def test_preview_list_dispatch_reports_one_image_per_block(self):
        output, _, _, _ = run_node(Look, image=[self.image], block_height=[100])
        with patch.object(Image.Image, "save") as save:
            _, ui, _, _ = run_node(LongPreview, image=output[0],
                                  scroll_direction=["从左向右"], tall_scroll_direction=["从上到下"])
        original_names = [item["filename"] for item in ui["images"]]
        saved_originals = [Path(call.args[0]).name for call in save.call_args_list
                           if Path(call.args[0]).name in original_names]
        self.assertEqual(len(original_names), 3)
        self.assertCountEqual(saved_originals, original_names)
        self.assertEqual([item["preview_size"] for item in ui["images"]],
                         [[835, 100], [835, 100], [835, 5]])

    def test_single_channel_images_keep_valid_preview_shapes(self):
        gray = self.image[..., :1]
        blocks = Look.execute(gray, 100)[0]
        self.assertEqual(tuple(blocks[0].shape), (1, 100, 835, 3))
        with patch.object(Image.Image, "save"):
            result = LongPreview.execute(gray, "从左向右", "从上到下")
        self.assertEqual(result.ui["images"][0]["preview_size"], [790, 205])

    def test_overlap_preserves_coordinates_in_both_directions(self):
        for direction, axis in (("上下切分", 1), ("左右切分", 2)):
            with self.subTest(direction=direction):
                shape = (1, 24, 7, 3) if axis == 1 else (1, 7, 24, 3)
                pixels = torch.arange(24).remainder(2).float()
                source = pixels.reshape(1, 24, 1, 1) if axis == 1 else pixels.reshape(1, 1, 24, 1)
                source = source.expand(shape)
                pieces = Look.execute(source, 10, overlap=3, direction=direction)[0]
                # 0:10, 7:17, 14:24; no extra fully overlapped tail at 21:24.
                self.assertEqual(len(pieces), 3)
                for piece, start in zip(pieces, (0, 7, 14)):
                    content = piece[:, :, 45:] if axis == 1 else piece[:, :-45]
                    self.assertTrue(torch.equal(content, source.narrow(axis, start, 10)))

    def test_invalid_overlap_is_rejected(self):
        for overlap in (-1, 100, 101):
            with self.subTest(overlap=overlap), self.assertRaisesRegex(ValueError, "重叠"):
                Look.execute(self.image, 100, overlap=overlap)

    def test_horizontal_segments_preserve_batch_channels_and_optional_names(self):
        for channels in (1, 3, 4):
            source = torch.linspace(0, 1, 2 * 7 * 21 * channels).reshape(2, 7, 21, channels)
            for name in ({}, {"name": "切点"}):
                with self.subTest(channels=channels, name=name):
                    pieces = Segments.execute(source, [{"percent": 75, **name}, {"percent": 25}], direction="左右切分")[0]
                    self.assertEqual(len(pieces), 6)
                    self.assertEqual([part.shape[2] for part in pieces], [5, 11, 5] * 2)
                    for index in range(2):
                        restored = torch.cat(pieces[index * 3:(index + 1) * 3], dim=2)
                        self.assertTrue(torch.equal(restored, source[index:index + 1]))

    def test_horizontal_list_dispatch_and_boundary_panels(self):
        source = torch.zeros(1, 7, 24, 3)
        output, _, _, _ = run_node(Look, image=[source, source[:, :, :8]], block_height=[10],
                                   overlap=[3], direction=["左右切分"])
        self.assertEqual([tuple(part.shape) for part in output[0]],
                         [(1, 52, 10, 3)] * 3 + [(1, 52, 8, 3)])
        parts = Boundary.execute(source, [{"percent": 25}, {"percent": 75}], 5, direction="左右切分")[0]
        self.assertEqual(len(parts), 2)
        for part in parts:
            self.assertEqual(part.shape[0], 1)
            # Magnified panel is to the left of the local panel. Both rulers are below their images.
            self.assertGreater(part.shape[2], part.shape[1])
            self.assertEqual(part.shape[-1], 3)

    def test_horizontal_ruler_labels_fit_without_overlapping(self):
        canvas = Image.new("RGB", (300, 45))
        draw = ImageDraw.Draw(canvas)
        with patch.object(draw, "text", wraps=draw.text) as text:
            _draw_horizontal_ruler(draw, 1000, 400, 700, 300, 0)
        boxes = []
        for call in text.call_args_list:
            xy, label = call.args
            boxes.append(draw.textbbox(xy, label, font=call.kwargs["font"]))
        self.assertGreater(len(boxes), 1)
        boxes.sort()
        for left, top, right, bottom in boxes:
            self.assertGreaterEqual(left, 0)
            self.assertGreaterEqual(top, 12)
            self.assertLessEqual(right, 300)
            self.assertLessEqual(bottom, 45)
        for first, second in zip(boxes, boxes[1:]):
            self.assertLessEqual(first[2] + 4, second[0])

if __name__ == "__main__":
    unittest.main()
