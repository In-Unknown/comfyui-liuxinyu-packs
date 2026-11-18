"""Encoded image values, format options and lossless byte pass-through."""
from io import BytesIO
from pathlib import Path
import struct
import zlib

import numpy as np
import torch
from PIL import Image, ImageOps, features
from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted

IMAGE_BYTES = io.Custom("IMAGE_BYTES")
BYTES = io.Custom("BYTES")
EXTENSIONS = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".webp": "WEBP",
              ".bmp": "BMP", ".tif": "TIFF", ".tiff": "TIFF", ".gif": "GIF", ".avif": "AVIF"}


def format_input():
    def alpha():
        return [io.Boolean.Input("alpha", display_name="保留透明度", default=True), background()]

    def background():
        return io.Combo.Input("background", display_name="去透明背景", options=["白色", "黑色"], default="白色",
                              tooltip="目标不支持透明或关闭保留透明度时，先与此背景合成；不会把黑色当成透明。")

    def quality():
        return io.Int.Input("quality", display_name="质量", default=95, min=1, max=100)

    options = [
        io.DynamicCombo.Option("PNG", [io.Int.Input("compression", display_name="压缩等级", default=6, min=0, max=9,
            tooltip="仅影响体积与编码耗时，不改变像素质量。"), io.Boolean.Input("interlace", display_name="交错扫描", default=False,
            tooltip="Adam7 渐进显示，与透明度无关。"), *alpha()]),
        io.DynamicCombo.Option("JPEG", [quality(), io.Combo.Input("subsampling", display_name="色度采样",
            options=["4:4:4", "4:2:2", "4:2:0"], default="4:4:4"),
            io.Boolean.Input("progressive", display_name="渐进式", default=False),
            io.Boolean.Input("optimize", display_name="优化编码", default=True), background()]),
        io.DynamicCombo.Option("WEBP", [quality(), io.Boolean.Input("lossless", display_name="无损", default=False),
            io.Int.Input("method", display_name="压缩力度", default=4, min=0, max=6), *alpha()]),
        io.DynamicCombo.Option("BMP", [background()]),
        io.DynamicCombo.Option("TIFF", [io.Combo.Input("compression", display_name="压缩方式",
            options=["无压缩", "LZW", "Deflate"], default="Deflate"), *alpha()]),
        io.DynamicCombo.Option("GIF", [io.Int.Input("colors", display_name="颜色数", default=256, min=2, max=256),
            io.Boolean.Input("dither", display_name="抖动", default=True), *alpha()]),
    ]
    if features.check("avif"):
        options.append(io.DynamicCombo.Option("AVIF", [quality(), io.Int.Input("speed", display_name="编码速度", default=6, min=0, max=10), *alpha()]))
    return io.DynamicCombo.Input("format", display_name="图像格式", options=options,
                                 tooltip="更换格式后仅显示该编码支持的参数。PNG/TIFF无损；JPEG即使质量100也不是无损。")


def validate_bytes(data):
    if not isinstance(data, bytes):
        raise TypeError("必须输入不可变 bytes 文件字节，不接受路径、Base64 文本、字典或 bytearray。")
    if not data:
        raise ValueError("图像字节不能为空。")
    with Image.open(BytesIO(data)) as image:
        image.verify()
    # JPEG's verify() does not decode the scan data. Load every page/frame too.
    with Image.open(BytesIO(data)) as image:
        fmt = image.format
        for index in range(getattr(image, "n_frames", 1)):
            throw_exception_if_processing_interrupted()
            image.seek(index)
            image.load()
    return fmt


def decode_frames(data):
    validate_bytes(data)
    with Image.open(BytesIO(data)) as image:
        for index in range(getattr(image, "n_frames", 1)):
            throw_exception_if_processing_interrupted()
            image.seek(index)
            yield ImageOps.exif_transpose(image).convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")


def tensor_frames(image):
    if not isinstance(image, torch.Tensor) or image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
        raise ValueError("IMAGE 必须是 [B,H,W,C] 张量，通道数为1、3或4。")
    if any(size == 0 for size in image.shape):
        raise ValueError("图像批次及宽高不能为空。")
    for frame in image:
        throw_exception_if_processing_interrupted()
        values = frame.detach().to(device="cpu", dtype=torch.float32).numpy()
        if not np.isfinite(values).all():
            raise ValueError("图像包含 NaN 或无穷大。")
        pixels = np.rint(np.clip(values, 0, 1) * 255).astype(np.uint8)
        yield Image.fromarray(pixels[:, :, 0] if pixels.shape[-1] == 1 else pixels)


def _png_interlaced(image, compression):
    """8-bit RGB/RGBA Adam7; Pillow's PNG writer ignores interlace=True."""
    pixels = np.asarray(image)
    compressor = zlib.compressobj(compression)
    compressed = []
    for x, y, dx, dy in ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
                          (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)):
        for row in pixels[y::dy, x::dx]:
            if row.size:
                throw_exception_if_processing_interrupted()
                compressed.append(compressor.compress(b"\0" + row.tobytes()))
    compressed.append(compressor.flush())

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", image.width, image.height, 8, 6 if image.mode == "RGBA" else 2, 0, 0, 1)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", b"".join(compressed)) + chunk(b"IEND", b"")


def encode_frame(image, config):
    fmt = config["format"]
    if fmt not in set(EXTENSIONS.values()):
        raise ValueError(f"不支持的图像格式：{fmt}")
    has_alpha = "A" in image.getbands() or "transparency" in image.info
    if has_alpha and (fmt in ("JPEG", "BMP") or not config.get("alpha", True)):
        rgba = image.convert("RGBA")
        bg = (255, 255, 255) if config.get("background", "白色") == "白色" else (0, 0, 0)
        image = Image.new("RGB", image.size, bg)
        image.paste(rgba, mask=rgba.getchannel("A"))
    else:
        image = image.convert("RGBA" if has_alpha else "RGB")
    params = {}
    if fmt == "PNG":
        params["compress_level"] = int(config.get("compression", 6))
        if config.get("interlace", False):
            return _png_interlaced(image, params["compress_level"])
    elif fmt == "JPEG":
        params = dict(quality=int(config.get("quality", 95)),
                      subsampling={"4:4:4": 0, "4:2:2": 1, "4:2:0": 2}[config.get("subsampling", "4:4:4")],
                      progressive=bool(config.get("progressive", False)), optimize=bool(config.get("optimize", True)))
    elif fmt == "WEBP":
        params = dict(quality=int(config.get("quality", 95)), lossless=bool(config.get("lossless", False)),
                      method=int(config.get("method", 4)), exact=True)
    elif fmt == "TIFF":
        params["compression"] = {"无压缩": "raw", "LZW": "tiff_lzw", "Deflate": "tiff_adobe_deflate"}[config.get("compression", "Deflate")]
    elif fmt == "AVIF":
        params = dict(quality=int(config.get("quality", 95)), speed=int(config.get("speed", 6)))
    elif fmt == "GIF":
        colors = int(config.get("colors", 256))
        alpha = image.getchannel("A") if image.mode == "RGBA" else None
        rgb = image.convert("RGB")
        palette = rgb.quantize(colors=colors - 1 if alpha is not None else colors)
        # Quantize the original pixels, not the already reduced palette image.
        image = rgb.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG
                             if config.get("dither", True) else Image.Dither.NONE)
        # Reserve one palette entry for binary transparency; GIF has no partial alpha.
        if alpha is not None:
            image.paste(colors - 1, mask=alpha.point(lambda value: 255 if value < 128 else 0))
            params["transparency"] = colors - 1
        params["optimize"] = False
    buffer = BytesIO()
    image.save(buffer, format=fmt, **params)
    return buffer.getvalue()


def save_encoded(data, target, extension):
    target_format = EXTENSIONS.get(extension.lower())
    if target_format is None:
        raise ValueError(f"不支持的图像扩展名：{extension}")
    if validate_bytes(data) == target_format:
        Path(target).write_bytes(data)
        return
    frames = list(decode_frames(data))
    if len(frames) != 1:
        raise ValueError("多帧图像跨格式保存请先解码为图像执行列表，避免丢帧。")
    Path(target).write_bytes(encode_frame(frames[0], {"format": target_format}))
