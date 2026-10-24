"""预览超长图片节点后端。"""

import uuid

import torch
from PIL import Image

from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted
from liuxinyu_cache import cached_preview, preview_path


TILE_SIZE = 1024


def save_display_previews(image, stem, original_name, scroll_direction, tall_scroll_direction):
    """Bound browser decoding to thumbnail / visible tile sizes; retain the original."""
    width, height = image.size
    crop_width = min(width, max(1, round(height * 16 / 9)))
    crop_height = min(height, max(1, round(width * 16 / 9)))
    left = width - crop_width if scroll_direction == "从右向左" else 0
    top = height - crop_height if tall_scroll_direction == "从下到上" else 0
    crop = image.crop((left, top, left + crop_width, top + crop_height))
    thumbnails = []
    for edge in sorted({192, 768, 1536, max(crop.size)}):
        thumb = crop.copy()
        thumb.thumbnail((edge, edge), Image.Resampling.LANCZOS, reducing_gap=3)
        name = f"{stem}_thumb_{edge}.png"
        thumb.save(preview_path(name), format="PNG", compress_level=1)
        thumbnails.append({"filename": name, "width": thumb.width, "height": thumb.height})
        if max(crop.size) <= edge:
            break

    levels = []
    level_image = image
    while True:
        throw_exception_if_processing_interrupted()
        level = {"width": level_image.width, "height": level_image.height, "tile_size": TILE_SIZE}
        if max(level_image.size) <= TILE_SIZE:
            name = original_name if level_image is image else f"{stem}_overview.png"
            if level_image is not image:
                level_image.save(preview_path(name), format="PNG", compress_level=1)
            level["filename"] = name
            levels.append(level)
            break
        prefix = f"{stem}_level_{len(levels)}_"
        level["prefix"] = prefix
        for y in range(0, level_image.height, TILE_SIZE):
            for x in range(0, level_image.width, TILE_SIZE):
                throw_exception_if_processing_interrupted()
                tile = level_image.crop((x, y, min(x + TILE_SIZE, level_image.width),
                                        min(y + TILE_SIZE, level_image.height)))
                tile.save(preview_path(f"{prefix}{y // TILE_SIZE}_{x // TILE_SIZE}.png"),
                          format="PNG", compress_level=1)
        levels.append(level)
        level_image = level_image.resize((max(1, (level_image.width + 1) // 2),
                                          max(1, (level_image.height + 1) // 2)), Image.Resampling.LANCZOS)
    return {"thumbnails": thumbnails, "levels": levels}


class LiuxinyuPreviewLongImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPreviewLongImage",
            display_name="预览超长图片",
            category="image/preview",
            is_output_node=True,
            is_input_list=True,
            description=(
                "接收图像批次并展示缩略图。长图或宽图会截取最开头的16:9或9:16区域，"
                "并用渐变暗示剩余内容。点击缩略图可进入单图查看，支持鼠标滚轮滚动、"
                "键盘左右方向键切换批次。按输入像素尺寸生成无损 PNG 预览，"
                "保留原始像素和透明通道；网格使用小尺寸预览，单图按可见区域分块加载，缩放时按显示尺寸选择清晰度。"
            ),
            inputs=[
                io.Image.Input("image", display_name="图片"),
                io.Combo.Input(
                    "scroll_direction",
                    display_name="超宽图查看方向",
                    options=["从左向右", "从右向左"],
                    default="从左向右",
                    tooltip="定义超宽图片的查看起点。从左向右：左侧为起点，右侧为终点（底部）；从右向左：右侧为起点，左侧为终点。",
                ),
                io.Combo.Input(
                    "tall_scroll_direction",
                    display_name="超高图查看方向",
                    options=["从上到下", "从下到上"],
                    default="从上到下",
                    tooltip="定义超高图片的查看起点。从上到下：顶部为起点，底部为终点；从下到上：底部为起点，顶部为终点。",
                ),
            ],
            outputs=[],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, image, scroll_direction, tall_scroll_direction):
        result = cached_preview("LiuxinyuPreviewLongImage", dict(
            image=image, scroll_direction=scroll_direction, tall_scroll_direction=tall_scroll_direction,
        ), cls._render)
        return io.NodeOutput(ui=result["ui"])

    @classmethod
    def _render(cls, image, scroll_direction, tall_scroll_direction):
        if not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
            raise ValueError("图片必须是 IMAGE 张量 [B, H, W, C]，不能缺少批次维度；请检查上游节点。")
        if image.shape[1] <= 0 or image.shape[2] <= 0:
            raise ValueError("图片宽度和高度必须大于 0。")
        batch_size = image.shape[0]
        ui_images = []
        session_id = uuid.uuid4().hex

        for i in range(batch_size):
            throw_exception_if_processing_interrupted()
            # 在 GPU 上完成乘 255、截断、转 uint8，再传到 CPU，减少 4 倍数据量
            tensor = image[i]
            if tensor.is_cuda:
                pixels = (tensor * 255.0).clamp(0, 255).to(torch.uint8).cpu().numpy()
            else:
                pixels = (tensor * 255.0).clamp(0, 255).to(torch.uint8).numpy()
            if pixels.shape[-1] == 1:
                pixels = pixels[..., 0]
            img = Image.fromarray(pixels)

            preview_name = f"liuxinyu_long_preview_{session_id}_{i:04d}.png"
            img.save(preview_path(preview_name), format="PNG", compress_level=1)
            display = save_display_previews(img, preview_name[:-4], preview_name,
                                            scroll_direction, tall_scroll_direction)

            ui_images.append({
                "filename": preview_name,
                "subfolder": "",
                "type": "temp",
                "preview_size": [img.width, img.height],
                "display": display,
            })

        ui_payload = {
            "images": ui_images,
            "scroll_direction": [scroll_direction],
            "tall_scroll_direction": [tall_scroll_direction],
        }

        return {"ui": ui_payload}
