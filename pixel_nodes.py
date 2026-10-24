"""Read and edit RGB pixels without mutating upstream images."""

import torch
from comfy_api.latest import io


def _check_image(image, x, y):
    if not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
        raise ValueError("图片须为 [批次, 高度, 宽度, 通道]，支持灰度、RGB、RGBA。")
    if not image.is_floating_point() or image.shape[0] == 0:
        raise ValueError("图片须为非空的浮点 IMAGE 批次。")
    if not 0 <= x < image.shape[2] or not 0 <= y < image.shape[1]:
        raise ValueError(f"X/Y 越界：图片宽 {image.shape[2]}、高 {image.shape[1]}，坐标从 0 开始。")


def _position_inputs():
    return [io.Image.Input("image", display_name="图片"),
            io.Int.Input("x", display_name="X", default=0, min=0),
            io.Int.Input("y", display_name="Y", default=0, min=0)]


class LiuxinyuReadPixel(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuReadPixel", display_name="读取图片像素 RGB",
                         category="image/pixel", inputs=_position_inputs(),
                         description="坐标从 0 开始。逐张读取同一位置，返回 R/G/B 的执行列表（0～255）。忽略透明度；灰度复制为 RGB。",
                         outputs=[io.Int.Output(display_name=c, is_output_list=True) for c in "RGB"])

    @classmethod
    def execute(cls, image, x, y):
        _check_image(image, x, y)
        rgb = image[:, y, x, :3].detach().to(dtype=torch.float32)
        if not torch.isfinite(rgb).all():
            raise ValueError("所选像素包含非有限值。")
        if rgb.shape[-1] == 1:
            rgb = rgb.expand(-1, 3)
        values = (rgb.clamp(0, 1) * 255).round().to(dtype=torch.int64).T.tolist()
        return io.NodeOutput(*values)


class LiuxinyuWritePixel(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuWritePixel", display_name="修改图片像素 RGB",
                         category="image/pixel",
                         description="X/Y/Z 从 0 开始。Z 不连接时修改全部图片的同一位置，连接时仅修改指定图片。保留透明度，灰度图扩展为 RGB；不改变上游图片。",
                         inputs=_position_inputs() + [
                             io.Int.Input(c.lower(), display_name=c, default=0, min=0, max=255) for c in "RGB"
                         ] + [io.Int.Input("z", display_name="Z（可选图片索引）", optional=True, force_input=True, min=0)],
                         outputs=[io.Image.Output(display_name="图片")])

    @classmethod
    def execute(cls, image, x, y, r, g, b, z=None):
        _check_image(image, x, y)
        if z is not None and not 0 <= z < image.shape[0]:
            raise ValueError(f"Z 越界：图片批次共 {image.shape[0]} 张，索引从 0 开始。")
        if any(isinstance(c, bool) or not isinstance(c, int) or not 0 <= c <= 255 for c in (r, g, b)):
            raise ValueError("RGB 必须是 0～255 的整数。")
        result = image.expand(-1, -1, -1, 3).clone() if image.shape[-1] == 1 else image.clone()
        result[slice(None) if z is None else z, y, x, :3] = result.new_tensor([r / 255, g / 255, b / 255])
        return io.NodeOutput(result)
