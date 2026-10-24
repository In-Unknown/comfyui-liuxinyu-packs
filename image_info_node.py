"""逐张统计 IMAGE 的 8 位 RGB 颜色及加权灰度信息。"""

import numpy as np
import torch

from comfy_api.latest import io


_CHUNK_PIXELS = 1 << 20


def _image_stats(frame):
    height, width, channels = frame.shape
    # 按行分块；颜色占用表和灰度直方图的大小不随长图长度增长。
    seen_colors = np.zeros(1 << 24, dtype=np.bool_)
    brightness_counts = np.zeros(255001, dtype=np.int64)
    channel_min = np.full(3, 255, dtype=np.uint8)
    channel_max = np.zeros(3, dtype=np.uint8)
    rows_per_chunk = max(1, _CHUNK_PIXELS // width)

    for start in range(0, height, rows_per_chunk):
        values = frame[start:start + rows_per_chunk, :, :3].detach().to(
            device="cpu", dtype=torch.float32).numpy()
        if not np.isfinite(values).all():
            raise ValueError("图片包含 NaN 或无穷大，无法统计颜色和明度。")
        rgb = np.rint(np.clip(values, 0.0, 1.0) * 255.0).astype(np.uint8)
        rgb = rgb.reshape(-1, min(channels, 3))
        if channels == 1:
            rgb = np.repeat(rgb, 3, axis=1)
        channel_min = np.minimum(channel_min, rgb.min(axis=0))
        channel_max = np.maximum(channel_max, rgb.max(axis=0))
        rgb = rgb.astype(np.int32)
        packed = (rgb[:, 0] << 16) | (rgb[:, 1] << 8) | rgb[:, 2]
        seen_colors[packed] = True
        # 用整数保存灰度的千分之一，避免浮点误差和整张长图的排序副本。
        brightness = 299 * rgb[:, 0] + 587 * rgb[:, 1] + 114 * rgb[:, 2]
        brightness_counts += np.bincount(brightness, minlength=255001)

    occupied = np.flatnonzero(brightness_counts)
    pixel_count = width * height
    middle = np.searchsorted(brightness_counts.cumsum(),
                             [(pixel_count - 1) // 2 + 1, pixel_count // 2 + 1])
    return (
        width, height, int(np.count_nonzero(seen_colors)),
        float(middle.sum()) / 2000.0, float(occupied[-1]) / 1000.0,
        float(occupied[0]) / 1000.0,
        int(channel_max[0]), int(channel_min[0]),
        int(channel_max[1]), int(channel_min[1]),
        int(channel_max[2]), int(channel_min[2]),
    )


class LiuxinyuImageInfo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuImageInfo",
            display_name="图片信息节点",
            category="image/analysis",
            search_aliases=["图片信息", "图片尺寸", "颜色数量", "明度", "image info"],
            description=(
                "逐张统计图片宽高、不同 RGB 颜色数、明度中位数及极值、RGB 通道极值。"
                "像素限幅到 0～1，乘 255 后取最近整数（半整数取偶数）；忽略透明度，灰度图按 RGB 同值处理。"
                "明度 = 0.299R + 0.587G + 0.114B，范围 0～255；偶数个像素取中间两值的平均值。"
                "批次及执行列表均逐张统计，各输出按图片顺序给出数值列表，单张图片给出一项。"
            ),
            inputs=[io.Image.Input("image", display_name="图片", tooltip="IMAGE 张量，支持单张、批次和执行列表。")],
            outputs=[
                io.Int.Output("width", display_name="宽度", is_output_list=True),
                io.Int.Output("height", display_name="高度", is_output_list=True),
                io.Int.Output("color_count", display_name="色彩数", is_output_list=True,
                              tooltip="8 位 RGB 中不同颜色的数量；透明度不参与区分。"),
                io.Float.Output("brightness_median", display_name="明度中位数", is_output_list=True),
                io.Float.Output("brightness_max", display_name="明度最高值", is_output_list=True),
                io.Float.Output("brightness_min", display_name="明度最低值", is_output_list=True),
                io.Int.Output("r_max", display_name="R 明度最高值", is_output_list=True),
                io.Int.Output("r_min", display_name="R 明度最低值", is_output_list=True),
                io.Int.Output("g_max", display_name="G 明度最高值", is_output_list=True),
                io.Int.Output("g_min", display_name="G 明度最低值", is_output_list=True),
                io.Int.Output("b_max", display_name="B 明度最高值", is_output_list=True),
                io.Int.Output("b_min", display_name="B 明度最低值", is_output_list=True),
            ],
        )

    @classmethod
    def execute(cls, image):
        if not isinstance(image, torch.Tensor):
            raise ValueError("图片输入必须是 IMAGE 张量。")
        if image.ndim == 3:
            image = image.unsqueeze(0)
        if image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
            raise ValueError("图片格式应为 [批次, 高度, 宽度, 通道]，支持 1、3 或 4 通道。")
        if any(size == 0 for size in image.shape):
            raise ValueError("图片批次、宽度和高度不能为空。")
        outputs = [[] for _ in range(12)]
        for frame in image:
            for output, value in zip(outputs, _image_stats(frame)):
                output.append(value)
        return io.NodeOutput(*outputs)
