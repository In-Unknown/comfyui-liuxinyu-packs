"""按百分比边界切分长图：自动切块预览、边界检查图、最终切分。"""

from pathlib import Path
from numbers import Real

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFont

from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted


RULER_WIDTH = 45
LOOK_CROP_HEIGHT = 2000
BOUNDARY_CROP_MARGIN = 300
MAG_CROP_WIDTH = 400
MAG_CROP_HEIGHT = 160
MAG_SCALE = 2
MIN_PIXELS_PER_TICK = 3.0
MAJOR_TICK_LENGTH = 12
MAJOR_TICK_WIDTH = 2
MAJOR_FONT_SIZE = 12
HALF_TICK_LENGTH = 7
HALF_TICK_WIDTH = 1
HALF_FONT_SIZE = 8
MINOR_TICK_LENGTH = 4
MINOR_TICK_WIDTH = 1
HP_HALF_TICK_LENGTH = 11
HP_HALF_TICK_WIDTH = 2
HP_HALF_FONT_SIZE = 12
HP_QUARTER_TICK_LENGTH = 8
HP_QUARTER_TICK_WIDTH = 1
HP_QUARTER_FONT_SIZE = 11
RULER_BACKGROUND = (248, 248, 248)
RULER_LINE_COLOR = (100, 100, 100)
MAJOR_TICK_COLOR = (35, 35, 35)
MINOR_TICK_COLOR = (150, 150, 150)
BOUNDARY_COLOR = (235, 35, 35)
REFERENCE_LINE_COLOR = (255, 145, 0)
TEXT_COLOR = (35, 35, 35)
BOUNDARY_TEXT_COLOR = (220, 20, 20)
WHITE = (255, 255, 255)
BORDER_COLOR = (0, 0, 0)
BOUNDARY_LINE_WIDTH = 3
REFERENCE_LINE_WIDTH = 2
SMALL_FONT_SIZE = 10
BOUNDARY_PREVIEW_FONT_SIZE = 32
SPLIT_DIRECTIONS = ["上下切分", "左右切分"]


_FONT_CACHE = {}


def _load_font(size):
    if size in _FONT_CACHE:
        return _FONT_CACHE[size]
    for p in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\arial.ttf"):
        path = Path(p)
        if path.exists():
            try:
                font = ImageFont.truetype(str(path), size)
                _FONT_CACHE[size] = font
                return font
            except OSError:
                pass
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    _FONT_CACHE[size] = font
    return font


def _tensor_to_pil(tensor):
    pixels = (tensor * 255.0).clamp(0, 255).to(torch.uint8)
    pixels = pixels.cpu().numpy()
    if pixels.shape[-1] == 1:
        pixels = pixels[..., 0]
    return Image.fromarray(pixels)


def _pil_to_tensor(img):
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    # IMAGE 列表的每一项仍然需要批次维度：[1, H, W, C]。
    return torch.from_numpy(arr).unsqueeze(0)


def _validate_image(image):
    if not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
        raise ValueError("图片必须是 IMAGE 张量 [B, H, W, C]，不能缺少批次维度。")
    if image.shape[1] <= 0 or image.shape[2] <= 0:
        raise ValueError("图片宽度和高度必须大于 0。")


def _choose_tick_step(image_height):
    for step in (0.001, 0.01, 0.1, 1.0):
        if image_height * step / 100.0 >= MIN_PIXELS_PER_TICK:
            return step
    return 1.0


def _draw_text_bg(draw, xy, text, font, color, bg=WHITE, padding=3):
    x, y = xy
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    draw.rectangle((x, y, x + w + padding * 2, y + h + padding * 2), fill=bg)
    draw.text((x + padding, y + padding - bbox[1]), text, font=font, fill=color)


def _draw_ruler(draw, image_height, visible_top, visible_bottom, output_height):
    step = _choose_tick_step(image_height)
    high_precision = step <= 0.01
    major_font = _load_font(MAJOR_FONT_SIZE)
    half_font = _load_font(HALF_FONT_SIZE)
    hp_half_font = _load_font(HP_HALF_FONT_SIZE) if high_precision else None
    hp_quarter_font = _load_font(HP_QUARTER_FONT_SIZE) if high_precision else None

    draw.line((RULER_WIDTH - 1, 0, RULER_WIDTH - 1, output_height - 1), fill=RULER_LINE_COLOR, width=1)

    total_steps = round(100.0 / step)
    previous_label_bottom = -2
    for tick_index in range(total_steps + 1):
        percent = tick_index * step
        original_y = round(image_height * percent / 100.0)
        if not visible_top <= original_y < visible_bottom:
            continue
        local_y = original_y - visible_top
        if not 0 <= local_y < output_height:
            continue

        is_major = abs(percent - round(percent)) < 1e-7
        is_half = not is_major and abs(percent * 2 - round(percent * 2)) < 1e-7
        is_quarter = not is_major and not is_half and abs(percent * 4 - round(percent * 4)) < 1e-7

        label = None
        label_font = None
        tick_color = MINOR_TICK_COLOR

        if is_major:
            length, width, tick_color = MAJOR_TICK_LENGTH, MAJOR_TICK_WIDTH, MAJOR_TICK_COLOR
            label, label_font = f"{int(round(percent))}%", major_font
        elif high_precision and is_half:
            length, width, tick_color = HP_HALF_TICK_LENGTH, HP_HALF_TICK_WIDTH, MAJOR_TICK_COLOR
            label, label_font = f"{percent:.1f}%", hp_half_font
        elif high_precision and is_quarter:
            length, width = HP_QUARTER_TICK_LENGTH, HP_QUARTER_TICK_WIDTH
            label, label_font = f"{percent:.2f}%", hp_quarter_font
        elif not high_precision and is_half:
            length, width = HALF_TICK_LENGTH, HALF_TICK_WIDTH
            label, label_font = f"{percent:.1f}%", half_font
        else:
            length, width = MINOR_TICK_LENGTH, MINOR_TICK_WIDTH

        draw.line((RULER_WIDTH - length, local_y, RULER_WIDTH - 1, local_y), fill=tick_color, width=width)

        if label and label_font:
            bbox = draw.textbbox((0, 0), label, font=label_font)
            lh = bbox[3] - bbox[1]
            ty = max(0, min(output_height - lh, local_y - lh // 2))
            if ty < previous_label_bottom + 2 or lh > output_height:
                continue
            draw.text((2, ty - bbox[1]), label, font=label_font, fill=TEXT_COLOR)
            previous_label_bottom = ty + lh


def _draw_horizontal_ruler(draw, image_length, visible_start, visible_end, output_width, ruler_y):
    step = _choose_tick_step(image_length)
    high_precision = step <= 0.01
    draw.line((0, ruler_y, output_width - 1, ruler_y), fill=RULER_LINE_COLOR, width=1)
    labels = []
    for tick_index in range(round(100.0 / step) + 1):
        percent = tick_index * step
        position = round(image_length * percent / 100.0)
        if not visible_start <= position < visible_end:
            continue
        x = position - visible_start
        label = None
        priority = 2
        if abs(percent - round(percent)) < 1e-7:
            length, line_width = MAJOR_TICK_LENGTH, MAJOR_TICK_WIDTH
            label, font, priority = f"{round(percent)}%", _load_font(MAJOR_FONT_SIZE), 0
        elif abs(percent * 2 - round(percent * 2)) < 1e-7:
            length = HP_HALF_TICK_LENGTH if high_precision else HALF_TICK_LENGTH
            line_width = HP_HALF_TICK_WIDTH if high_precision else HALF_TICK_WIDTH
            label, font, priority = f"{percent:.1f}%", _load_font(HP_HALF_FONT_SIZE if high_precision else HALF_FONT_SIZE), 1
        elif high_precision and abs(percent * 4 - round(percent * 4)) < 1e-7:
            length, line_width = HP_QUARTER_TICK_LENGTH, HP_QUARTER_TICK_WIDTH
            label, font = f"{percent:.2f}%", _load_font(HP_QUARTER_FONT_SIZE)
        else:
            length, line_width = MINOR_TICK_LENGTH, MINOR_TICK_WIDTH
        draw.line((x, ruler_y, x, ruler_y + length - 1),
                  fill=MAJOR_TICK_COLOR if priority < 2 else MINOR_TICK_COLOR, width=line_width)
        if label:
            bbox = draw.textbbox((0, 0), label, font=font)
            text_width = bbox[2] - bbox[0]
            if text_width <= output_width - 4:
                left = max(2, min(output_width - text_width - 2, x - text_width / 2))
                labels.append((priority, left, left + text_width, label, font, bbox))

    # Keep whole-percent labels first; insert finer labels only into free space.
    occupied = []
    for _, left, right, label, font, bbox in sorted(labels, key=lambda it: (it[0], it[1])):
        if any(left < end + 4 and right > start - 4 for start, end in occupied):
            continue
        draw.text((left - bbox[0], ruler_y + MAJOR_TICK_LENGTH + 4 - bbox[1]),
                  label, font=font, fill=TEXT_COLOR)
        occupied.append((left, right))


def _canvas_with_ruler(image, original_height, visible_top, visible_bottom, horizontal=False):
    image = image.convert("RGB")
    if horizontal:
        canvas = Image.new("RGB", (image.width, image.height + RULER_WIDTH), RULER_BACKGROUND)
        canvas.paste(image, (0, 0))
        _draw_horizontal_ruler(ImageDraw.Draw(canvas), original_height, visible_top, visible_bottom,
                               image.width, image.height)
        return canvas
    canvas = Image.new("RGB", (RULER_WIDTH + image.width, image.height), RULER_BACKGROUND)
    canvas.paste(image, (RULER_WIDTH, 0))
    _draw_ruler(ImageDraw.Draw(canvas), original_height, visible_top, visible_bottom, image.height)
    return canvas


def _normalize_boundaries(items, length):
    if not isinstance(items, list):
        raise ValueError('切分数组只支持 [0.1, 0.2] 或 [{"percent": 10}, {"percent": 20}]，不要用对象包裹数组。')
    if not items:
        raise ValueError("切分数组不能为空。")
    object_array = isinstance(items[0], dict)
    if any(isinstance(item, dict) != object_array for item in items):
        raise ValueError("切分数组请统一使用数值比例或 percent 对象，不要混合两种写法。")

    result = []
    for index, item in enumerate(items, start=1):
        name = f"B{index}"
        if isinstance(item, Real) and not isinstance(item, bool):
            if not 0 < item < 1:
                raise ValueError(
                    f"第 {index} 个边界比例必须大于 0 且小于 1：{item}。"
                    "例如 10% 填 0.1；图像两端无需填写。"
                )
            percent = float(item) * 100.0
        elif isinstance(item, dict):
            percent = item.get("percent")
            if isinstance(percent, bool) or not isinstance(percent, Real):
                raise ValueError(f'第 {index} 个边界需要数值 percent，例如 {{"percent": 10}}；不再使用 x_percent/y_percent。')
            if not 0 < percent < 100:
                raise ValueError(f"第 {index} 个边界百分比必须大于 0 且小于 100：{percent}")
            percent = float(percent)
            name = str(item.get("name", name))
        else:
            raise ValueError(
                f"第 {index} 个边界必须是数值比例（例如 0.1）或百分比对象（例如 {{\"percent\": 10}}）。"
            )
        result.append({
            "index": index,
            "name": name,
            "percent": percent,
            "position": round(length * percent / 100.0),
        })
    result.sort(key=lambda it: it["position"])
    for i, it in enumerate(result, start=1):
        it["index"] = i
    return result


def _split_axis(direction):
    if direction not in SPLIT_DIRECTIONS:
        raise ValueError("切分方向必须是上下切分或左右切分。")
    return 2 if direction == "左右切分" else 1


def _direction_input():
    return io.Combo.Input("direction", display_name="切分方向", options=SPLIT_DIRECTIONS,
                          default="上下切分", optional=True)


def _caption_panel(image, text, font):
    bbox = font.getbbox(text)
    header_height = bbox[3] - bbox[1] + 12
    panel = Image.new("RGB", (max(image.width, bbox[2] - bbox[0] + 12), image.height + header_height), WHITE)
    panel.paste(image, (0, header_height))
    ImageDraw.Draw(panel).text((6 - bbox[0], 6 - bbox[1]), text, font=font, fill=BOUNDARY_TEXT_COLOR)
    return panel


def _horizontal_boundary_previews(pil, items, margin):
    outputs = []
    for item in items:
        throw_exception_if_processing_interrupted()
        boundary = item["position"]
        left, right = max(0, boundary - margin), min(pil.width, boundary + margin)
        canvas = _canvas_with_ruler(pil.crop((left, 0, right, pil.height)), pil.width, left, right, True)
        draw = ImageDraw.Draw(canvas)
        for other in items:
            if other["index"] != item["index"] and left <= other["position"] < right:
                x = other["position"] - left
                draw.line((x, 0, x, pil.height - 1), fill=REFERENCE_LINE_COLOR, width=REFERENCE_LINE_WIDTH)
        x = min(right - left - 1, boundary - left)
        draw.line((x, 0, x, pil.height - 1), fill=BOUNDARY_COLOR, width=BOUNDARY_LINE_WIDTH)
        label = f'当前 {item["name"]}: {item["percent"]:.3f}%'
        canvas = _caption_panel(canvas, f"{label} | 原图 X={boundary}px", _load_font(SMALL_FONT_SIZE))

        mag_left = max(0, boundary - MAG_CROP_HEIGHT // 2)
        mag_right = min(pil.width, boundary + MAG_CROP_HEIGHT // 2)
        crop = pil.crop((mag_left, max(0, pil.height - MAG_CROP_WIDTH), mag_right, pil.height))
        magnified = _canvas_with_ruler(crop, pil.width, mag_left, mag_right, True)
        magnified = magnified.resize((magnified.width * MAG_SCALE, magnified.height * MAG_SCALE), Image.Resampling.LANCZOS)
        mag_draw = ImageDraw.Draw(magnified)
        x = min(magnified.width - 1, (boundary - mag_left) * MAG_SCALE)
        mag_draw.line((x, 0, x, crop.height * MAG_SCALE - 1), fill=BOUNDARY_COLOR, width=BOUNDARY_LINE_WIDTH + 1)
        mag_draw.rectangle((0, 0, magnified.width - 1, magnified.height - 1), outline=BORDER_COLOR, width=2)
        magnified = _caption_panel(magnified, label, _load_font(BOUNDARY_PREVIEW_FONT_SIZE))

        result = Image.new("RGB", (magnified.width + 20 + canvas.width, max(magnified.height, canvas.height)), WHITE)
        result.paste(magnified, (0, result.height - magnified.height))
        result.paste(canvas, (magnified.width + 20, result.height - canvas.height))
        outputs.append(_pil_to_tensor(result))
    return outputs


class LiuxinyuSplitLook(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuSplitLook",
            display_name="切分预览（自动切块）",
            category="image/split",
            description=(
                "沿上下或左右方向按固定像素距离切块，可设置相邻块重叠像素。上下切分时左侧加刻度，左右切分时底部加刻度，"
                "方便确定切分位置。输出为图片列表，每项一块。"
            ),
            inputs=[
                io.Image.Input("image", display_name="图片", tooltip="通常是一张拼接好的长图。"),
                io.Int.Input("block_height", display_name="每块切分距离", default=LOOK_CROP_HEIGHT, min=100, max=20000,
                             tooltip="上下切分时为高度，左右切分时为宽度，单位像素。"),
                io.Int.Input("overlap", display_name="切分重叠像素", default=0, min=0, max=19999, optional=True,
                             tooltip="下一块起点＝上一块终点－重叠像素。必须小于每块切分距离；0 表示不重叠。"),
                _direction_input(),
            ],
            outputs=[io.Image.Output(display_name="预览块", is_output_list=True)],
        )

    @classmethod
    def execute(cls, image, block_height, overlap=0, direction="上下切分"):
        _validate_image(image)
        axis = _split_axis(direction)
        block_height = int(block_height)
        if block_height <= 0:
            raise ValueError("每块切分距离必须大于 0。")
        overlap = int(overlap)
        if not 0 <= overlap < block_height:
            raise ValueError("切分重叠像素必须大于等于 0 且小于每块切分距离。")
        height = image.shape[axis]
        outputs = []
        for frame in image:
            for top in range(0, height, block_height - overlap):
                throw_exception_if_processing_interrupted()
                bottom = min(height, top + block_height)
                crop = _tensor_to_pil(frame.narrow(axis - 1, top, bottom - top))
                outputs.append(_pil_to_tensor(_canvas_with_ruler(crop, height, top, bottom, axis == 2)))
                if bottom == height:
                    break
        return io.NodeOutput(outputs)


class LiuxinyuSplitBoundaryPreview(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuSplitBoundaryPreview",
            display_name="切分检查图（边界放大）",
            category="image/split",
            description=(
                "按切分数组为每个边界生成检查图。上下切分：标尺在左、放大图在顶部；"
                "左右切分：标尺在底部、标尺附近的放大图在左侧，数字保持横向。边界放大范围沿切分方向向两侧延伸。"
                "切分数组只支持 [0.1, 0.2] 或 [{\"percent\": 10}, {\"percent\": 20}]，均表示整张图 10%、20% 的位置。"
            ),
            inputs=[
                io.Image.Input("image", display_name="图片"),
                io.Array.Input("boundaries", display_name="切分数组",
                               tooltip="仅支持数值数组 [0.1, 0.2]（0 < 数值 < 1）或对象数组 [{\"percent\": 10}, {\"percent\": 20}]（0 < percent < 100，name 可选）。位置按整张图及当前切分方向计算，自动补齐两端。"),
                io.Int.Input("crop_margin", display_name="边界放大范围", default=BOUNDARY_CROP_MARGIN, min=50, max=2000),
                _direction_input(),
            ],
            outputs=[io.Image.Output(display_name="检查图", is_output_list=True)],
        )

    @classmethod
    def execute(cls, image, boundaries, crop_margin, direction="上下切分"):
        _validate_image(image)
        horizontal = _split_axis(direction) == 2
        crop_margin = int(crop_margin)
        if crop_margin <= 0:
            raise ValueError("边界放大范围必须大于 0。")
        outputs = []
        for frame in image:
            throw_exception_if_processing_interrupted()
            outputs.extend(cls._preview_image(frame, boundaries, crop_margin, horizontal))
        return io.NodeOutput(outputs)

    @classmethod
    def _preview_image(cls, frame, boundaries, crop_margin, horizontal=False):
        pil = _tensor_to_pil(frame)
        height, width = pil.height, pil.width
        items = _normalize_boundaries(boundaries, width if horizontal else height)
        if horizontal:
            return _horizontal_boundary_previews(pil, items, crop_margin)

        preview_font = _load_font(BOUNDARY_PREVIEW_FONT_SIZE)
        small_font = _load_font(SMALL_FONT_SIZE)
        margin = int(crop_margin)
        outputs = []

        for item in items:
            throw_exception_if_processing_interrupted()
            by = item["position"]
            mag_top = max(0, by - MAG_CROP_HEIGHT // 2)
            mag_bottom = min(height, by + MAG_CROP_HEIGHT // 2)
            mag_crop = pil.crop((0, mag_top, min(MAG_CROP_WIDTH, width), mag_bottom))
            mag_canvas = _canvas_with_ruler(mag_crop, height, mag_top, mag_bottom)
            mag_canvas = mag_canvas.resize(
                (mag_canvas.width * MAG_SCALE, mag_canvas.height * MAG_SCALE),
                Image.Resampling.LANCZOS,
            )
            mag_draw = ImageDraw.Draw(mag_canvas)
            mag_y = (by - mag_top) * MAG_SCALE
            mag_draw.line((RULER_WIDTH * MAG_SCALE, mag_y, mag_canvas.width - 1, mag_y),
                          fill=BOUNDARY_COLOR, width=BOUNDARY_LINE_WIDTH + 1)
            label_big = f'当前 {item["name"]}: {item["percent"]:.3f}%'
            bbox = mag_draw.textbbox((0, 0), label_big, font=preview_font)
            lh = bbox[3] - bbox[1]
            ly = mag_y + 10
            if ly + lh + 10 > mag_canvas.height:
                ly = mag_y - lh - 15
            ly = max(5, min(mag_canvas.height - lh - 10, ly))
            _draw_text_bg(mag_draw, (RULER_WIDTH * MAG_SCALE + 10, ly), label_big,
                          preview_font, BOUNDARY_TEXT_COLOR, WHITE, 6)
            mag_draw.rectangle((0, 0, mag_canvas.width - 1, mag_canvas.height - 1),
                               outline=BORDER_COLOR, width=2)

            top = max(0, by - margin)
            bottom = min(height, by + margin)
            crop = pil.crop((0, top, width, bottom)).convert("RGB")
            canvas = _canvas_with_ruler(crop, height, top, bottom)
            draw = ImageDraw.Draw(canvas)
            cy = by - top
            draw.line((RULER_WIDTH, cy, canvas.width - 1, cy), fill=BOUNDARY_COLOR, width=BOUNDARY_LINE_WIDTH)

            label_small = f'当前 {item["name"]}: {item["percent"]:.3f}% | 原图 Y={by}px'
            bbox = draw.textbbox((0, 0), label_small, font=small_font)
            lh = bbox[3] - bbox[1]
            ly = cy + 4
            if ly + lh + 4 > canvas.height:
                ly = cy - lh - 6
            ly = max(0, min(canvas.height - lh - 4, ly))
            _draw_text_bg(draw, (RULER_WIDTH + 5, ly), label_small, small_font,
                          BOUNDARY_TEXT_COLOR, WHITE, 2)

            for other in items:
                if other["index"] == item["index"]:
                    continue
                if top <= other["position"] < bottom:
                    oy = other["position"] - top
                    draw.line((RULER_WIDTH, oy, canvas.width - 1, oy),
                              fill=REFERENCE_LINE_COLOR, width=REFERENCE_LINE_WIDTH)

            gap = 20
            fw = max(mag_canvas.width, canvas.width)
            fh = mag_canvas.height + gap + canvas.height
            result = Image.new("RGB", (fw, fh), WHITE)
            result.paste(mag_canvas, (0, 0))
            result.paste(canvas, (0, mag_canvas.height + gap))
            outputs.append(_pil_to_tensor(result))

        return outputs


class LiuxinyuSplitSegments(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuSplitSegments",
            display_name="最终切分（按边界）",
            category="image/split",
            description=(
                "按切分数组把长图切成多段，返回纯切图列表，不带标尺和标签，可直接用于下游生成或拼接。"
                "切分数组只支持 [0.1, 0.2] 或 [{\"percent\": 10}, {\"percent\": 20}]，均表示整张图 10%、20% 的位置。"
                "默认从上到下，也可从左到右，自动补齐图像两端。"
            ),
            inputs=[
                io.Image.Input("image", display_name="图片"),
                io.Array.Input("boundaries", display_name="切分数组",
                               tooltip="仅支持数值数组 [0.1, 0.2]（0 < 数值 < 1）或对象数组 [{\"percent\": 10}, {\"percent\": 20}]（0 < percent < 100，name 可选）。位置按整张图及当前切分方向计算，自动补齐两端。"),
                _direction_input(),
            ],
            outputs=[io.Image.Output(display_name="切分结果", is_output_list=True)],
        )

    @classmethod
    def execute(cls, image, boundaries, direction="上下切分"):
        _validate_image(image)
        axis = _split_axis(direction)
        if image.shape[0] == 0:
            return io.NodeOutput([])
        height = image.shape[axis]
        items = _normalize_boundaries(boundaries, height)

        positions = [0] + [it["position"] for it in items] + [height]
        for i in range(len(positions) - 1):
            top, bottom = positions[i], positions[i + 1]
            if bottom <= top:
                raise ValueError(f"第 {i + 1} 段边界无效：{top} -> {bottom}")
        outputs = []
        for index in range(image.shape[0]):
            for top, bottom in zip(positions, positions[1:]):
                throw_exception_if_processing_interrupted()
                outputs.append(image[index:index + 1].narrow(axis, top, bottom - top).clone())
        return io.NodeOutput(outputs)
