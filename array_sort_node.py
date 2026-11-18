"""Reorder a complete array of dictionaries without changing its records."""

import math
import random

from comfy_api.latest import io


class LiuxinyuSortDictionaryArray(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuSortDictionaryArray",
            display_name="对数组中字典元素重排序",
            category="liuxinyu/结构化数据",
            description=(
                "按字典第一层键的值升序、降序排列，或随机打乱完整数组。"
                "数字按数值、字符串按字符编码排序；同值保留原顺序。"
                "随机方式不读取键，每次运行重新打乱，可能得到相同顺序。"
                "不修改原数组或字典。执行列表中的每一项必须是数组，各数组分别处理。"
            ),
            inputs=[
                io.Array.Input("array", display_name="数组",
                               tooltip="一个完整数组，所有元素必须是字典；不接受 JSON 文本或单个字典。"),
                io.String.Input("key", display_name="要依据的键", default="",
                                tooltip="第一层键名，精确匹配；不解析点号路径。随机方式可留空。"),
                io.Combo.Input("method", display_name="方式", options=["随机", "升序", "降序"], default="随机"),
            ],
            outputs=[io.Array.Output(display_name="输出")],
        )

    @classmethod
    def fingerprint_inputs(cls, method, **kwargs):
        return float("nan") if method == "随机" else method

    @classmethod
    def execute(cls, array, key, method):
        if not isinstance(array, list):
            raise ValueError("数组输入必须是完整数组；文本请先解析，单个字典不能作为数组输入。")
        if method not in ("随机", "升序", "降序"):
            raise ValueError("方式必须是随机、升序或降序。")
        for index, item in enumerate(array):
            if not isinstance(item, dict):
                raise ValueError(f"数组第 {index + 1} 项不是字典。")
        if method == "随机":
            result = list(array)
            random.shuffle(result)
            return io.NodeOutput(result)
        if not isinstance(key, str):
            raise ValueError("要依据的键必须是字符串键名。")
        for index, item in enumerate(array):
            if key not in item:
                raise ValueError(f"数组第 {index + 1} 项缺少键 {key!r}。")
            value = item[key]
            if not isinstance(value, (str, int, float)) or (isinstance(value, float) and math.isnan(value)):
                raise ValueError(f"数组第 {index + 1} 项的键 {key!r} 必须是数字、布尔值或字符串，不能是空值、容器或 NaN。")
        try:
            result = sorted(array, key=lambda item: item[key], reverse=method == "降序")
        except TypeError as exc:
            raise ValueError(f"键 {key!r} 的值无法互相比较；请统一为数字或统一为字符串，不自动转换类型。") from exc
        return io.NodeOutput(result)
