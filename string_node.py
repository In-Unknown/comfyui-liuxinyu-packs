"""字符串拼接节点。"""

import json
import ast
import re
import ctypes
import unicodedata
import codecs
import math
from itertools import product
from pathlib import Path

from comfy_api.latest import io
from liuxinyu_cache import file_changes


TemplateParameters = io.Custom("LIUXINYU_TEMPLATE_PARAMETERS")
PLACEHOLDER = re.compile(r"\{(t[1-9][0-9]*)\}")
_JS_PATH_NAME = re.compile(r"(?:[^\W\d]|\$)[\w$]*")
_JS_PATH_BRACKET = re.compile(r"""\[\s*(?:(?P<index>0|[1-9][0-9]*)|(?P<quoted>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\]""")


def _js_path_parts(expression):
    path = expression.strip()
    position = 0
    parts = []
    while position < len(path):
        while position < len(path) and path[position].isspace():
            position += 1
        if position == len(path):
            break
        if path[position] == "[":
            match = _JS_PATH_BRACKET.match(path, position)
            if match is None:
                raise ValueError(f"读取语句第 {position + 1} 个字符附近格式错误；方括号中请填写非负整数或带引号的键名。")
            if match.group("index") is not None:
                key = int(match.group("index"))
            else:
                quoted = match.group("quoted")
                try:
                    key = json.loads(quoted) if quoted.startswith('"') else ast.literal_eval(quoted)
                except (ValueError, SyntaxError) as error:
                    raise ValueError(f"读取语句第 {position + 1} 个字符附近的键名转义不正确。") from error
        else:
            if parts:
                if path[position] != ".":
                    raise ValueError(f"读取语句第 {position + 1} 个字符附近需要点号或方括号。")
                position += 1
                while position < len(path) and path[position].isspace():
                    position += 1
            match = _JS_PATH_NAME.match(path, position)
            if match is None:
                raise ValueError(f"读取语句第 {position + 1} 个字符附近缺少合法键名；特殊键名请使用 [\"键名\"]。")
            key = match.group()
        position = match.end()
        parts.append((key, path[:position]))
    return parts


def _js_path_target(content, expression):
    if not isinstance(content, (dict, list)):
        raise ValueError("输入需要是解析后的对象或数组。")
    value = content
    parents = []
    for key, location in _js_path_parts(expression):
        if isinstance(value, dict):
            key = str(key)
            if key not in value:
                raise ValueError(f"读取失败：{location}，对象中不存在键 {key!r}。")
            parents.append((value, key))
            value = value[key]
        elif isinstance(value, list):
            if key == "length":
                value = len(value)
                continue
            if isinstance(key, str) and re.fullmatch(r"0|[1-9][0-9]*", key):
                key = int(key)
            if not isinstance(key, int):
                raise ValueError(f"读取失败：{location}，数组需要从 0 开始的整数下标，或 length。")
            if key >= len(value):
                raise ValueError(f"读取失败：{location}，下标 {key} 越界，数组共有 {len(value)} 项。")
            parents.append((value, key))
            value = value[key]
        else:
            raise ValueError(f"读取失败：{location}，上一级已经是标量或 null，不能继续读取属性。")
    return value, parents


class LiuxinyuReadJSObjectPath(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuReadJSObjectPath",
            display_name="使用js点符号语句读取对象",
            category="utils/conversion",
            description=(
                "通过键名、点号和数组下标读取对象，例如 a.b.c、a[12]、a.b.c[10].d。"
                "根数组直接写 [0]，数组下标从 0 开始；特殊键名写成 [\"a.b\"] 或 ['键名']。"
                "数组的 length 返回元素个数。语句留空返回整个输入。"
                "结果保留原始类型，可以是数字、字符串、布尔值、null、对象或数组。"
                "数组整体输出，不自动拆分执行；路径不存在或下标越界时报错。"
            ),
            inputs=[
                io.MultiType.Input("content", types=[io.Dict, io.Array], display_name="对象或数组"),
                io.String.Input("expression", display_name="读取语句", default="", multiline=False,
                                tooltip="例如 a.b.c[10].d；根数组用 [0]；留空读取整个输入。"),
            ],
            outputs=[io.AnyType.Output(display_name="读取结果")],
        )

    @classmethod
    def execute(cls, content, expression):
        value, _ = _js_path_target(content, expression)
        return io.NodeOutput(value)


class LiuxinyuInsertJSObject(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuInsertJSObject",
            display_name="插入字段到字典或者js对象",
            category="utils/conversion",
            search_aliases=["插入字段", "数组追加", "insert object", "append array"],
            description=(
                "按点号与数组下标找到挂载位置；留空表示根位置。"
                "目标为字典时，新增值必须是字典，将其中键值对插入，已有键报错；"
                "目标为数组时，将任意值作为一项追加到末尾，数组值也不会展开。"
                "返回完整对象或数组，不修改输入；只复制挂载路径上的容器，不深拷贝张量等值。"
                "路径不存在、下标越界或目标为标量时报错，不自动创建中间结构。"
            ),
            inputs=[
                io.MultiType.Input("content", types=[io.Dict, io.Array], display_name="对象或数组"),
                io.String.Input("expression", display_name="挂载访问语句", default="", multiline=False,
                                tooltip='例如 products[0].analysis 或 ["特殊.键名"]；留空挂载根位置。'),
                io.AnyType.Input("value", display_name="新增值"),
            ],
            outputs=[io.AnyType.Output(display_name="完整对象或数组")],
        )

    @classmethod
    def execute(cls, content, expression, value):
        target, parents = _js_path_target(content, expression)
        if isinstance(target, dict):
            if not isinstance(value, dict):
                raise ValueError("挂载位置是字典，新增值必须是包含键值对的字典。")
            conflicts = target.keys() & value.keys()
            if conflicts:
                raise ValueError(f"字段已存在，禁止覆盖：{list(conflicts)!r}。")
            result = {**target, **value}
        elif isinstance(target, list):
            result = [*target, value]
        else:
            raise ValueError("挂载位置必须是字典或数组，不能是字符串、数字、布尔值或 null。")
        for parent, key in reversed(parents):
            copied = parent.copy()
            copied[key] = result
            result = copied
        return io.NodeOutput(result)


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"JSON 包含重复键：{key!r}。")
        result[key] = value
    return result


def _invalid_json_constant(value):
    raise ValueError(f"JSON 不允许非有限数值：{value}。")


def _finite_json_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"JSON 数值超出有限浮点范围：{value}。")
    return result


def _strict_json(text):
    return json.loads(text, object_pairs_hook=_unique_json_object,
                      parse_constant=_invalid_json_constant, parse_float=_finite_json_float)


def _last_json_document(text):
    """Read a complete final document, never splice JSON with a greedy regex."""
    text = text.strip()
    stack = []
    quoted = escaped = False
    candidate = None
    start = 0
    for position, char in enumerate(text):
        if not stack:
            if char in "[{":
                start = position
                stack.append(char)
            continue
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            stack.append(char)
        elif char in "]}":
            if stack.pop() != ("[" if char == "]" else "{"):
                raise ValueError("JSON 括号不匹配。")
            if not stack:
                candidate = text[start:position + 1]
    if stack:
        raise ValueError("最后一个 JSON 文档未闭合，请提供完整的对象或数组。")
    if candidate is None:
        raise ValueError("输入文本中没有完整的 JSON 对象或数组。")
    return _strict_json(candidate)


def _record_field_type(value, kind):
    if kind.endswith("[]"):
        return type(value) is list and all(_record_field_type(item, kind[:-2]) for item in value)
    if kind == "nonempty_string":
        return type(value) is str and bool(value.strip())
    kinds = {"string": str, "integer": int, "boolean": bool,
             "object": dict, "array": list, "null": type(None)}
    if kind == "number":
        return type(value) in (int, float)
    return type(value) is kinds[kind]


class LiuxinyuParseJSONRecords(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuParseJSONRecords", display_name="解析并校验 JSON 记录数组",
            category="liuxinyu/结构化数据",
            description=(
                '从任意来源的文本中选取最后一个 JSON 对象或数组文档，要求结果为对象数组，并逐条检查必需字段与类型。'
                '支持附带说明和代码围栏；不回退到前面的文档。通过时输出完整数组、true 和空错误信息；'
                '校验不通过时输出空数组、false 和错误信息，不主动停止执行。由下游决定停止、重试或使用其他数据。'
                '不展开为执行列表，不补字段或自动转换字段类型。'
                '拒绝重复 JSON 键和非有限数值。字段规则是简单类型映射，不是 JSON Schema；详细规则和示例见同名帮助文档。'
            ),
            inputs=[io.String.Input("text", display_name="输入文本", multiline=True,
                                    tooltip='包含 JSON 对象数组的文本，例如 [{"id":"A"}]。可来自文件、接口、手动填写或其他文本节点。'),
                    io.String.Input("fields", display_name="必需字段与类型", default='{"id":"string"}', multiline=True,
                                    tooltip='JSON 对象，例如 {"id":"nonempty_string","tags":"string[]"}。按直接键检查；支持 string、nonempty_string、integer、number、boolean、object、array、null 及一层 [] 类型。'),
                    io.Boolean.Input("allow_extra", display_name="允许其他字段", default=False,
                                     tooltip='关闭时，每条记录的字段必须与规则一致；打开时保留额外字段，不检查其类型。必需字段仍不能缺少。')],
            outputs=[io.Array.Output(display_name="已校验记录数组"),
                     io.Boolean.Output(display_name="校验通过"),
                     io.String.Output(display_name="错误信息")],
        )

    @classmethod
    def execute(cls, text, fields, allow_extra=False):
        try:
            if not isinstance(text, str):
                raise ValueError("输入文本必须是字符串。")
            contract = _strict_json(fields)
            supported = {"string", "nonempty_string", "integer", "number", "boolean", "object", "array", "null"}
            if not isinstance(contract, dict) or any(
                not isinstance(kind, str) or kind.removesuffix("[]") not in supported
                for kind in contract.values()
            ):
                raise ValueError("字段契约需要是字段名到受支持类型的 JSON 对象。")
            rows = _last_json_document(text)
            if not isinstance(rows, list):
                raise ValueError("JSON 顶层需要是记录数组。")
            for index, row in enumerate(rows):
                if not isinstance(row, dict):
                    raise ValueError(f"第 {index + 1} 项需要是对象。")
                missing = contract.keys() - row.keys()
                extra = row.keys() - contract.keys()
                if missing or (extra and not allow_extra):
                    raise ValueError(f"第 {index + 1} 项字段不符合契约；缺少 {sorted(missing)}，额外 {sorted(extra)}。")
                for key, kind in contract.items():
                    if not _record_field_type(row[key], kind):
                        raise ValueError(f"第 {index + 1} 项的 {key!r} 必须是 {kind}。")
        except (ValueError, TypeError) as error:
            return io.NodeOutput([], False, str(error))
        return io.NodeOutput(rows, True, "")


class LiuxinyuArrayObjectPaths(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuArrayObjectPaths", display_name="可遍历字典的索引列表",
            category="liuxinyu/结构化数据",
            description=(
                '按配置遍历对象字段或数组元素，输出停止位置的路径，同时提供完整数组和逐项执行列表。'
                '层数 -1 表示遍历到底，正整数表示最多向下读取多少层；提前遇到标量或未开启遍历的容器即停止。'
                '默认只展开数组；根位置用空字符串表示，已展开的空容器不产生索引。保留原顺序，不修改输入。'
            ),
            inputs=[io.MultiType.Input("content", types=[io.Dict, io.Array], display_name="完整数据",
                                       tooltip='遍历的起点，接解析后的原生对象或数组。输出路径都相对于这个起点。'),
                    io.Int.Input("depth", display_name="嵌套读取层数", default=-1, min=-1,
                                 tooltip='-1 遍历到底；正整数最多读取对应层数。根为第 0 层，每读取一个字段或数组元素加 1；0 不适用。'),
                    io.Boolean.Input("include_fields", display_name="遍历字段", default=False,
                                     tooltip='开启后继续读取对象各字段；关闭时将对象整体作为一个索引目标。字段名用带引号的方括号保留。'),
                    io.Boolean.Input("include_arrays", display_name="遍历数组", default=True,
                                     tooltip='开启后继续读取数组各元素；关闭时将数组整体作为一个索引目标。')],
            outputs=[io.Array.Output(display_name="索引数组"),
                     io.String.Output(display_name="索引执行列表", is_output_list=True)],
        )

    @classmethod
    def execute(cls, content, depth=-1, include_fields=False, include_arrays=True):
        if not isinstance(content, (dict, list)):
            raise ValueError("完整数据需要是对象或数组。")
        if type(depth) is not int or depth == 0 or depth < -1:
            raise ValueError("嵌套读取层数必须是 -1 或正整数。")
        paths = []
        pending = [(content, "", 0, frozenset())]
        while pending:
            value, path, level, ancestors = pending.pop()
            descend_fields = isinstance(value, dict) and include_fields
            descend_array = isinstance(value, list) and include_arrays
            if (depth != -1 and level >= depth) or not (descend_fields or descend_array):
                paths.append(path)
                continue
            if id(value) in ancestors:
                raise ValueError(f"{path or '<根>'} 的遍历遇到循环引用。")
            ancestors = ancestors | {id(value)}
            if descend_fields:
                if any(not isinstance(key, str) for key in value):
                    raise ValueError("遍历对象字段时，字段名必须是字符串。")
                children = [(item, f"{path}[{json.dumps(key, ensure_ascii=False)}]", level + 1, ancestors)
                            for key, item in value.items()]
            else:
                children = [(item, f"{path}[{index}]", level + 1, ancestors)
                            for index, item in enumerate(value)]
            pending.extend(reversed(children))
        return io.NodeOutput(paths, list(paths))


class LiuxinyuBuildKeyValuePairs(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuBuildKeyValuePairs", display_name="组装键值对",
            category="liuxinyu/结构化数据",
            search_aliases=["构造字典", "键值对", "build dictionary", "key value"],
            description=(
                '将给定的键和值组装成一个新字典。单个字符串键输出 {键: 值}；'
                '字符串数组中的每个键都对应同一个完整值，空键数组输出空字典。'
                '键按字面文本使用，不解析路径或 JSON；值保留原始类型，数组值也不拆分。'
                '重复键报错；不提取字段、不修改已有容器、不深拷贝值。'
            ),
            inputs=[
                io.MultiType.Input(io.String.Input("key", default="key"), types=[io.String, io.Array],
                                   display_name="键",
                                   tooltip='填写一个键名，或连接字符串/字符串数组。数组内每个键使用同一个完整值；空字符串也是合法键名。'),
                io.AnyType.Input("value", display_name="值",
                                 tooltip='作为键对应的完整值，可为文本、数字、布尔值、null、对象、数组或其他原生值。'),
            ],
            outputs=[io.Dict.Output(display_name="字典")],
        )

    @classmethod
    def execute(cls, key, value):
        keys = [key] if isinstance(key, str) else key
        if not isinstance(keys, list) or any(not isinstance(item, str) for item in keys):
            raise ValueError("键需要是字符串或字符串数组；请先将其他类型转换为文本。")
        result = {}
        for item in keys:
            if item in result:
                raise ValueError(f"键重复，不能在一个字典中重复组装：{item!r}。")
            result[item] = value
        return io.NodeOutput(result)


class LiuxinyuStringToJSObject(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringToJSObject",
            display_name="字符串转为JS对象",
            category="utils/conversion",
            description=(
                "将标准 JSON 字符串反序列化为对象或数组，保留嵌套结构、数字、布尔值和 null。"
                "对象键和字符串使用英文双引号。不执行 JavaScript 表达式。"
                "数组作为一个完整值输出，不自动拆分为下游逐项执行的列表。"
                "ComfyUI 后端使用字典和列表承载对应的对象、数组数据。"
            ),
            inputs=[io.String.Input("text", display_name="字符串", default="{}", multiline=True)],
            outputs=[io.AnyType.Output(display_name="JS对象")],
        )

    @staticmethod
    def reject_constant(value):
        raise ValueError(f"JSON 不支持 {value}，请使用标准 JSON 数值或 null。")

    @classmethod
    def execute(cls, text):
        try:
            value = json.loads(text, parse_constant=cls.reject_constant)
        except json.JSONDecodeError as error:
            raise ValueError(f"JSON 格式错误：第 {error.lineno} 行，第 {error.colno} 列：{error.msg}") from error
        if not isinstance(value, (dict, list)):
            raise ValueError("请输入 JSON 对象或数组，例如 {\"name\":\"苹果\"} 或 [1,2,3]。")
        return io.NodeOutput(value)


class LiuxinyuPreviewJSObject(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPreviewJSObject",
            display_name="预览JS对象或数组",
            category="utils/string",
            is_input_list=True,
            is_output_node=True,
            description=(
                "以可展开的树状结构预览对象或数组，显示属性名、数组下标、数据类型和值。"
                "点选条目查看完整内容，支持复制 JSON；大量条目连续滚动，不分页。"
                "普通滚轮滚动预览，Ctrl 加滚轮缩放画布。仅预览，没有输出。"
            ),
            inputs=[io.MultiType.Input("content", types=[io.Dict, io.Array], display_name="对象或数组")],
            outputs=[],
        )

    @classmethod
    def execute(cls, content):
        if any(not isinstance(value, (dict, list)) for value in content):
            raise ValueError("请连接解析后的对象或数组，例如“字符串转为JS对象”的输出。")
        return io.NodeOutput(ui={"liuxinyu_object_preview": [{"items": content}]})


class LiuxinyuLoadTextFile(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuLoadTextFile",
            display_name="从文本文件中获取字符串",
            category="utils/string",
            description=(
                "通过路径读取文本文件，可使用选择文件按钮。文件内容不变时复用缓存，修改后自动重新读取。"
                "优先读取 UTF-8，识别带 BOM 的 UTF-16/32，非 UTF-8 时尝试 GB18030（兼容 GBK）。"
                "输出保留原有空格、换行，不包含编码 BOM，也不将文本中的反斜杠解释为转义。"
                "字符总数按 Unicode 码点计数，包含换行字符（CRLF 占两个字符）。"
                "行数为换行次数加一，CRLF、LF、CR 都视为一次换行；空文件为 0 行，末尾换行保留空行。"
            ),
            inputs=[io.String.Input("path", display_name="文件路径", default="", multiline=False,
                                    tooltip="文本文件的路径，可手动填写、连接上游或点击选择文件。")],
            outputs=[
                io.String.Output(display_name="文本内容"),
                io.Int.Output(display_name="字符总数"),
                io.Int.Output(display_name="行数"),
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, path):
        return file_changes.fingerprint("LiuxinyuLoadTextFile", path)

    @classmethod
    def execute(cls, path):
        file_changes.remember("LiuxinyuLoadTextFile", path)
        filename = path.strip()
        if len(filename) >= 2 and filename[0] == filename[-1] == '"':
            filename = filename[1:-1]
        if not filename:
            raise ValueError("请填写或选择文本文件路径。")
        try:
            data = Path(filename).read_bytes()
        except OSError as error:
            raise ValueError(f"无法读取文本文件：{filename}：{error}") from error
        try:
            if data.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
                text = data.decode("utf-32")
            elif data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
                text = data.decode("utf-16")
            else:
                try:
                    text = data.decode("utf-8-sig")
                except UnicodeDecodeError:
                    text = data.decode("gb18030")
        except UnicodeError as error:
            raise ValueError(f"无法识别文件的文本编码，请将文件保存为 UTF-8 后重试：{filename}") from error
        lines = len(re.findall(r"\r\n|\r|\n", text)) + 1 if text else 0
        return io.NodeOutput(text, len(text), lines)


class LiuxinyuStringConcatenate(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        string_template = io.Autogrow.TemplatePrefix(
            io.String.Input("string", force_input=True),
            prefix="string",
            min=0,
            max=100,
        )
        return io.Schema(
            node_id="LiuxinyuStringConcatenate",
            display_name="字符串拼接",
            category="utils/string",
            search_aliases=["文本拼接", "合并字符串", "string concatenate", "join strings"],
            description=(
                "按输入口从上到下的顺序直接拼接字符串，保留原有空格和换行。"
                "每连接一个输入就自动增加下一个，最多 100 路；更多输入可串联节点。"
                "没有输入时输出空字符串。"
            ),
            inputs=[
                io.Autogrow.Input(
                    "strings",
                    template=string_template,
                    display_name="字符串",
                    tooltip="按 string0、string1、string2… 的顺序拼接，不额外添加分隔符。",
                ),
            ],
            outputs=[io.String.Output(display_name="拼接字符串")],
        )

    @classmethod
    def execute(cls, strings: io.Autogrow.Type):
        ordered = sorted(strings.items(), key=lambda item: int(item[0][len("string"):]))
        return io.NodeOutput("".join(value for _, value in ordered if value is not None))


class LiuxinyuTextFromTemplate(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuTextFromTemplate",
            display_name="从模板生成文本",
            category="utils/string",
            search_aliases=["模板替换", "提示词模板", "text template"],
            description=(
                "将模板中的 {t1}、{t2}…替换为对应输入文本。未提供的参数保留原占位符，"
                "替换内容不再递归解析。连接参数组合后，忽略单独的 t1、t2…输入，"
                "由 ComfyUI 逐条处理组合并输出文本列表，可直接连接 CLIP 文本编码或其他提示词输入。"
                "动态参数最多 100 个。"
            ),
            is_input_list=True,
            inputs=[
                io.String.Input("template", display_name="模板", multiline=True,
                                default="你好，我喜欢喝{t1}，且我喜欢吃{t2}，我在{t3}里面做{t4}"),
                TemplateParameters.Input("parameters", display_name="参数组合", optional=True,
                                         tooltip="连接字符串排列组合的输出；连接后忽略独立 t1、t2…输入。"),
                io.Autogrow.Input(
                    "strings",
                    template=io.Autogrow.TemplateNames(
                        io.String.Input("text", force_input=True, lazy=True),
                        names=[f"t{i}" for i in range(1, 101)], min=0,
                    ),
                ),
            ],
            outputs=[io.String.Output(display_name="字符串数组", is_output_list=True)],
        )

    @classmethod
    def check_lazy_status(cls, template, strings=None, parameters=None):
        if parameters is not None or not isinstance(strings, dict):
            return []
        # V3 supplies (value, actual input id) for dynamic inputs in lazy checks.
        return [input_id for value, input_id in strings.values()
                if value is None or value == (None,)]

    @classmethod
    def execute(cls, template, strings=None, parameters=None):
        # Own the list mapping here so ignored t-input lists cannot add extra
        # executions when a parameter bundle is connected (even if cached).
        inputs = {"template": template}
        if parameters is not None:
            inputs["parameters"] = parameters
        else:
            inputs.update(strings or {})
        if any(not values for values in inputs.values()):
            return io.NodeOutput([])
        texts = []
        for index in range(max(len(values) for values in inputs.values())):
            row = {key: values[min(index, len(values) - 1)] for key, values in inputs.items()}
            pattern = row.pop("template")
            values = row["parameters"] if parameters is not None else row
            texts.append(PLACEHOLDER.sub(
                lambda match: values.get(match.group(1), match.group(0)), pattern,
            ))
        return io.NodeOutput(texts)


class LiuxinyuStringCombinations(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringCombinations",
            display_name="字符串排列组合",
            category="utils/string",
            search_aliases=["字符串笛卡尔积", "提示词组合", "string combinations"],
            description=(
                "输入至少两组候选字符串，枚举所有组合。每组可连接字符串列表，"
                '或连接一条 JSON 数组文本，例如 ["苹果", "香蕉", "梨子"]；普通文本视为一个候选，'
                "不按逗号或换行拆分。每条组合包含 t1、t2…的对应值，"
                "通过一个输出连接到从模板生成文本的参数组合输入。"
                "按输入顺序枚举，最后一组变化最快；各组长度可以不同，重复候选保留。最多 100 组。"
                "可设置同位去重：同一规则内任意两路的候选下标相同就排除该组合，不比较文本内容。"
                "多组规则用分号分隔；留空不去重。"
            ),
            is_input_list=True,
            inputs=[
                io.Autogrow.Input(
                    "groups",
                    template=io.Autogrow.TemplateNames(
                        io.String.Input("group", display_name="字符串数组", force_input=True),
                        names=[f"t{i}" for i in range(1, 101)], min=2,
                    ),
                    display_name="字符串数组",
                    tooltip='每个输入是一组候选字符串数组，按输入顺序对应模板的 t1、t2…；也可连接 JSON 数组文本，例如 ["苹果", "香蕉"]。',
                ),
                io.String.Input(
                    "exclude_same_index", display_name="同位去重", default="", optional=True,
                    multiline=False,
                    tooltip="例如 t1,t2 排除两路下标相同的组合；t1,t2,t3 要求三路下标两两不同。多组规则写成 t1,t2; t3,t4。留空关闭，只有一路的规则不生效。",
                ),
            ],
            outputs=[TemplateParameters.Output(display_name="参数组合", is_output_list=True)],
        )

    @classmethod
    def execute(cls, groups, exclude_same_index=None):
        ordered = sorted(groups.items(), key=lambda item: int(item[0][1:]))
        if len(ordered) < 2:
            raise ValueError("请至少连接两组候选字符串。")
        candidates = []
        for name, strings in ordered:
            # A real STRING list is already a group. A single JSON string also
            # permits constructing a group with an ordinary text input node.
            if len(strings) == 1 and strings[0].lstrip().startswith("["):
                try:
                    strings = json.loads(strings[0])
                except json.JSONDecodeError as error:
                    raise ValueError(f'{name} 的数组格式错误，请使用 JSON 字符串数组，如 ["苹果", "香蕉"]。') from error
            if not strings or not isinstance(strings, list) or not all(isinstance(value, str) for value in strings):
                raise ValueError(f"{name} 必须包含至少一条字符串。")
            candidates.append(strings)
        names = [name for name, _ in ordered]
        rules = exclude_same_index or [""]
        if len(rules) != 1:
            raise ValueError("同位去重请输入一条设置，多组规则请用分号分隔。")
        excluded_pairs = set()
        for rule in re.split(r"[;；]", rules[0]):
            members = list(dict.fromkeys(part.strip() for part in re.split(r"[,，]", rule) if part.strip()))
            for name in members:
                if name not in names:
                    raise ValueError(f"同位去重中的 {name} 不是已连接的输入，请使用 t1,t2 等输入名称。")
            positions = [names.index(name) for name in members]
            for index, left in enumerate(positions):
                for right in positions[index + 1:]:
                    excluded_pairs.add(tuple(sorted((left, right))))
        combinations = []
        for row in product(*(range(len(values)) for values in candidates)):
            if any(row[left] == row[right] for left, right in excluded_pairs):
                continue
            combinations.append({name: candidates[index][row[index]] for index, name in enumerate(names)})
        return io.NodeOutput(combinations)


class LiuxinyuPreviewText(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPreviewText", display_name="预览参数组合或字符串数组",
            category="utils/string", is_input_list=True, is_output_node=True,
            search_aliases=["预览参数组合", "预览字符串数组", "预览多行字符串", "文本预览"],
            description=(
                "连接参数组合、字符串数组或普通字符串，运行后查看内容。参数组合按 t1、t2…分列表格显示；"
                "字符串数组按原下标显示，单条字符串保留换行。连续滚动浏览，行列按可见区域动态显示。"
                "仅预览，没有输出，不修改或拆分输入文本。"
            ),
            inputs=[io.MultiType.Input(
                "content", types=[io.String, TemplateParameters],
                display_name="参数组合 / 字符串数组 / 字符串",
            )],
            outputs=[],
        )

    @classmethod
    def execute(cls, content):
        return io.NodeOutput(ui={"liuxinyu_preview": [{"items": content}]})


class LiuxinyuDynamicMultilineText(io.ComfyNode):
    MAX_BLOCKS = 100

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuDynamicMultilineText", display_name="动态多块多行字符串",
            category="utils/string",
            description="默认一块多行文本，点击添加按钮增加文本块及对应的输入、输出。每路独立：连接输入时输出上游字符串，否则输出框内文字。支持最多 100 块；文本随工作流保存。",
            inputs=[
                io.String.Input("blocks_json", default='[""]'),
                io.Autogrow.Input("texts", template=io.Autogrow.TemplateNames(
                    io.String.Input("text", force_input=True, optional=True),
                    names=[f"text{i}" for i in range(1, cls.MAX_BLOCKS + 1)], min=0,
                ), optional=True),
            ],
            # The UI reveals only active output slots; fixed slot identities keep
            # saved links and server-side output validation stable as blocks grow.
            outputs=[io.String.Output(display_name=f"文本{i}") for i in range(1, cls.MAX_BLOCKS + 1)],
        )

    @classmethod
    def execute(cls, blocks_json, texts=None):
        blocks = json.loads(blocks_json)
        if not isinstance(blocks, list) or not 1 <= len(blocks) <= cls.MAX_BLOCKS or not all(isinstance(text, str) for text in blocks):
            raise ValueError("文本块必须为包含 1 至 100 个字符串的数组。")
        connected = texts or {}
        return io.NodeOutput(*[
            connected.get(f"text{index + 1}", blocks[index] if index < len(blocks) else "")
            for index in range(cls.MAX_BLOCKS)
        ])


class LiuxinyuStringArrayGet(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringArrayGet", display_name="从字符串数组读取字符串",
            category="utils/string", is_input_list=True,
            description="按下标读取字符串数组中的元素。下标从 0 开始，越界时提示错误。",
            inputs=[
                io.String.Input("strings", display_name="字符串数组", force_input=True),
                io.Int.Input("index", display_name="下标", default=0, min=0, max=2147483647),
            ],
            outputs=[io.String.Output(display_name="字符串", is_output_list=True)],
        )

    @classmethod
    def execute(cls, strings, index):
        result = []
        for position in index:
            if position < 0 or position >= len(strings):
                raise ValueError(f"下标 {position} 超出范围，数组共 {len(strings)} 个元素，下标从 0 开始。")
            result.append(strings[position])
        return io.NodeOutput(result)


class LiuxinyuStringArrayBuild(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringArrayBuild", display_name="组装字符串为字符串数组",
            category="utils/string", is_input_list=True,
            description=(
                "按输入口从上到下的顺序组装字符串数组，保留空字符串、空格和换行。"
                "连接字符串数组时，按原顺序展开合并。至少一个输入，最多 100 个；可串联继续组装。"
            ),
            inputs=[io.Autogrow.Input(
                "strings", template=io.Autogrow.TemplateNames(
                    io.String.Input("string", display_name="字符串或字符串数组", force_input=True),
                    names=[f"string{i}" for i in range(1, 101)], min=1,
                ),
            )],
            outputs=[io.String.Output(display_name="字符串数组", is_output_list=True)],
        )

    @classmethod
    def execute(cls, strings):
        ordered = sorted(strings.items(), key=lambda item: int(item[0][len("string"):]))
        return io.NodeOutput([value for _, values in ordered for value in values])


class LiuxinyuStringArraySplit(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringArraySplit", display_name="切分字符串为数组",
            category="utils/string",
            description=(
                "按完整分隔文本切分，不使用正则表达式。连续分隔符及开头、末尾产生的空元素都会保留。"
                "保留分隔符时，将它追加到前一个元素末尾；拼接结果可还原原文。分隔符不能为空。"
            ),
            inputs=[
                io.String.Input("text", display_name="被切分字符串", force_input=True),
                io.String.Input("separator", display_name="分隔符", force_input=True,
                                tooltip="连接用作分隔符的字符串，可包含一个或多个字符；按换行切分时请传入实际换行。"),
                io.Boolean.Input("keep_separator", display_name="保留分隔符", default=False),
            ],
            outputs=[io.String.Output(display_name="字符串数组", is_output_list=True)],
        )

    @classmethod
    def execute(cls, text, separator, keep_separator):
        if not separator:
            raise ValueError("分隔符不能为空。")
        parts = text.split(separator)
        if keep_separator:
            parts = [part + separator for part in parts[:-1]] + parts[-1:]
        return io.NodeOutput(parts)


class LiuxinyuStringArrayJoin(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringArrayJoin", display_name="拼装字符串数组为字符串",
            category="utils/string", is_input_list=True,
            description="按数组顺序直接拼接所有字符串，不额外添加分隔符，保留原有空格和换行。",
            inputs=[io.String.Input("strings", display_name="字符串数组", force_input=True)],
            outputs=[io.String.Output(display_name="字符串")],
        )

    @classmethod
    def execute(cls, strings):
        return io.NodeOutput("".join(strings))


def _chinese_sort_key(text):
    # Windows' zh-CN locale provides pinyin collation without downloading a dictionary.
    mapper = ctypes.WinDLL("kernel32", use_last_error=True).LCMapStringEx
    mapper.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_wchar_p, ctypes.c_int,
                       ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                       ctypes.c_ssize_t]
    mapper.restype = ctypes.c_int
    size = mapper("zh-CN", 0x00000400, text, -1, None, 0, None, None, 0)
    if not size:
        raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(size)
    if not mapper("zh-CN", 0x00000400, text, -1, buffer, size, None, None, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return buffer.raw


def _string_natural_sort_key(text, chinese_keys):
    key = []
    for segment in re.findall(r"\d+|[^\d]", text):
        if segment.isdecimal():
            digits = "".join(str(unicodedata.decimal(char)) for char in segment).lstrip("0") or "0"
            key.append((1, len(digits), digits))
        elif "A" <= segment <= "Z":
            key.append((2, segment))
        elif "a" <= segment <= "z":
            key.append((3, segment))
        elif unicodedata.name(segment, "").startswith(("CJK UNIFIED IDEOGRAPH", "CJK COMPATIBILITY IDEOGRAPH")) or segment == "〇":
            if segment not in chinese_keys:
                chinese_keys[segment] = _chinese_sort_key(segment)
            key.append((5, chinese_keys[segment]))
        elif unicodedata.category(segment).startswith("L"):
            key.append((4, segment.casefold()))
        else:
            key.append((0, segment))
    return key


class LiuxinyuStringArraySort(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuStringArraySort", display_name="排序字符串数组",
            category="utils/string", is_input_list=True,
            description=(
                "逐段自然排序：符号、数字、大写字母、小写字母、其他文字、中文。"
                "连续数字按数值比较，如 A9 在 A10 前。符号之间按字符编码排序，空字符串在最前。"
                "中文采用 Windows 简体中文拼音排序，逐字比较，多音字不按句意推断。"
                "相同排序键保留原顺序；不修改文本，不去重。"
            ),
            inputs=[io.String.Input("strings", display_name="字符串数组", force_input=True)],
            outputs=[io.String.Output(display_name="字符串数组", is_output_list=True)],
        )

    @classmethod
    def execute(cls, strings):
        chinese_keys = {}
        return io.NodeOutput(sorted(strings, key=lambda text: _string_natural_sort_key(text, chinese_keys)))


class LiuxinyuAnyToString(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuAnyToString",
            display_name="任意转换为字符串",
            category="utils/conversion",
            search_aliases=["任意转字符串", "任意转文本", "any to string"],
            description="使用 Python str() 将任意输入转换为字符串；字符串原样返回，其他值使用其文本表示。",
            inputs=[io.AnyType.Input("value", display_name="任意")],
            outputs=[io.String.Output(display_name="字符串")],
        )

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(str(value))


class LiuxinyuJSObjectToString(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuJSObjectToString",
            display_name="js对象转换为字符串",
            category="utils/conversion",
            search_aliases=["对象转字符串", "数组转字符串", "json to string", "object to string"],
            description=(
                "把字符串、参数组合、对象或数组转换为字符串。字符串原样返回；"
                "对象、数组和参数组合使用 JSON 文本，保留中文和嵌套结构。"
                "连接数组或参数组合时整体转换为一个字符串，不逐项拆分。"
            ),
            inputs=[io.MultiType.Input(
                "value",
                types=[io.String, TemplateParameters, io.Dict, io.Array],
                display_name="值",
                tooltip="可连接字符串、参数组合、对象或数组。",
            )],
            outputs=[io.String.Output(display_name="字符串")],
        )

    @classmethod
    def execute(cls, value):
        if isinstance(value, str):
            return io.NodeOutput(value)
        if isinstance(value, (dict, list)):
            return io.NodeOutput(json.dumps(value, ensure_ascii=False))
        raise ValueError(f"无法把 {type(value).__name__} 转换为字符串：{value!r}")
