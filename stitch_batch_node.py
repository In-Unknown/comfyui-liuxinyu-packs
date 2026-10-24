"""将 IMAGE 列表中的全部批次按方向拼接为长图。"""

import torch
import torch.nn.functional as F

from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted


class LiuxinyuStitchImageBatchList(io.ComfyNode):
    # PNG specification, libjpeg JPEG_MAX_DIMENSION, WebP WEBP_MAX_DIMENSION.
    FORMAT_LIMITS = {"PNG": 2147483647, "JPEG": 65500, "WebP": 16383}

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStitchImageBatchList",
            display_name="从批次列表拼接图片",
            category="image/compositing",
            is_input_list=True,
            description=(
                "一次接收 IMAGE 列表，按列表顺序、各批次内部顺序展开全部图片。"
                "横向拼接时等比例放大到所有图片中的最大高度，纵向拼接时等比例放大到最大宽度，"
                "像素尺寸四舍五入。不裁剪、不留间隔；反向拼接只反转排列顺序，不翻转图片。"
                "超出目标格式允许的单边像素长度时沿拼接方向连续切分，不丢失像素。"
                "输出为批次列表，每个批次只有一张图，最后一段可以较短；"
                "分段按最终画面的从左到右或从上到下顺序输出。"
                "目标格式仅控制分段上限，不保存或编码图片，保存格式仍由下游决定。"
                "格式尺寸上限不保证内存足够，PNG 尤其可能先达到内存或编码器的限制。"
            ),
            inputs=[
                io.Image.Input("images", display_name="图片",
                               tooltip="普通 IMAGE 接口，既支持单张图片、单个批次，也支持多个批次的列表。"),
                io.Combo.Input("direction", display_name="拼接方向",
                               options=["从左到右", "从右到左", "从上到下", "从下到上"],
                               default="从左到右"),
                io.Combo.Input("target_format", display_name="目标格式",
                               options=list(cls.FORMAT_LIMITS), default="PNG",
                               tooltip="仅用于分段：PNG 最大单边 2147483647，JPEG 65500，WebP 16383 像素。"),
            ],
            outputs=[io.Image.Output(display_name="拼接图片", is_output_list=True)],
        )

    @classmethod
    def execute(cls, images, direction, target_format):
        if len(direction) != 1 or len(target_format) != 1:
            raise ValueError("拼接方向和目标格式各需要一个值，以便将全部输入合成同一组长图。")
        direction = direction[0]
        limit = cls.FORMAT_LIMITS[target_format[0]]
        horizontal = direction in ("从左到右", "从右到左")
        reverse = direction in ("从右到左", "从下到上")
        axis = 2 if horizontal else 1
        cross_axis = 1 if horizontal else 2
        batches = [batch for batch in images if batch.shape[0] > 0]
        if not batches:
            return io.NodeOutput([])

        cross_size = max(batch.shape[cross_axis] for batch in batches)
        if cross_size > limit:
            raise ValueError(
                f"统一后的{'高度' if horizontal else '宽度'}为 {cross_size} 像素，超过 "
                f"{target_format[0]} 的单边上限 {limit}；仅沿拼接方向切分无法满足该格式，请换用目标格式。"
            )
        channels = max(batch.shape[-1] for batch in batches)
        frames = []
        for batch in batches:
            # Integer rounding avoids floating-point error for large dimensions.
            length = max(1, (batch.shape[axis] * cross_size * 2 + batch.shape[cross_axis])
                         // (2 * batch.shape[cross_axis]))
            frames.extend((batch, index, length) for index in range(batch.shape[0]))
        if reverse:
            frames.reverse()
        remaining = sum(length for _, _, length in frames)

        # 分段只减小单次分配，不减少总量；先估算总输出大小，避免跑到一半 OOM
        total_elements = remaining * cross_size * channels
        total_bytes = total_elements * 4  # float32，每元素 4 字节
        try:
            if batches[0].is_cuda:
                free_bytes, _ = torch.cuda.mem_get_info(batches[0].device)
                device_label = "显存"
            else:
                import psutil
                free_bytes = psutil.virtual_memory().available
                device_label = "内存"
        except Exception:
            free_bytes = None
            device_label = "内存"
        if free_bytes is not None and total_bytes > free_bytes * 0.6:
            raise ValueError(
                f"拼接结果需要约 {total_bytes / 1024**3:.1f} GB {device_label}，"
                f"当前可用约 {free_bytes / 1024**3:.1f} GB，无法完成。"
                f"分段只影响单次分配，不减少总量。请减少输入图片数量，"
                f"或在拼接前降低图片分辨率。"
            )

        outputs = []
        chunk = None
        filled = 0
        for batch, index, length in frames:
            throw_exception_if_processing_interrupted()
            image = batch[index:index + 1]
            height, width = (cross_size, length) if horizontal else (length, cross_size)
            if image.shape[1:3] != (height, width):
                image = F.interpolate(
                    image.movedim(-1, 1), size=(height, width),
                    mode="bilinear", align_corners=False,
                ).movedim(1, -1)
            if image.shape[-1] < channels:
                image = F.pad(image, (0, channels - image.shape[-1]), value=1.0)
            offset = 0
            while offset < length:
                throw_exception_if_processing_interrupted()
                if chunk is None:
                    chunk_length = min(limit, remaining)
                    shape = (1, cross_size, chunk_length, channels) if horizontal else (
                        1, chunk_length, cross_size, channels)
                    chunk = batches[0].new_empty(shape)
                    filled = 0
                take = min(length - offset, chunk.shape[axis] - filled)
                chunk.narrow(axis, filled, take).copy_(image.narrow(axis, offset, take))
                filled += take
                offset += take
                remaining -= take
                if filled == chunk.shape[axis]:
                    outputs.append(chunk)
                    chunk = None
        return io.NodeOutput(outputs)
