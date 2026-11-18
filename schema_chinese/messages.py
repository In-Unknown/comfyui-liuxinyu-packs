"""Chinese validation errors, author overrides and conservative repair suggestions."""

import json
import re

from .compiler import describe_schema as _describe_schema, _location
from .logic import forbidden_enum_fields


def validation_message(error, depth=0, *, root_schema=None, path_label=None):
    """Explain validator metadata in Chinese without parsing English messages."""
    location = path_label or _location
    def describe_schema(schema, **kwargs):
        return _describe_schema(schema, path_label=path_label, **kwargs)

    rule, limit, value = error.validator, error.validator_value, error.instance
    custom = error.schema.get("x-error-message") if isinstance(error.schema, dict) else None
    candidates = [custom.get(str(rule)), custom.get("default")] if isinstance(custom, dict) else [custom]
    for message in candidates:
        if isinstance(message, str) and message.strip():
            return message.strip()
    def field_name(name):
        return location((*error.absolute_path, name)) if path_label else name

    names = {"string": "文字", "integer": "整数", "number": "数字", "boolean": "布尔值（是／否）",
             "object": "键值对象", "array": "列表", "null": "空值（null）"}

    def show(item):
        text = json.dumps(item, ensure_ascii=False)
        return text if len(text) <= 100 else text[:97] + "…"

    if error.schema is False:
        return "模板不允许此处存在任何值，请移除此项或调整模板规则。"
    if rule == "type":
        expected = "或".join(names.get(kind, kind) for kind in (limit if isinstance(limit, list) else [limit]))
        kind = "null" if value is None else "boolean" if isinstance(value, bool) else "object" if isinstance(value, dict) else "array" if isinstance(value, list) else "string" if isinstance(value, str) else "integer" if isinstance(value, int) else "number"
        return f"需要填写{expected}，当前是{names[kind]}，请修改值或切换类型。"
    if rule == "required":
        missing = [field_name(name) for name in limit if name not in value]
        return f"缺少必填字段：{'、'.join(map(str, missing))}。请添加并填写这些字段。"
    if rule in ("minLength", "maxLength"):
        if rule == "minLength" and limit == 1:
            return "不能为空，请填写内容。"
        relation = "至少" if rule == "minLength" else "最多"
        return f"需要{relation} {limit} 个字符，当前有 {len(value)} 个。请{'补充' if rule == 'minLength' else '缩短'}内容。"
    if rule == "pattern":
        if limit in (r"\S", r".*\S.*"):
            return "不能为空或只包含空白字符，请至少填写一个非空白字符。"
        return f"文字格式不符合要求，请按模板规定的格式填写。匹配规则：{limit}"
    if rule in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"):
        relation = {"minimum": "大于或等于", "maximum": "小于或等于", "exclusiveMinimum": "大于", "exclusiveMaximum": "小于"}[rule]
        return f"数值必须{relation} {limit}，当前为 {show(value)}。"
    if rule == "multipleOf":
        return f"数值必须是 {limit} 的整数倍，当前为 {show(value)}。请按此步长填写。"
    if rule in ("minItems", "maxItems", "minProperties", "maxProperties"):
        unit = "项" if rule.endswith("Items") else "个字段"
        minimum = rule.startswith("min")
        return f"{'列表' if rule.endswith('Items') else '对象'}{'至少需要' if minimum else '最多允许'} {limit} {unit}，当前有 {len(value)} {unit}。请{'添加' if minimum else '移除多余'}{'条目' if rule.endswith('Items') else '字段'}。"
    if rule == "uniqueItems":
        return "列表中存在重复项，请删除重复项或修改内容，使各项互不重复。"
    if rule == "enum":
        choices = "、".join(show(item) for item in limit[:6]) + ("等" if len(limit) > 6 else "")
        return f"当前值不在可选范围内，请选择：{choices}。"
    if rule == "const":
        return f"此处必须使用固定值 {show(limit)}，请恢复该值。"
    if rule == "additionalProperties":
        props, patterns = error.schema.get("properties", {}), error.schema.get("patternProperties", {})
        extra = [name for name in value if name not in props and not any(re.search(pattern, name) for pattern in patterns)]
        return f"存在模板不允许的字段：{'、'.join(extra)}。请移除这些字段。"
    if rule == "unevaluatedProperties":
        return "包含未被当前有效规则允许的字段，请移除额外字段或检查所选结构方案。"
    if rule in ("items", "unevaluatedItems"):
        return "列表包含模板不允许的额外条目，请移除超出允许位置的条目。"
    if rule == "dependentRequired":
        missing = [f"填写“{field_name(key)}”后还需填写{'、'.join(field_name(name) for name in required if name not in value)}"
                   for key, required in limit.items() if key in value and any(name not in value for name in required)]
        return "；".join(missing) + "。"
    if rule in ("contains", "minContains", "maxContains"):
        minimum, maximum = error.schema.get("minContains", 1), error.schema.get("maxContains")
        requirement = f"至少 {minimum} 项" + (f"、最多 {maximum} 项" if maximum is not None else "")
        condition = describe_schema(error.schema.get("contains", True), root_schema=root_schema, path=("该项",))
        return f"列表中满足以下条件的条目数量必须{requirement}：\n{condition}"
    if rule in ("anyOf", "oneOf"):
        if rule == "oneOf" and not error.context:
            requirement = describe_schema({rule: limit}, root_schema=root_schema, path=tuple(error.absolute_path))
            return "当前内容同时符合多个结构方案，但模板只允许符合一种。具体要求：\n" + requirement
        requirement = describe_schema({rule: limit}, root_schema=root_schema, path=tuple(error.absolute_path))
        return "当前内容不符合任何可选结构方案。具体要求：\n" + requirement
    if rule == "not":
        fields = forbidden_enum_fields(limit, error.schema, value, list(error.absolute_path))
        if fields:
            repairs = [(path, current, options) for path, current, options in fields if options]
            if repairs:
                options = repairs[0][2]
                if all(json.dumps(item[2], sort_keys=True) == json.dumps(options, sort_keys=True) for item in repairs):
                    requirement = f"至少将以下字段中的一个设为 {'、'.join(show(item) for item in options)}：" + "、".join(location(path) for path, _, _ in repairs)
                else:
                    requirement = "至少完成以下一项修改：" + "；".join(f"{location(path)} 改为 {'、'.join(show(item) for item in options)}" for path, _, options in repairs)
                if len(fields) > 1 and all(json.dumps(item[1], sort_keys=True) == json.dumps(fields[0][1], sort_keys=True) for item in fields):
                    current = f"这 {len(fields)} 个字段均为 {show(fields[0][1])}"
                else:
                    current = "；".join(f"{location(path)} = {show(item)}" for path, item, _ in fields)
                return f"{requirement}。当前：{current}。修改后仍需满足其他字段规则。"
        requirement = describe_schema({"not": limit}, root_schema=root_schema, path=tuple(error.absolute_path))
        return f"{requirement}\n当前值：{show(value)}。请修改对应字段，使禁止的条件不再成立。"
    if rule == "format":
        return f"格式不正确，请按 {limit} 格式填写。"
    return "当前内容不符合以下要求：\n" + describe_schema(error.schema, root_schema=root_schema, path=tuple(error.absolute_path))
