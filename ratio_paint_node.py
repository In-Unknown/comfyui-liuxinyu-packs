"""Keep native Mask Editor paint and mask layers over changing upstream images."""

import re
import time
import uuid
from pathlib import Path

import numpy as np
import torch
from PIL import Image

import folder_paths
from comfy_api.latest import io
from liuxinyu_cache import file_changes


def editor_paths(reference):
    if not reference:
        return []
    root = Path(folder_paths.get_input_directory()).resolve()
    name = reference.removesuffix(" [input]").strip()
    path = (root / name).resolve()
    if not path.is_relative_to(root):
        raise ValueError("编辑图层必须位于 ComfyUI 的 input 目录内。")
    match = re.fullmatch(r"clipspace-painted-masked-(\d+)\.png", path.name)
    if not match:
        raise ValueError("请先运行节点，再使用官方遮罩编辑器绘制并保存。")
    stamp = match.group(1)
    masked = path.with_name(f"clipspace-mask-{stamp}.png")
    painted = path.with_name(f"clipspace-paint-{stamp}.png")
    if not masked.resolve().is_relative_to(root) or not painted.resolve().is_relative_to(root):
        raise ValueError("编辑图层路径无效。")
    return [masked, painted]


def editor_layers(reference):
    masked, painted = editor_paths(reference)
    if not masked.is_file() or not painted.is_file():
        raise ValueError("保存的蒙版或画笔图层文件不存在，请恢复 input 中的编辑文件。")
    with Image.open(masked) as source:
        alpha = source.convert("RGBA").getchannel("A")
    with Image.open(painted) as source:
        paint = source.convert("RGBA")
    if alpha.size != paint.size:
        raise ValueError("蒙版与画笔图层尺寸不一致，请重新保存编辑结果。")
    return alpha, paint


def save_editor_bundle(base, paint, keep_alpha):
    # Native Mask Editor recognizes these four companion names and reloads
    # the unpainted RGB, editable paint, and mask as separate layers.
    subfolder = Path("liuxinyu_ratio_paint") / uuid.uuid4().hex
    directory = Path(folder_paths.get_input_directory()) / subfolder
    directory.mkdir(parents=True, exist_ok=True)
    stamp = int(time.time() * 1000)
    masked = base.convert("RGBA")
    masked.putalpha(keep_alpha)
    masked.save(directory / f"clipspace-mask-{stamp}.png")
    paint.save(directory / f"clipspace-paint-{stamp}.png")
    combined = Image.alpha_composite(base.convert("RGBA"), paint)
    combined.save(directory / f"clipspace-painted-{stamp}.png")
    combined.putalpha(keep_alpha)
    filename = f"clipspace-painted-masked-{stamp}.png"
    combined.save(directory / filename)
    return {"filename": filename, "subfolder": subfolder.as_posix(), "type": "input"}


class LiuxinyuRatioPaint(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuRatioPaint",
            display_name="绘制蒙版绘制画笔于比例图像",
            category="image/editing",
            search_aliases=["绘制蒙版", "画笔", "比例图像", "ratio paint", "mask editor"],
            description=(
                "接收上游图像。点击打开遮罩编辑器时，先运行所需上游至本节点，更新预览后自动打开官方编辑器；绘制并保存后再次运行以输出编辑结果。"
                "宽高比相同时，保留并等比缩放独立画笔和蒙版，覆盖到最新底图上；可重新打开编辑器继续绘制和擦除。"
                "比例变化时启用空白图层，之前的图层文件保留。批次中的所有图片共用同一组图层，预览第一张。"
                "IMAGE 输出包含彩色笔迹，MASK 输出绘制区域为白色1，未绘制区域为黑色0。"
            ),
            inputs=[
                io.Image.Input("pixels", display_name="输入图像"),
                io.String.Input("image", default="", advanced=True),
            ],
            outputs=[
                io.Image.Output(display_name="图像"),
                io.Mask.Output(display_name="蒙版"),
            ],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, pixels=None, image=""):
        return file_changes.fingerprint("LiuxinyuRatioPaint", image, editor_paths)

    @classmethod
    def execute(cls, pixels, image=""):
        file_changes.remember("LiuxinyuRatioPaint", image, editor_paths)
        if pixels.shape[0] == 0:
            raise ValueError("输入图像批次不能为空。")
        height, width = pixels.shape[1:3]
        keep_alpha = Image.new("L", (width, height), 255)
        paint = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        status = "请打开遮罩编辑器绘制并保存，再次运行以输出编辑结果。"
        if image:
            saved_alpha, saved_paint = editor_layers(image)
            old_width, old_height = saved_alpha.size
            if old_width * height == width * old_height:
                keep_alpha = saved_alpha.resize((width, height), Image.Resampling.BILINEAR)
                paint = saved_paint.resize((width, height), Image.Resampling.LANCZOS)
                status = "同宽高比：已保留画笔与蒙版，可继续打开遮罩编辑器修改。"
            else:
                status = "图像比例已变化：当前使用空白图层，旧图层文件仍保留。"

        overlay = torch.from_numpy(np.array(paint, dtype=np.float32) / 255.0).to(pixels)
        opacity = overlay[..., 3:4]
        result = pixels[..., :3] * (1 - opacity) + overlay[..., :3] * opacity
        mask = torch.from_numpy(1 - np.array(keep_alpha, dtype=np.float32) / 255.0).to(pixels)
        masks = mask.unsqueeze(0).repeat(pixels.shape[0], 1, 1)
        base = Image.fromarray((pixels[0, ..., :3].detach().cpu().clamp(0, 1).numpy() * 255).round().astype(np.uint8))
        ref = save_editor_bundle(base, paint, keep_alpha)
        reference = f"{ref['subfolder']}/{ref['filename']} [input]"
        return io.NodeOutput(result, masks, ui={
            "images": [ref],
            "editor_image": [reference],
            "editor_source": [image],
            "text": [status],
        })
