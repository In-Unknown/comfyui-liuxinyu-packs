"""General collection and JSONata transformations; no product-specific rules."""

import math
from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker
from comfy_execution.validation import validate_node_input


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


class LiuxinyuMergeDictionaryArray(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuMergeDictionaryArray", display_name="并和数组中的字典字段为字典",
            category="liuxinyu/结构化数据",
            search_aliases=["合并字典数组", "合并字典", "merge dictionaries"],
            description=(
                "把数组内各字典的第一层键值对合并成一个新字典，按数组及各字典的键顺序保留。"
                "空数组输出空字典；重复键报错，即使值相同也不覆盖。"
                "值保持完整类型，不递归合并嵌套字典、不展开数组值、不修改输入或深拷贝值。"
                "上游为执行列表时，先用执行列表收集为数组。"
            ),
            inputs=[io.Array.Input("dictionaries", display_name="字典数组",
                                   tooltip='完整数组，每一项都是字典，例如 [{"a":1},{"b":2}]。不是 JSON 文本或多个独立执行项。')],
            outputs=[io.Dict.Output(display_name="合并后的字典")],
        )

    @classmethod
    def execute(cls, dictionaries):
        if not isinstance(dictionaries, list):
            raise ValueError("输入需要是字典数组；文本请先解析，执行列表请先收集为数组。")
        result = {}
        for index, item in enumerate(dictionaries):
            if not isinstance(item, dict):
                raise ValueError(f"第 {index + 1} 项不是字典，不能合并字段。")
            for key, value in item.items():
                if key in result:
                    raise ValueError(f"第 {index + 1} 项包含重复键 {key!r}，合并已停止，不覆盖已有值。")
                result[key] = value
        return io.NodeOutput(result)


JSON_TYPES = "DICT,ARRAY,STRING,INT,FLOAT,BOOLEAN,NULL"
JSON_NULL = io.Custom("NULL")
RESULT_TYPES = {"字典": dict, "数组": list, "字符串": str, "整数": int,
                "浮点数": float, "布尔值": bool, "空值": type(None)}
MAX_SAFE_INTEGER = 2**53 - 1


def _copy_json(value, location, active=None):
    """Validate before copying, so JSON conversion cannot silently change keys/types."""
    kind = type(value)
    if value is None or kind in (str, bool):
        return value
    if kind is int:
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError(f"{location}：整数超出 JSONata 安全精度范围 ±{MAX_SAFE_INTEGER}；编号请用字符串。")
        return value
    if kind is float:
        if not math.isfinite(value):
            raise ValueError(f"{location}：不支持 NaN 或 Infinity。")
        return value
    # JSONata returns list subclasses for sequences; normalize only that container.
    if not isinstance(value, (dict, list)):
        raise TypeError(f"{location}：不支持 {kind.__name__}，仅接受 JSON 数据，不自动转换元组或其他对象。")
    active = set() if active is None else active
    if id(value) in active:
        raise ValueError(f"{location}：不支持循环引用。")
    active.add(id(value))
    try:
        if isinstance(value, list):
            return [_copy_json(item, f"{location}[{i}]", active) for i, item in enumerate(value)]
        result = {}
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError(f"{location}：字典键必须是字符串，不自动转换 {type(key).__name__} 键。")
            result[key] = _copy_json(item, f"{location}[{key!r}]", active)
        return result
    finally:
        active.remove(id(value))


class LiuxinyuStructuredTransform(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStructuredTransform", display_name="结构化数据变换（JSONata）",
            category="liuxinyu/结构化数据",
            description="用 JSONata 处理多路 JSON 数据，通过 data0、data1 等访问。"
                        "结果必须符合所选类型，不自动转换或序列化。失败输出 false 和错误信息，结果分支跳过。"
                        "需要整体处理执行列表时先收集为数组；文本输入作为字符串，不自动解析。",
            inputs=[
                io.Autogrow.Input("sources", template=io.Autogrow.TemplatePrefix(
                    io.MultiType.Input("value", types=[io.Dict, io.Array, io.String, io.Int, io.Float, io.Boolean, JSON_NULL],
                                       tooltip="一个完整 JSON 值。字典键必须是字符串，数组不会自动展开。"),
                    prefix="data", min=1, max=100)),
                io.String.Input("expression", display_name="JSONata 表达式", default="data0", multiline=True),
                io.Combo.Input("result_type", display_name="结果类型", options=list(RESULT_TYPES), default="字典",
                               tooltip="声明结果类型并限定结果端口；实际结果类型不符则失败，不做隐式转换。"),
            ],
            outputs=[io.Custom(JSON_TYPES).Output(display_name="结果", tooltip="成功时输出符合所选类型的完整值；失败时此分支跳过。"),
                     io.Boolean.Output(display_name="执行成功"), io.String.Output(display_name="错误信息")],
        )

    @classmethod
    def validate_inputs(cls, input_types, sources=None):
        # V3 Autogrow also supplies its grouped container during validation.
        if "result_type" in input_types:
            return "结果类型必须在节点上固定选择，不能通过连线动态改变。"
        for name, kind in input_types.items():
            expected = JSON_TYPES if name.startswith("sources.") else "STRING"
            if not validate_node_input(kind, expected):
                return f"{name} 不接受 {kind}；需要 {expected}。"
        return True

    @classmethod
    def execute(cls, sources, expression, result_type):
        try:
            try:
                import jsonata
            except ImportError as exc:
                raise RuntimeError("请在 ComfyUI Python 中安装 jsonata-python==0.6.3。") from exc
            if result_type not in RESULT_TYPES:
                raise ValueError("请选择有效的结果类型。")
            if not sources:
                raise ValueError("至少连接一路 JSON 数据。")
            payload = _copy_json(sources, "输入")
            # An object envelope distinguishes JSON null from an undefined result.
            envelope = jsonata.Jsonata('{"value": (\n' + expression + '\n)}').evaluate(payload)
            if "value" not in envelope:
                raise ValueError("表达式没有得到结果（字段不存在或筛选为空）；需要数组时请显式使用 [表达式]。")
            result = _copy_json(envelope["value"], "结果")
            if type(result) is not RESULT_TYPES[result_type]:
                raise TypeError(f"结果类型不符：要求{result_type}，实际为 {type(result).__name__}；不自动转换。")
        except Exception as exc:
            return io.NodeOutput(ExecutionBlocker(None), False, f"JSONata 数据变换失败：{exc}")
        return io.NodeOutput(result, True, "")
