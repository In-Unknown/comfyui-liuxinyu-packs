"""Select array elements by an ordered array of integer indices."""

from comfy_api.latest import io


class LiuxinyuExtractArray(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuExtractArray",
            display_name="下标提取数组元素为新数组",
            search_aliases=["从数组中提取数组"],
            category="liuxinyu/结构化数据",
            description=(
                "按下标数列的顺序从完整数组中提取元素，输出一个完整数组。"
                "下标从 0 开始，每项必须是整数；负数或越界报错。"
                "保留重复下标及元素原始类型，空下标数组输出空数组，不修改输入。"
                "上游为执行列表时按 ComfyUI 原生规则逐项处理，每次输入仍须是数组。"
            ),
            inputs=[
                io.Array.Input("array", display_name="数组",
                               tooltip="待提取的完整数组，元素可以是任意类型；不接受 JSON 文本、元组或单个对象。"),
                io.Array.Input("indices", display_name="下标数列",
                               tooltip="整数数组，例如 [2,0,2]；从 0 开始，不能是布尔值、小数或数字字符串。"),
            ],
            outputs=[io.Array.Output(display_name="提取出来的数组")],
        )

    @classmethod
    def execute(cls, array, indices):
        if not isinstance(array, list):
            raise ValueError("数组输入必须是完整数组，文本请先解析。")
        if not isinstance(indices, list):
            raise ValueError("下标数列必须是完整的整数数组。")
        result = []
        for position, index in enumerate(indices):
            if not isinstance(index, int) or isinstance(index, bool):
                raise ValueError(f"下标数列第 {position + 1} 项必须是整数，不能是布尔值、小数或数字字符串。")
            if index < 0 or index >= len(array):
                raise ValueError(
                    f"下标数列第 {position + 1} 项的下标 {index} 超出范围，"
                    f"数组共 {len(array)} 个元素，下标从 0 开始。"
                )
            result.append(array[index])
        return io.NodeOutput(result)
