"""Compile Schema syntax to a controlled Chinese requirement tree, without an LLM."""

from dataclasses import dataclass
import json
from typing import Any
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator
from referencing import Registry
from referencing.jsonschema import DRAFT202012
from .logic import forbidden_enum_fields

DIALECT = "https://json-schema.org/draft/2020-12/schema"
TYPES = {"object": "对象", "array": "数组", "string": "字符串", "integer": "整数", "number": "数值（包括整数）", "boolean": "布尔值", "null": "无值（null）"}
ANNOTATIONS = {"title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "$comment", "x-error-message"}
CORE = {"$schema", "$id", "$anchor", "$dynamicAnchor", "$defs", "$vocabulary"}
ASSERTIONS = {"type", "enum", "const", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "$ref", "$dynamicRef",
              "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern",
              "properties", "patternProperties", "additionalProperties", "unevaluatedProperties", "required", "propertyNames",
              "minProperties", "maxProperties", "dependentRequired", "dependentSchemas", "prefixItems", "items", "contains",
              "minContains", "maxContains", "minItems", "maxItems", "uniqueItems", "unevaluatedItems", "format",
              "contentEncoding", "contentMediaType", "contentSchema"}


class DescriptionError(ValueError):
    """Invalid dialect/input or an explicit description complexity limit."""


@dataclass(frozen=True)
class Rule:
    """An explicit logical group or atomic predicate, with its Schema source."""

    kind: str
    text: str
    children: tuple["Rule", ...] = ()
    schema_path: tuple = ()

    def render(self, indent=0):
        prefix = "  " * indent
        if not self.children:
            return prefix + self.text
        if all(not child.children for child in self.children):
            joined = "；".join(child.text for child in self.children)
            if self.kind == 'all' and len(joined) <= 160:
                return prefix + joined
            if self.kind in {'type_guard', 'property', 'prefix_item', 'items', 'then', 'else'} and len(self.text) + len(joined) <= 160:
                return prefix + self.text + '：' + joined
        rows = [prefix + self.text + "："]
        for index, child in enumerate(self.children, 1):
            lines = child.render(indent + 1).splitlines()
            rows.append(prefix + f"  {index}. " + lines[0].lstrip())
            rows.extend("   " + line for line in lines[1:])
        return "\n".join(rows)


@dataclass(frozen=True)
class Description:
    requirement: Rule
    definitions: tuple[tuple[str, Rule], ...]
    notices: tuple[str, ...]
    complete: bool

    @property
    def text(self):
        sections = [self.requirement.render()]
        sections.extend(f"{name}：\n{rule.render(1)}" for name, rule in self.definitions)
        if self.notices:
            sections.append("说明：\n" + "\n".join(f"- {note}" for note in self.notices))
        return "\n\n".join(sections)


def _load(schema):
    if isinstance(schema, str):
        try:
            schema = json.loads(schema)
        except (ValueError, RecursionError) as error:
            raise DescriptionError(f"Schema JSON 无法解析：{error}") from error
    if type(schema) not in (dict, bool):
        raise DescriptionError("Schema 必须是对象或布尔值。")
    try:
        json.dumps(schema, allow_nan=False)
        Draft202012Validator.check_schema(schema)
    except Exception as error:
        raise DescriptionError(f"Schema 定义无效：{error}") from error
    return schema


def _display(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _location(path):
    return ".".join(f"第{p + 1}项" if isinstance(p, int) else str(p) for p in path) or "当前值"


def _all(rules, source=()):
    if not rules:
        return Rule("true", "不限制取值", schema_path=source)
    if len(rules) == 1:
        return rules[0]
    return Rule("all", "以下要求全部满足", tuple(rules), source)


class _Compiler:
    def __init__(self, root, resources, format_assertion, max_depth, max_rules):
        registry = Registry()
        for uri, schema in (resources or {}).items():
            registry = registry.with_resource(uri, DRAFT202012.create_resource(_load(schema)))
        self.resolver = registry.resolver_with_root(DRAFT202012.create_resource(root))
        self.format_assertion = format_assertion
        self.max_depth, self.remaining = max_depth, max_rules
        self.definitions, self.targets, self.notices = {}, {}, []
        self.complete = True

    def note(self, text):
        if text not in self.notices:
            self.notices.append(text)

    def child(self, schema, resolver, path, source, depth):
        resolver = resolver.in_subresource(DRAFT202012.create_resource(schema))
        return self.compile(schema, resolver, path, source, depth + 1)

    def reference(self, ref, resolver, path, source, depth, dynamic=False):
        try:
            resolved = resolver.lookup(ref)
        except Exception:
            # No network retrieval: a document is only interpreted from supplied context.
            self.complete = False
            # URLs can contain authentication; expose no credentials/query in diagnostics.
            parsed = urlsplit(ref)
            label = f"{parsed.scheme}://{parsed.hostname}{parsed.path}" if parsed.netloc else ref
            self.note(f"引用 {_display(label)} 的目标不可用；请通过 resources 提供目标 Schema，尚未描述该目标的要求。")
            return Rule("unresolved_ref", f"{self.location(path)}须满足尚未提供的引用规则", schema_path=source)
        marker = (id(resolved.contents), resolved.resolver._base_uri)
        if marker not in self.targets:
            name = f"规则 R{len(self.targets) + 1}"
            self.targets[marker] = name
            self.definitions[name] = None
            self.definitions[name] = self.compile(resolved.contents, resolved.resolver, (), (name,), depth + 1)
        name = self.targets[marker]
        if dynamic:
            self.note("动态引用遵循 Draft 2020-12 的动态作用域：只有静态目标是动态锚点时，才由动态作用域中最外层匹配锚点替换；不能一律当成静态引用。")
            return Rule("dynamic_ref", f"{self.location(path)}须满足动态引用 {_display(ref)} 按动态作用域选定的规则（此描述上下文解析到{name}）", schema_path=source)
        return Rule("ref", f"{self.location(path)}须满足{name}", schema_path=source)

    def compile(self, schema, resolver, path, source, depth):
        self.remaining -= 1
        if depth > self.max_depth or self.remaining < 0:
            raise DescriptionError("规则超出描述复杂度上限；没有截断或省略规则，请提高 max_depth / max_rules。")
        if isinstance(schema, bool):
            return Rule("true" if schema else "false", "不限制取值" if schema else "不允许任何值", schema_path=source)
        if "$schema" in schema and schema["$schema"].rstrip("#") != DIALECT:
            raise DescriptionError(f"仅支持 Draft 2020-12，不能按此方言解释 {schema['$schema']}。")
        subject = self.location(path)
        rules = []
        def atom(key, text):
            return Rule("predicate", text, schema_path=(*source, key))
        def child(key, value, child_path=path, suffix=()):
            return self.child(value, resolver, child_path, (*source, key, *suffix), depth)
        if "type" in schema:
            kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            rules.append(atom("type", f"{subject}必须是{'或'.join(TYPES[t] for t in kinds)}"))
        if "const" in schema:
            rules.append(atom("const", f"{subject}等于 {_display(schema['const'])}"))
        if "enum" in schema:
            rules.append(atom("enum", f"{subject}只能取 {'、'.join(_display(v) for v in schema['enum'])} 中的一个值"))
        for key in ("$ref", "$dynamicRef"):
            if key in schema:
                rules.append(self.reference(schema[key], resolver, path, (*source, key), depth, key == "$dynamicRef"))
        for key, text in (("allOf", "以下条件全部满足"), ("anyOf", "以下条件至少满足一项"), ("oneOf", "以下条件恰好满足一项")):
            if key in schema:
                rules.append(Rule(key, text, tuple(child(key, item, suffix=(i,)) for i, item in enumerate(schema[key])), (*source, key)))
        if "not" in schema:
            fields = forbidden_enum_fields(schema['not'], schema, path=path)
            if fields:
                alternatives = [atom('not', f"{self.location(p)}取 {'、'.join(_display(item) for item in values)} 中的一个值") for p, _, values in fields if values]
                rules.append(Rule("anyOf", "以下条件至少满足一项", tuple(alternatives), (*source, "not")) if alternatives else atom('not', '不允许任何值：所有合法的字段取值组合均被禁止'))
            else:
                rules.append(Rule("not", "不能满足以下条件", (child("not", schema["not"]),), (*source, "not")))
        if "if" in schema and ("then" in schema or "else" in schema):
            branches = [Rule("condition", "判断条件", (child("if", schema["if"]),))]
            for key, text in (("then", "条件成立时"), ("else", "条件不成立时")):
                branches.append(Rule(key, text, (child(key, schema.get(key, True)),)))
            rules.append(Rule("if", "按条件选择要求（条件本身不要求必须成立）", tuple(branches), (*source, "if")))

        numeric, strings, objects, arrays = [], [], [], []
        for key, relation in (("minimum", "≥"), ("maximum", "≤"), ("exclusiveMinimum", ">"), ("exclusiveMaximum", "<")):
            if key in schema:
                numeric.append(atom(key, f"{subject}必须 {relation} {_display(schema[key])}"))
        if "multipleOf" in schema:
            numeric.append(atom("multipleOf", f"{subject}必须是 {_display(schema['multipleOf'])} 的整数倍"))
        for key, relation in (("minLength", "至少"), ("maxLength", "至多")):
            if key in schema:
                strings.append(atom(key, f"{subject}长度{relation} {schema[key]} 个 Unicode 码点"))
        if "pattern" in schema:
            strings.append(atom("pattern", f"{subject}须含有匹配正则表达式 {_display(schema['pattern'])} 的片段（ECMA-262；不是默认匹配整个字符串）"))
        if "format" in schema:
            if self.format_assertion:
                strings.append(atom("format", f"{subject}须符合 {_display(schema['format'])} 格式；格式的支持范围由启用断言的校验器确定"))
            else:
                self.note(f"{subject}的 format={_display(schema['format'])} 是格式注解，不作为通过／失败条件。")
        for key in ("contentEncoding", "contentMediaType", "contentSchema"):
            if key in schema:
                self.note(f"{subject}的 {key} 是内容注解；默认方言不据此自动解码、解析或判定校验失败。")

        if schema.get("required"):
            objects.append(atom("required", "必须包含字段 " + "、".join(self.location((*path, name)) for name in schema["required"]) + "（存在键即可；值的要求另行检查）"))
        for name, item in schema.get("properties", {}).items():
            # properties itself never requires the key to exist.
            objects.append(Rule("property", f"字段 {self.location((*path, name))} 存在时", (child("properties", item, (*path, name), (name,)),), (*source, "properties", name)))
        for pattern, item in schema.get("patternProperties", {}).items():
            objects.append(Rule("pattern_property", f"每个键名包含正则 {_display(pattern)} 匹配片段的字段都须满足（多条匹配规则同时适用）", (child("patternProperties", item, ("该字段的值",), (pattern,)),), (*source, "patternProperties", pattern)))
        if "propertyNames" in schema:
            objects.append(Rule("property_names", "每个字段名作为字符串须满足", (child("propertyNames", schema["propertyNames"], ("字段名",)),), (*source, "propertyNames")))
        if "additionalProperties" in schema:
            names = "、".join(_display(name) for name in schema.get("properties", {})) or "无"
            patterns = "、".join(_display(pattern) for pattern in schema.get("patternProperties", {})) or "无"
            objects.append(Rule("additional_properties", f"本层 properties 未列出且键名不匹配本层 patternProperties 的字段（已列字段：{names}；匹配规则：{patterns}）", (child("additionalProperties", schema["additionalProperties"], ("该字段的值",)),), (*source, "additionalProperties")))
        if "unevaluatedProperties" in schema:
            objects.append(Rule("unevaluated_properties", "同一对象中，经相关规则成功求值后仍未标记为已评估的字段", (child("unevaluatedProperties", schema["unevaluatedProperties"], ("该字段的值",)),), (*source, "unevaluatedProperties")))
        for key, relation in (("minProperties", "至少"), ("maxProperties", "至多")):
            if key in schema:
                objects.append(atom(key, f"{subject}包含{relation} {schema[key]} 个字段"))
        for name, required in schema.get("dependentRequired", {}).items():
            if required:
                objects.append(atom("dependentRequired", f"字段 {self.location((*path, name))} 存在时，还必须包含 " + "、".join(self.location((*path, other)) for other in required)))
        for name, item in schema.get("dependentSchemas", {}).items():
            objects.append(Rule("dependent_schema", f"字段 {self.location((*path, name))} 存在时，整个对象还须满足", (child("dependentSchemas", item, path, (name,)),), (*source, "dependentSchemas", name)))

        for key, relation in (("minItems", "至少"), ("maxItems", "至多")):
            if key in schema:
                arrays.append(atom(key, f"{subject}包含{relation} {schema[key]} 项"))
        if schema.get("uniqueItems"):
            arrays.append(atom("uniqueItems", f"{subject}各项的 JSON 值不得重复（比较完整值，不只比较某个字段）"))
        for index, item in enumerate(schema.get("prefixItems", [])):
            arrays.append(Rule("prefix_item", f"第 {index + 1} 项存在时", (child("prefixItems", item, (*path, index), (index,)),), (*source, "prefixItems", index)))
        if "items" in schema:
            count = len(schema.get("prefixItems", []))
            arrays.append(Rule("items", f"从第 {count + 1} 项起的每一项" if count else "每一项", (child("items", schema["items"], ("该项",)),), (*source, "items")))
        if "contains" in schema:
            minimum, maximum = schema.get("minContains", 1), schema.get("maxContains")
            quantity = f"至少 {minimum} 项" + (f"且至多 {maximum} 项" if maximum is not None else "")
            arrays.append(Rule("contains", f"满足下列条件的元素数量必须{quantity}", (child("contains", schema["contains"], ("该项",)),), (*source, "contains")))
        elif "minContains" in schema or "maxContains" in schema:
            self.note(f"{subject}未设置 contains；minContains / maxContains 不产生校验要求。")
        if "unevaluatedItems" in schema:
            arrays.append(Rule("unevaluated_items", "同一数组中，经相关规则成功求值后仍未标记为已评估的每一项", (child("unevaluatedItems", schema["unevaluatedItems"], ("该项",)),), (*source, "unevaluatedItems")))

        declared = schema.get("type")
        declared = set(declared if isinstance(declared, list) else [declared]) if declared else set()
        for kind, predicates in (("number", numeric), ("string", strings), ("object", objects), ("array", arrays)):
            if not predicates:
                continue
            types = {"number", "integer"} if kind == "number" else {kind}
            if declared and declared <= types:
                rules.extend(predicates)
            else:
                rules.append(Rule("type_guard", f"仅当{subject}是{TYPES[kind]}时", tuple(predicates), source))
        for key in schema:
            if key not in ANNOTATIONS | CORE | ASSERTIONS:
                self.note(f"关键字 {_display(key)} 未注册校验语义；按默认方言作为扩展注解处理，不推断为额外约束。")
        return _all(rules, source)


def describe(schema: Any, *, root_schema=None, path=(), resources=None, format_assertion=False, max_depth=64, max_rules=10000, path_label=None):
    """Return a requirement tree and Chinese text; never fetch external resources.

    path is a sequence of actual object keys / zero-based array indices. Optional
    resources maps reference URIs to Schema documents. Missing references set
    complete=False; complexity limits raise instead of silently dropping rules.
    """
    schema = _load(schema)
    root = _load(root_schema) if root_schema is not None else schema
    if not isinstance(path, (tuple, list)):
        raise DescriptionError("path 必须是字段名／数组下标组成的列表或元组。")
    compiler = _Compiler(root, resources, format_assertion, max_depth, max_rules)
    compiler.location = path_label or _location
    resolver = compiler.resolver if schema is root else compiler.resolver.in_subresource(DRAFT202012.create_resource(schema))
    rule = compiler.compile(schema, resolver, tuple(path), (), 0)
    return Description(rule, tuple(compiler.definitions.items()), tuple(compiler.notices), compiler.complete)


def describe_schema(schema: Any, **kwargs):
    """Return the complete readable text (requirements, definitions and notices)."""
    return describe(schema, **kwargs).text
