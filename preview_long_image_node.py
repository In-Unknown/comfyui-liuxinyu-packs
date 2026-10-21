"""预览超长图片节点后端。"""

import os
import uuid
from pathlib import Path

import numpy as np
import torch
from PIL import Image
import folder_paths

from comfy_api.latest import io


class LiuxinyuPreviewLongImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPreviewLongImage",
            display_name="预览超长图片",
            category="image/preview",
            is_output_node=True,
            description=(
                "接收图像批次并展示缩略图。长图或宽图会截取最开头的16:9或9:16区域，"
                "并用渐变暗示剩余内容。点击缩略图可进入单图查看，支持鼠标滚轮滚动、"
                "键盘左右方向键切换批次。"
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
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, image, scroll_direction):
        temp_dir = Path(folder_paths.get_temp_directory())
        temp_dir.mkdir(parents=True, exist_ok=True)

        batch_size = image.shape[0]
        ui_images = []
        session_id = uuid.uuid4().hex

        for i in range(batch_size):
            pixels = np.clip(image[i].detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
            img = Image.fromarray(pixels)
            
            preview_name = f"liuxinyu_long_preview_{session_id}_{i:04d}.jpg"
            # 改用 JPEG 格式，大幅提升长图的保存速度
            img.save(temp_dir / preview_name, format="JPEG", quality=90)
            
            ui_images.append({
                "filename": preview_name,
                "subfolder": "",
                "type": "temp",
            })

        return io.NodeOutput(ui={"images": ui_images, "scroll_direction": [scroll_direction]})
