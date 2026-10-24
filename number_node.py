"""数字转换节点。"""

from decimal import Decimal
from numbers import Integral, Number, Real
import codecs
import json
import math
import re

from comfy_api.latest import io


_LITERAL_ESCAPE = re.compile(r"""\\(?:[\\'"/abfnrtv]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|\r?\n)""")
_LITERAL_QUOTES = {'"': '"', "'": "'", '“': '”', '‘': '’'}


def _literal_unescape(text):
    output = []
    start = 0
    while start < len(text):
        slash = text.find("\\", start)
        if slash < 0:
            output.append(text[start:])
            break
        output.append(text[start:slash])
        match = _LITERAL_ESCAPE.match(text, slash)
        if match is None:
            raise ValueError("无效转义")
        escape = match.group()
        output.append("/" if escape == "\\/" else codecs.decode(escape, "unicode_escape"))
        start = match.end()
    return "".join(output)


def _literal_parts(text):
    parts = []
    start = 0
    depth = 0
    quote = None
    escaped = False
    for index, character in enumerate(text):
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if quote is not None:
            if character == quote or quote == '”' and character == '“' or quote == '’' and character == '‘':
                quote = None
        elif character in _LITERAL_QUOTES:
            quote = _LITERAL_QUOTES[character]
        elif character in "[{":
            depth += 1
        elif character in "]}":
            depth -= 1
            if depth < 0:
                raise ValueError("括号不匹配")
        elif character in ",，" and depth == 0:
            parts.append(text[start:index])
            start = index + 1
    if quote is not None or depth or escaped:
        raise ValueError("不完整的字面量")
    parts.append(text[start:])
    return parts


def _reject_json_constant(value):
    raise ValueError(f"JSON 不支持 {value}。")


def _parse_literal(text):
    stripped = text.strip()
    if stripped.startswith("{"):
        return json.loads(stripped, parse_constant=_reject_json_constant), "对象"
    bracketed = stripped.startswith("[")
    if bracketed:
        if not stripped.endswith("]"):
            raise ValueError("数组未闭合")
        inner = stripped[1:-1]
        parts = _literal_parts(inner) if inner.strip() else []
    else:
        parts = _literal_parts(stripped)
    if bracketed or len(parts) > 1:
        if parts and not parts[-1].strip():
            parts.pop()
        if any(not part.strip() for part in parts):
            raise ValueError("数组元素为空")
        parsed = [_parse_literal(part) for part in parts]
        kinds = {kind for _, kind in parsed}
        kind = next(iter(kinds)) if len(kinds) == 1 else "混合"
        return [value for value, _ in parsed], f"{kind}数组" if parsed else "空数组"
    if stripped[:1] in _LITERAL_QUOTES:
        closing = _LITERAL_QUOTES[stripped[0]]
        if len(stripped) < 2 or stripped[-1] not in (closing, stripped[0]):
            raise ValueError("字符串未闭合")
        inner = stripped[1:-1]
        escaped = False
        for character in inner:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character in (closing, stripped[0]):
                raise ValueError("无效字符串")
        return _literal_unescape(inner), "字符串"
    value = _literal_unescape(text)
    token = value.strip()
    if re.fullmatch(r"[+-]?[0-9]+", token):
        return int(token), "整数"
    if re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", token):
        number = float(token)
        if math.isfinite(number):
            return number, "浮点数（双精度）"
    if re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})", token):
        return token, "颜色（十六进制字符串）"
    return value, "字符串"


class LiuxinyuStringToLiteral(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringToLiteral",
            display_name="字符串转为字面量",
            category="utils/conversion",
            description=(
                "解析整数、双精度浮点数、十六进制颜色、JSON 对象及逗号分隔数组（可带方括号）。"
                "支持 [0.1, 0.2] 和 [{\"percent\": 10}, {\"percent\": 20}]，也可包在完整的 Markdown JSON 代码块中。"
                "中英文引号包裹的内容始终是字符串。支持反斜杠转义；字面反斜杠请写成两个。"
                "普通文本或不成立的格式回退为字符串。原“字面量”输出把数组展开为执行列表，普通下游逐项运行；标量输出为一项。"
                "新增“完整字面量”输出保留完整数组或对象，请使用此输出连接切分数组。"
                "颜色以十六进制字符串传递，运行后在节点底部显示类型。"
            ),
            inputs=[io.String.Input("text", display_name="字符串", default="", multiline=True)],
            outputs=[
                io.AnyType.Output(display_name="字面量", is_output_list=True),
                io.AnyType.Output(display_name="完整字面量"),
            ],
        )

    @classmethod
    def execute(cls, text):
        literal = text
        fenced = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n[ \t]*```", text.strip(), re.IGNORECASE | re.DOTALL)
        if fenced:
            literal = fenced.group(1)
        try:
            value, kind = _parse_literal(literal)
        except (ValueError, OverflowError, UnicodeError, RecursionError):
            value, kind = text, "字符串"
        return io.NodeOutput(value if isinstance(value, list) else [value], value,
                             ui={"liuxinyu_literal_type": [kind]})


class LiuxinyuNumberArray(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuNumberArray",
            display_name="多个数值组成数组",
            category="utils/conversion",
            search_aliases=["数值数组", "整数数组", "浮点数组", "number array"],
            description=(
                "按输入口从上到下的顺序组成一个数组，连接末尾输入后自动增加输入口。"
                "全部为整数时输出整数数组；含浮点数时全部转为浮点数。"
                "未连接的输入不占数组位置，没有输入时输出空数组。"
            ),
            inputs=[io.MultiType.Input(
                io.Float.Input("number0", force_input=True, optional=True),
                types=[io.Int, io.Float], display_name="数值 1",
                tooltip="连接整数或浮点数；连接后自动增加下一个输入口。",
            )],
            outputs=[io.Array.Output(display_name="数值数组")],
            accept_all_inputs=True,
        )

    @classmethod
    def execute(cls, **numbers):
        for name, value in numbers.items():
            if not re.fullmatch(r"number[0-9]+", name):
                raise ValueError(f"未知数值输入口：{name}")
            if isinstance(value, bool) or not isinstance(value, Real):
                raise ValueError(f"{name} 只能输入整数或浮点数，收到 {type(value).__name__}。")
        values = [value for _, value in sorted(numbers.items(), key=lambda item: int(item[0][6:]))]
        convert = int if all(isinstance(value, Integral) for value in values) else float
        return io.NodeOutput([convert(value) for value in values])


class LiuxinyuNumberToString(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuNumberToString",
            display_name="数字转换为字符串",
            category="utils/conversion",
            search_aliases=["数字转字符串", "整数转文本", "浮点数转文本", "number to string"],
            description="将整数、浮点数及其他数字转换为字符串，不额外四舍五入或补零。",
            inputs=[
                io.AnyType.Input(
                    "number",
                    display_name="数字",
                    tooltip="连接整数、浮点数或其他数字输出。例如：123 → 123，3.14 → 3.14。",
                ),
            ],
            outputs=[io.String.Output(display_name="字符串")],
        )

    @classmethod
    def execute(cls, number):
        if isinstance(number, bool) or not isinstance(number, (Number, Decimal)):
            raise ValueError(f"请输入整数、浮点数或其他数字；实际收到 {type(number).__name__}：{number!r}。")
        return io.NodeOutput(str(number))



def _number_pair(value):
    if isinstance(value, bool):
        return (1.0, 1) if value else (0.0, 0)
    if isinstance(value, Decimal):
        return (float(value), int(value))
    if isinstance(value, int):
        return (float(value), value)
    if isinstance(value, float):
        return (value, int(value))
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValueError('无法把空字符串转换为数字。')
        try:
            number = float(text)
        except ValueError:
            raise ValueError(f'无法把字符串 {value!r} 解析为数字。') from None
        if not math.isfinite(number):
            raise ValueError(f'字符串 {value!r} 解析出的不是有限数值。')
        try:
            integer = int(text)
        except ValueError:
            integer = int(number)
        return (number, integer)
    if value is None:
        raise ValueError('无法把 None 转换为数字。')
    raise ValueError(f'无法把 {type(value).__name__} 转换为数字：{value!r}')


class LiuxinyuNumberConvert(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id='LiuxinyuNumberConvert',
            display_name='数字转换',
            category='utils/conversion',
            search_aliases=['number convert', '数值转换', '转为数字', 'parse number'],
            description=(
                '把输入转换为浮点数与整数。支持整数、浮点数、Decimal、布尔值、数字字符串，'
                '以及一维数组。布尔值按 1/0 处理；字符串会去掉首尾空白后解析，空字符串或无法解析时报错；'
                '数组逐项转换后按列表输出，下游可逐项执行。'
            ),
            inputs=[
                io.AnyType.Input(
                    'value',
                    display_name='值',
                    tooltip='可连接数字、字符串、布尔值或一维数组。',
                ),
            ],
            outputs=[
                io.Float.Output(display_name='浮点数', is_output_list=True),
                io.Int.Output(display_name='整数', is_output_list=True),
            ],
        )

    @classmethod
    def execute(cls, value):
        floats = []
        ints = []
        if isinstance(value, list):
            if not value:
                raise ValueError('输入数组为空。')
            for item in value:
                if isinstance(item, list):
                    raise ValueError('只支持一维数组；收到嵌套数组。')
                f, i = _number_pair(item)
                floats.append(f)
                ints.append(i)
        else:
            f, i = _number_pair(value)
            floats.append(f)
            ints.append(i)
        return io.NodeOutput(floats, ints)
