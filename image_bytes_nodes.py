"""Explicit tensor, encoded image and generic byte conversions."""
from pathlib import Path

import numpy as np
import torch
from comfy_api.latest import io
from liuxinyu_cache import file_changes
from liuxinyu_image_bytes import IMAGE_BYTES, BYTES, format_input, tensor_frames, validate_bytes, decode_frames, encode_frame


class LiuxinyuEncodeImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuEncodeImage", display_name="图像张量编码为图像字节", category="image/encoding",
            description="逐张把图像张量编码成指定格式的 IMAGE_BYTES，可直接接 Harness 图片口。格式切换时显示对应参数；不缩放图片。PNG交错和透明度是独立选项。",
            inputs=[io.Image.Input("image", display_name="图像"), format_input(),
                    io.Mask.Input("mask", display_name="透明遮罩", optional=True, tooltip="可选，遵循ComfyUI规则：1为透明，0为不透明。与图片宽高一致；单张遮罩广播，多张须与批次数一致，覆盖原Alpha。")],
            outputs=[IMAGE_BYTES.Output(display_name="图像字节", is_output_list=True)])

    @classmethod
    def execute(cls, image, format, mask=None):
        frames = list(tensor_frames(image))
        if mask is not None:
            if not isinstance(mask, torch.Tensor) or mask.ndim not in (2, 3):
                raise ValueError("透明遮罩必须为 [H,W] 或 [B,H,W] MASK 张量。")
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
            if len(mask) not in (1, len(frames)) or tuple(mask.shape[1:]) != (frames[0].height, frames[0].width):
                raise ValueError("透明遮罩尺寸须与图像一致，数量须为1或与图像批次一致。")
            from PIL import Image
            for index, frame in enumerate(frames):
                alpha = mask[min(index, len(mask) - 1)].detach().float().cpu().numpy()
                if not np.isfinite(alpha).all():
                    raise ValueError("透明遮罩包含 NaN 或无穷大。")
                frame = frame.convert("RGBA")
                frame.putalpha(Image.fromarray(np.rint((1 - np.clip(alpha, 0, 1)) * 255).astype(np.uint8)))
                frames[index] = frame
        return io.NodeOutput([encode_frame(frame, format) for frame in frames])


class LiuxinyuTranscodeImageBytes(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuTranscodeImageBytes", display_name="图像字节转码", category="image/encoding",
            description="解码后按目标格式和参数重新编码，即使格式相同也会重新编码。多帧逐帧输出执行列表，不保留动画时序；需要同格式原样保留请使用字节提取节点。",
            inputs=[IMAGE_BYTES.Input("data", display_name="图像字节"), format_input()],
            outputs=[IMAGE_BYTES.Output(display_name="图像字节", is_output_list=True)])

    @classmethod
    def execute(cls, data, format):
        return io.NodeOutput([encode_frame(frame, format) for frame in decode_frames(data)])


class LiuxinyuDecodeImageBytes(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuDecodeImageBytes", display_name="图像字节解码为图像", category="image/encoding",
            description="验证图像字节后逐帧恢复普通RGB IMAGE及透明遮罩（1透明、0不透明），按EXIF纠正方向。不同尺寸按执行列表输出，每项批次为1。",
            inputs=[IMAGE_BYTES.Input("data", display_name="图像字节")],
            outputs=[io.Image.Output(display_name="图像", is_output_list=True), io.Mask.Output(display_name="透明遮罩", is_output_list=True)])

    @classmethod
    def execute(cls, data):
        images, masks = [], []
        for frame in decode_frames(data):
            rgba = np.asarray(frame.convert("RGBA"), dtype=np.float32) / 255
            images.append(torch.from_numpy(rgba[:, :, :3].copy()).unsqueeze(0))
            masks.append(torch.from_numpy(1 - rgba[:, :, 3]).unsqueeze(0))
        return io.NodeOutput(images, masks)


class LiuxinyuLoadFileBytes(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuLoadFileBytes", display_name="从路径加载字节数据", category="utils/file",
            description="读取任意本地文件的原始BYTES，不判断内容类型、不解码。支持选择文件按钮，内容变化后重新读取。需要图片字节时连接提取节点验证。",
            inputs=[io.String.Input("path", display_name="文件路径", default="", multiline=False)],
            outputs=[BYTES.Output(display_name="字节数据")])

    @classmethod
    def fingerprint_inputs(cls, path):
        return file_changes.fingerprint("LiuxinyuLoadFileBytes", path)

    @classmethod
    def execute(cls, path):
        file_changes.remember("LiuxinyuLoadFileBytes", path)
        filename = Path(path.strip())
        if not filename.is_absolute() or not filename.is_file():
            raise ValueError("请选择存在的文件，并使用绝对路径。")
        return io.NodeOutput(filename.read_bytes())


class LiuxinyuExtractImageBytes(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuExtractImageBytes", display_name="字节数据提取图像字节", category="image/encoding",
            description="验证任意BYTES确实是可完整解码的图像。格式一致时原字节直接输出，忽略编码参数；格式不一致时按参数转码。不是从压缩包或任意文件中搜索图片。多帧跨格式逐帧输出。",
            inputs=[io.MultiType.Input("data", types=[BYTES, IMAGE_BYTES], display_name="字节数据"), format_input()],
            outputs=[IMAGE_BYTES.Output(display_name="图像字节", is_output_list=True)])

    @classmethod
    def execute(cls, data, format):
        if validate_bytes(data) == format["format"]:
            return io.NodeOutput([data])
        return io.NodeOutput([encode_frame(frame, format) for frame in decode_frames(data)])
