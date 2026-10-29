"""Compare typed data content, with digests followed by an exact byte check."""

import hashlib
from itertools import zip_longest
import struct

import numpy as np
import torch
from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted


BLOCK_SIZE = 1024 * 1024


def framed(data):
    return len(data).to_bytes(8, "big") + data


def content_chunks(value, ancestors=()):
    """Canonical typed content; no repr(), Python hash(), or pickle hooks."""
    throw_exception_if_processing_interrupted()
    kind = type(value)
    if kind is type(None):
        yield b"none"
    elif kind is bool:
        yield b"bool" + bytes([value])
    elif kind is int:
        yield b"int" + framed(str(value).encode("ascii"))
    elif kind is float:
        yield b"float" + struct.pack("!d", value)
    elif kind is complex:
        yield b"complex" + struct.pack("!dd", value.real, value.imag)
    elif kind is str:
        yield b"str" + framed(value.encode("utf-8", errors="surrogatepass"))
    elif kind in (bytes, bytearray):
        yield kind.__name__.encode() + len(value).to_bytes(8, "big")
        for offset in range(0, len(value), BLOCK_SIZE):
            yield bytes(value[offset:offset + BLOCK_SIZE])
    elif kind in (list, tuple, dict, set, frozenset):
        if id(value) in ancestors:
            raise ValueError("判断哈希相等不支持循环引用，请先转换为不含自引用的数据。")
        ancestors = (*ancestors, id(value))
        yield kind.__name__.encode() + len(value).to_bytes(8, "big")
        if kind is dict:
            # Sorting canonical keys makes insertion order irrelevant. Values
            # remain streamed, including large images nested in LATENT dicts.
            entries = sorted(((b"".join(content_chunks(key, ancestors)), key) for key in value), key=lambda pair: pair[0])
            for index, (encoded_key, key) in enumerate(entries):
                if index and encoded_key == entries[index - 1][0]:
                    raise ValueError("字典包含二进制内容相同但彼此不相等的键，无法无歧义比较。")
                yield framed(encoded_key)
                yield from content_chunks(value[key], ancestors)
        elif kind in (set, frozenset):
            for encoded in sorted(b"".join(content_chunks(item, ancestors)) for item in value):
                yield framed(encoded)
        else:
            for item in value:
                yield from content_chunks(item, ancestors)
    elif kind is torch.Tensor:
        if value.layout != torch.strided or value.is_quantized or value.device.type == "meta":
            raise ValueError("请先将稀疏、量化或 meta 张量转换为具有实际像素/数值的普通张量。")
        yield b"tensor" + framed(str(value.dtype).encode())
        yield from content_chunks(tuple(value.shape), ancestors)
        # Logical values determine equality; device, strides and autograd do not.
        raw = value.detach().resolve_conj().resolve_neg().contiguous().reshape(-1).view(torch.uint8)
        for offset in range(0, raw.numel(), BLOCK_SIZE):
            throw_exception_if_processing_interrupted()
            yield raw[offset:offset + BLOCK_SIZE].cpu().numpy().tobytes()
    elif kind is np.ndarray or isinstance(value, np.generic):
        yield b"ndarray" if kind is np.ndarray else b"numpy_scalar"
        yield framed(str(value.dtype.descr if value.dtype.fields else value.dtype.str).encode())
        yield from content_chunks(dict(value.dtype.metadata) if value.dtype.metadata else None, ancestors)
        yield from content_chunks(tuple(value.shape), ancestors)
        if id(value) in ancestors:
            raise ValueError("判断哈希相等不支持循环引用，请先转换为不含自引用的数据。")
        ancestors = (*ancestors, id(value))
        if value.dtype.fields:
            for name in value.dtype.names:
                yield from content_chunks(value[name], ancestors)
        elif value.dtype.hasobject:
            for item in value.flat:
                yield from content_chunks(item, ancestors)
        else:
            raw = memoryview(np.ascontiguousarray(value).reshape(-1).view(np.uint8))
            for offset in range(0, raw.nbytes, BLOCK_SIZE):
                throw_exception_if_processing_interrupted()
                yield raw[offset:offset + BLOCK_SIZE].tobytes()
    else:
        raise TypeError(
            f"无法可靠读取 {kind.__module__}.{kind.__qualname__} 的完整数据内容。"
            "请先转成张量、NumPy 数组、字典、列表或基础数值；不会使用对象地址或字符串表示冒充内容哈希。"
        )


def digests(value):
    sha256 = hashlib.sha256()
    md5 = hashlib.md5(usedforsecurity=False)
    for chunk in content_chunks(value):
        sha256.update(chunk)
        md5.update(chunk)
    return sha256.digest(), md5.digest()


def content_equal(left, right):
    if type(left) is not type(right):
        return False
    if digests(left) != digests(right):
        return False
    # Digest matches are only a filter, never proof of exact equality.
    sentinel = object()
    return all(a == b for a, b in zip_longest(content_chunks(left), content_chunks(right), fillvalue=sentinel))


class LiuxinyuHashEqual(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuHashEqual", display_name="判断哈希相等", category="liuxinyu/流程控制",
            description=(
                "比较两个完整数据值：类型一致，SHA-256 与 MD5 均相同后，再逐块复核实际数据，完全相同返回 true。"
                "支持图片/普通张量、NumPy 数组、列表、元组、字典、集合、文本、数值、字节和 None。"
                "图片比较完整浮点数据，不是缩略图或8位导出图。字典忽略插入顺序，张量忽略设备和内存布局。"
                "输入若是执行列表则整列比较，不自动按项展开。无法读取完整内容的模型/自定义对象和循环引用会明确报错。"
            ),
            is_input_list=True,
            inputs=[io.AnyType.Input("a", display_name="数据 A"), io.AnyType.Input("b", display_name="数据 B")],
            outputs=[io.Boolean.Output(display_name="相等")],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Inputs can contain mutable tensors/dicts; do not reuse an old verdict.
        return float("nan")

    @classmethod
    def execute(cls, a, b):
        return io.NodeOutput(content_equal(a, b))
