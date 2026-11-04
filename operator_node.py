"""Python comparisons, short-circuit value selection, and bitwise operators."""

import operator

from comfy_api.latest import io


COMPARISONS = {
    "==": operator.eq, "!=": operator.ne,
    "<": operator.lt, "<=": operator.le, ">": operator.gt, ">=": operator.ge,
    "is": operator.is_, "is not": operator.is_not,
    "in": lambda a, b: a in b,
    "not in": lambda a, b: a not in b,
}
COMPARISON_LABELS = {
    "等于": "==", "不等于": "!=", "小于": "<", "小于或等于": "<=",
    "大于": ">", "大于或等于": ">=", "同一对象": "is", "不是同一对象": "is not",
    "属于": "in", "不属于": "not in",
}
COMPARISON_OPTIONS = list(COMPARISON_LABELS)
BITWISE = {"&": operator.and_, "|": operator.or_, "^": operator.xor,
           "<<": operator.lshift, ">>": operator.rshift}
MISSING = object()


class LiuxinyuCompare(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuCompare", display_name="比较运算符", category="liuxinyu/逻辑运算",
            search_aliases=["相等", "不等于", "大于", "小于", "包含", "compare"],
            description=(
                "按 Python 语义计算 A 与 B 的比较，输出一个布尔值。界面使用等于、不等于、小于、"
                "小于或等于、大于、大于或等于、同一对象、不是同一对象、属于、不属于。"
                "属于表示 A 是否在 B 中；同一对象比较对象身份。"
                "字符串按 Unicode 码点逐位比较，不转换数值文本。不支持的比较直接报错。"
            ),
            inputs=[
                io.Combo.Input("operation", display_name="运算符", options=COMPARISON_OPTIONS, default="等于"),
                io.AnyType.Input("a", display_name="A", tooltip="左操作数；in / not in 时为待查找的值。"),
                io.AnyType.Input("b", display_name="B", tooltip="右操作数；in / not in 时为容器。"),
            ],
            outputs=[io.Boolean.Output(display_name="结果")],
        )

    @classmethod
    def validate_inputs(cls, operation):
        if COMPARISON_LABELS.get(operation, operation) not in COMPARISONS:
            return f"未知比较运算符：{operation}"
        return True

    @classmethod
    def fingerprint_inputs(cls, operation, **kwargs):
        # Object identity can change even when upstream content fingerprints match.
        operation = COMPARISON_LABELS.get(operation, operation)
        return float("nan") if operation in ("is", "is not") else operation

    @classmethod
    def execute(cls, operation, a, b):
        operation = COMPARISON_LABELS.get(operation, operation)
        return io.NodeOutput(bool(COMPARISONS[operation](a, b)))


class LiuxinyuBooleanOperator(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuBooleanOperator", display_name="布尔运算符", category="liuxinyu/逻辑运算",
            search_aliases=["非", "与", "或", "not", "and", "or", "短路"],
            description=(
                "Python 真值运算：not A 返回布尔值；A and B / A or B 返回原操作数之一，不强制转换为布尔。"
                "and 在 A 为假时不请求 B；or 在 A 为真时不请求 B。not 只显示 A，and / or 显示 A、B。"
            ),
            inputs=[
                io.Combo.Input("operation", display_name="运算符", options=["not", "and", "or"],
                               default="not", socketless=True),
                io.AnyType.Input("a", display_name="A", tooltip="先读取并按 Python bool(A) 测试真值的操作数。"),
                io.AnyType.Input("b", display_name="B", optional=True, lazy=True,
                                 tooltip="and / or 时必须连接，仅在需要时请求；返回时保留原值与类型。"),
            ],
            outputs=[io.AnyType.Output(display_name="结果",
                tooltip="not 输出 BOOLEAN；and / or 输出 A 或 B 的原对象。数组整体输出，不展开为执行列表。")],
        )

    @classmethod
    def validate_inputs(cls, operation, b=MISSING):
        if operation != "not" and b is MISSING:
            return f"{operation} 需要连接 B；not 只需要 A。"
        return True

    @classmethod
    def check_lazy_status(cls, a, operation, b=None):
        if b is None and ((operation == "and" and a) or (operation == "or" and not a)):
            return ["b"]
        return []

    @classmethod
    def execute(cls, a, operation, b=None):
        if operation == "not":
            result = not a
        elif operation == "and":
            result = a and b
        elif operation == "or":
            result = a or b
        else:
            raise ValueError(f"未知布尔运算符：{operation}")
        return io.NodeOutput(result)


class LiuxinyuBitwiseOperator(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuBitwiseOperator", display_name="位运算符", category="liuxinyu/逻辑运算",
            search_aliases=["按位与", "按位或", "异或", "取反", "左移", "右移", "集合运算"],
            description=(
                "支持 &、|、^、~、<<、>>。& / | / ^ 接收整数、布尔或集合，遵循 Python 运算结果类型；"
                "~、移位接收整数或布尔。~ 只有 A，其余显示 A、B，二元运算不短路。"
                "~True 为 -2，~False 为 -1。集合按交集、并集、对称差处理，不将数组自动转换为集合。"
            ),
            inputs=[
                io.Combo.Input("operation", display_name="运算符", options=["&", "|", "^", "~", "<<", ">>"],
                               default="&", socketless=True),
                io.AnyType.Input("a", display_name="A", tooltip="左操作数：整数、布尔；& / | / ^ 也支持 Python set。"),
                io.AnyType.Input("b", display_name="B", optional=True,
                                 tooltip="二元运算必须连接；<< / >> 时为非负整数移位量，布尔按 0 / 1 参与。"),
            ],
            outputs=[io.AnyType.Output(display_name="结果",
                tooltip="按实际运算输出 INT、BOOLEAN 或 Python set；不转换为字符串或数组。")],
        )

    @classmethod
    def validate_inputs(cls, operation, b=MISSING):
        if operation != "~" and b is MISSING:
            return f"{operation} 需要连接 B；~ 只需要 A。"
        return True

    @classmethod
    def execute(cls, a, operation, b=None):
        allowed = (int, set) if operation in ("&", "|", "^") else (int,)
        for name, value in [("A", a)] + ([] if operation == "~" else [("B", b)]):
            if not isinstance(value, allowed):
                expected = "整数、布尔或集合" if set in allowed else "整数或布尔"
                raise TypeError(f"{operation} 的 {name} 需要{expected}，收到 {type(value).__name__}。")
        # Keep the requested integer result for bool inversion across Python versions.
        if operation == "~":
            result = ~int(a) if isinstance(a, bool) else ~a
        else:
            result = BITWISE[operation](a, b)
        return io.NodeOutput(result)
