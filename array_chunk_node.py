"""Split a whole array into consecutive non-overlapping chunks."""

from comfy_api.latest import io


class LiuxinyuArrayChunk(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuArrayChunk",
            display_name="分块提取数组为数组",
            category="liuxinyu/结构化数据",
            description=(
                "将完整数组按窗口块大小连续分块，输出元素为数组的完整数组。"
                "分块不重叠，末尾不足一块也单独保留，不补齐、不丢弃。"
                "窗口块大小必须是正整数；空数组输出空数组。"
                "保留元素顺序、原始类型和嵌套结构，不修改输入，不展开为执行列表。"
            ),
            inputs=[
                io.Array.Input("array", display_name="数组",
                               tooltip="待分块的完整数组，不接受 JSON 文本、元组或单个对象。"),
                io.Int.Input("chunk_size", display_name="窗口块大小", default=3, min=1, max=2147483647,
                             tooltip="每块最多包含的元素个数，必须是正整数；末尾不足此数量也单独保留。"),
            ],
            outputs=[io.Array.Output(display_name="分块后的数组")],
        )

    @classmethod
    def execute(cls, array, chunk_size):
        if not isinstance(array, list):
            raise ValueError("数组输入必须是完整数组，文本请先解析。")
        if not isinstance(chunk_size, int) or isinstance(chunk_size, bool):
            raise ValueError("窗口块大小必须是正整数，不能是布尔值、小数或数字字符串。")
        if chunk_size <= 0:
            raise ValueError(f"窗口块大小必须大于 0，当前为 {chunk_size}。")
        return io.NodeOutput([array[start:start + chunk_size] for start in range(0, len(array), chunk_size)])
