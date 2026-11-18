"""Extract a closed interval of array indices as a whole array."""

from comfy_api.latest import io


class LiuxinyuArrayRange(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuArrayRange",
            display_name="下标范围提取数组",
            category="liuxinyu/结构化数据",
            description=(
                "从完整数组中提取下标 min 到 max 闭区间内的所有元素，包含两端，输出一个完整数组。"
                "下标从 0 开始，min 和 max 必须是整数；负数、越界或 min 大于 max 报错。"
                "保留元素顺序、原始类型与嵌套结构，不修改输入，不展开为执行列表。"
            ),
            inputs=[
                io.Array.Input("array", display_name="数组",
                               tooltip="待提取的完整数组，不接受 JSON 文本、元组或单个对象。"),
                io.Int.Input("min", display_name="min", default=0, min=0, max=2147483647,
                             tooltip="起始下标，包含此项；从 0 开始，必须小于数组长度且不大于 max。"),
                io.Int.Input("max", display_name="max", default=0, min=0, max=2147483647,
                             tooltip="结束下标，包含此项；必须小于数组长度。min=max 时输出单元素数组。"),
            ],
            outputs=[io.Array.Output(display_name="提取出来的数组")],
        )

    @classmethod
    def execute(cls, array, min, max):
        if not isinstance(array, list):
            raise ValueError("数组输入必须是完整数组，文本请先解析。")
        for name, index in (("min", min), ("max", max)):
            if not isinstance(index, int) or isinstance(index, bool):
                raise ValueError(f"{name} 必须是整数，不能是布尔值、小数或数字字符串。")
            if index < 0 or index >= len(array):
                raise ValueError(
                    f"{name} 下标 {index} 超出范围，数组共 {len(array)} 个元素，下标从 0 开始。"
                )
        if min > max:
            raise ValueError(f"min ({min}) 不能大于 max ({max})，请提供从小到大的闭区间。")
        return io.NodeOutput(array[min:max + 1])
