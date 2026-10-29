"""General collection and JSONata transformations; no product-specific rules."""

import json
from comfy_api.latest import io


class LiuxinyuCollectExecutionList(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuCollectExecutionList", display_name="执行列表收集为数组",
            category="liuxinyu/结构化数据", is_input_list=True,
            description="把完整执行列表收集为一个数组。保留顺序和嵌套数组，不展开数组元素。",
            inputs=[io.AnyType.Input("value", display_name="执行列表")],
            outputs=[io.AnyType.Output(display_name="完整数组")],
        )

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(list(value))


class LiuxinyuStructuredTransform(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStructuredTransform", display_name="结构化数据变换（JSONata）",
            category="liuxinyu/结构化数据",
            description="用 JSONata 查询、分组、关联或变换 JSON 数据。输入通过 data0、data1 等访问。"
                        "每个输入应为一个完整值；需要整体处理执行列表时先收集为数组。"
                        "不执行 Python、系统命令或文件操作。",
            inputs=[
                io.Autogrow.Input("sources", template=io.Autogrow.TemplatePrefix(
                    io.AnyType.Input("value"), prefix="data", min=1, max=100)),
                io.String.Input("expression", display_name="JSONata 表达式", default="data0", multiline=True),
            ],
            outputs=[io.AnyType.Output(display_name="结果"), io.String.Output(display_name="JSON文本")],
        )

    @classmethod
    def execute(cls, sources, expression):
        try:
            import jsonata
        except ImportError as exc:
            raise RuntimeError("请在 ComfyUI Python 中安装 jsonata-python==0.6.3。") from exc
        # JSON round-trip both rejects tensors and prevents mutation of upstream objects.
        payload = json.loads(json.dumps(sources, ensure_ascii=False, allow_nan=False))
        try:
            result = jsonata.Jsonata(expression).evaluate(payload)
            serialized = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        except Exception as exc:
            raise ValueError(f"JSONata 数据变换失败：{exc}") from exc
        return io.NodeOutput(json.loads(serialized), serialized)
