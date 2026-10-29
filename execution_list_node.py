"""Repeat an arbitrary value as a ComfyUI execution list."""

from numbers import Integral

from comfy_api.latest import io


class LiuxinyuRepeatAnyToExecutionList(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuRepeatAnyToExecutionList",
            display_name="批量任意为执行列表",
            category="utils/conversion",
            search_aliases=["任意值重复", "重复执行列表", "repeat any"],
            description=(
                "将任意输入值整体重复指定次数，输出为 ComfyUI 执行列表，供下游逐项处理或分包。"
                "保留原始类型，支持图片、Latent、字符串、数字、字典、数组等。"
                "不拆开图片批次或数组，也不深拷贝模型和张量。次数为 0 时输出空执行列表。"
                "上游若已是执行列表，则逐项重复，顺序为 A、A、B、B（次数为 2）。"
            ),
            inputs=[
                io.AnyType.Input("value", display_name="任意"),
                io.Int.Input("count", display_name="重复次数", default=1, min=0),
            ],
            outputs=[io.AnyType.Output(display_name="执行列表", is_output_list=True)],
        )

    @classmethod
    def execute(cls, value, count):
        if isinstance(count, bool) or not isinstance(count, Integral) or count < 0:
            raise ValueError("重复次数必须是大于或等于 0 的整数。")
        return io.NodeOutput([value] * count)


class LiuxinyuConcatAnyExecutionLists(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuConcatAnyExecutionLists",
            display_name="顺合任意执行列表",
            category="utils/conversion",
            is_input_list=True,
            description=(
                "按输入口从上到下的顺序，将各路执行列表首尾相接。"
                "保留每路内部顺序、重复项和原始类型，不递归拆分数组或图片批次。"
                "输入口随连接增加，采用 ComfyUI 原生最多 100 个输入；可串联继续顺合。"
            ),
            inputs=[io.Autogrow.Input(
                "lists", template=io.Autogrow.TemplatePrefix(
                    io.AnyType.Input("value"), prefix="list", min=1, max=100,
                ),
            )],
            outputs=[io.AnyType.Output(display_name="执行列表", is_output_list=True)],
        )

    @classmethod
    def execute(cls, lists):
        ordered = sorted(lists, key=lambda name: int(name.removeprefix("list")))
        return io.NodeOutput([value for name in ordered for value in lists[name]])
