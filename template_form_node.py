"""Draft 2020-12 forms with human confirmation and validated reuse."""

import asyncio
from collections import OrderedDict
from copy import deepcopy
from fractions import Fraction
from functools import lru_cache
import json
import logging
import math
import re
import threading
import uuid
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from aiohttp import web
from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry
from referencing.jsonschema import DRAFT202012
from server import PromptServer
from comfy_api.latest import io
from comfy_execution.utils import get_executing_context
from comfy.model_management import InterruptProcessingException, throw_exception_if_processing_interrupted
from template_form_notifications import dispatch as dispatch_notification
from schema_chinese import explain_error as validation_message

DIALECT = "https://json-schema.org/draft/2020-12/schema"
JSON_VALUE = io.Custom("DICT,ARRAY,STRING,INT,FLOAT,BOOLEAN,NULL")
PENDING = {}
LOCK = threading.Lock()
CONFIRMED_IN_PROMPT = OrderedDict()
NOTICES = OrderedDict()
PAGES = OrderedDict()
ACTIVATIONS = {}


async def send_notice(record):
    if record.get("sent") or record.get("foreground") or record.get("closed"):
        return
    record["sent"] = True
    entry = record["entry"]
    request_id = entry["request_id"]
    port = getattr(PromptServer.instance, "port", 8188)
    message = f"节点 {entry['node_id']} " + ("已复用确认值，继续执行。" if record["reused"] else "正在等待填写表单。点击返回对应节点。")
    try:
        await asyncio.to_thread(dispatch_notification, request_id, message, f"comfyui-liuxinyu-form://activate/{port}/{request_id}")
        if record.get("closed"):
            await asyncio.to_thread(dispatch_notification, request_id)
    except (OSError, RuntimeError, TimeoutError) as error:
        logging.warning("[liuxinyu.TemplateForm] %s", error)
        PromptServer.instance.send_sync("liuxinyu.template_form_notification_error", {"message": str(error)}, record["client_id"])


def register_notice(entry, workflow, client_id, reused=False):
    record = {"entry": entry, "workflow": workflow, "client_id": client_id, "reused": reused}
    NOTICES[entry["request_id"]] = record
    while len(NOTICES) > 128:
        NOTICES.popitem(last=False)
    async def fallback():
        await asyncio.sleep(1)
        await send_notice(record)
    record["task"] = asyncio.create_task(fallback())


async def notice_presence(request):
    data = await request.json()
    client_id = data.get("client_id")
    if not isinstance(client_id, str) or not client_id:
        return web.json_response({"error": "缺少页面连接标识"}, status=400)
    PAGES[client_id] = str(data.get("workflow_id", ""))
    PAGES.move_to_end(client_id)
    while len(PAGES) > 128:
        PAGES.popitem(last=False)
    record = NOTICES.get(data.get("request_id"))
    if record and PAGES[client_id] == record["entry"]["workflow_id"]:
        record["foreground"] = data.get("foreground") is True
        if not record["foreground"]:
            await send_notice(record)
    return web.json_response({"ok": True})


async def notification_target(request):
    record = NOTICES.get(request.match_info["token"])
    if not record or record.get("closed"):
        return web.json_response({"error": "这次表单填写已结束，或后端已重启，通知已失效。"}, status=410)
    return web.json_response({"entry": record["entry"], "workflow": record["workflow"]}, headers={"Cache-Control": "no-store"})


async def activate_notice(request):
    token = request.match_info["token"]
    record = NOTICES.get(token)
    if not record or record.get("closed"):
        return web.json_response({"existing": False})
    server = PromptServer.instance
    candidates = [client for client, workflow in reversed(PAGES.items())
                  if workflow == record["entry"]["workflow_id"] and client in server.sockets]
    for client in candidates[:3]:
        future = asyncio.get_running_loop().create_future()
        activation_id = uuid.uuid4().hex
        ACTIVATIONS[activation_id] = (client, future)
        try:
            server.send_sync("liuxinyu.template_form_activate", {"entry": record["entry"], "activation_id": activation_id}, client)
            result = await asyncio.wait_for(future, 1.5)
            if result.get("existing"):
                return web.json_response(result)
        except asyncio.TimeoutError:
            continue
        finally:
            ACTIVATIONS.pop(activation_id, None)
    return web.json_response({"existing": False})


async def activated_notice(request):
    data = await request.json()
    waiting = ACTIVATIONS.get(data.get("activation_id"))
    if waiting and waiting[0] == data.get("client_id") and not waiting[1].done():
        waiting[1].set_result({"existing": data.get("existing") is True, "focused": data.get("focused") is True,
                               "title": f"ComfyUI 表单 {data['activation_id']}"})
    return web.json_response({"ok": True})


async def close_notice(token):
    record = NOTICES.get(token)
    if not record:
        return
    record["closed"] = True
    if record.get("sent"):
        try:
            await asyncio.to_thread(dispatch_notification, token)
        except (OSError, RuntimeError) as error:
            logging.warning("[liuxinyu.TemplateForm] 清理通知失败：%s", error)


def schema_structure(schema):
    """Ignore annotations/value constraints, never property names or schema branches."""
    if not isinstance(schema, dict):
        return schema
    annotations_constraints = {
        "$schema", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "x-error-message",
        "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength",
        "pattern", "format", "enum", "const", "required", "minProperties", "maxProperties", "minItems", "maxItems",
        "uniqueItems", "minContains", "maxContains", "dependentRequired", "contentEncoding", "contentMediaType",
    }
    maps = {"$defs", "properties", "patternProperties", "dependentSchemas"}
    lists = {"allOf", "anyOf", "oneOf", "prefixItems"}
    singles = {"items", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
               "propertyNames", "if", "then", "else", "not", "contentSchema"}
    result = {}
    for key, value in schema.items():
        if key in annotations_constraints:
            continue
        if key in maps:
            result[key] = {name: schema_structure(item) for name, item in value.items()}
        elif key in lists:
            result[key] = [schema_structure(item) for item in value]
        elif key in singles:
            result[key] = schema_structure(value)
        else:
            result[key] = value
    return result


def reusable(stored, schema):
    return (isinstance(stored, dict) and stored.get("confirmed") is True and "value" in stored
            and "schema" in stored and schema_structure(stored["schema"]) == schema_structure(schema)
            and not validate_value(schema, stored["value"])[1])


def decimal_multiple(validator, divisor, instance, schema):
    if validator.is_type(instance, "number"):
        # JSON decimal multiples must not fail because 0.3 / 0.1 is a binary float.
        if Fraction(str(instance)) % Fraction(str(divisor)) != 0:
            yield ValidationError(f"{instance} is not a multiple of {divisor}")


FormValidator = validators.extend(Draft202012Validator, {"multipleOf": decimal_multiple})


def json_copy(value, depth=0, schema=False):
    if depth > 64:
        raise ValueError("JSON 嵌套超过 64 层，无法在节点内安全编辑。")
    if value is None or type(value) in (str, bool):
        return value
    if type(value) in (int, float):
        if (not schema and abs(value) > 2**53 - 1) or type(value) is float and not math.isfinite(value):
            raise ValueError("数字必须有限且在浏览器安全数值范围 ±(2^53-1) 内；大编号请用字符串。")
        return value
    if type(value) is list:
        return [json_copy(item, depth + 1, schema) for item in value]
    if type(value) is dict and all(type(key) is str for key in value):
        return {key: json_copy(item, depth + 1, schema) for key, item in value.items()}
    raise ValueError("仅接受原生 JSON 值，不接受张量、元组、自定义对象或非字符串键。")


def parse_schema(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, RecursionError) as error:
            raise ValueError(f"Schema JSON 解析失败：{error}") from error
    value = json_copy(value, schema=True)
    if type(value) not in (dict, bool):
        raise ValueError("JSON Schema 必须是对象或布尔值。")
    try:
        Draft202012Validator.check_schema(value)
    except SchemaError as error:
        raise ValueError(f"Schema 定义错误 /{'/'.join(map(str, error.path))}：{validation_message(error)}") from error

    # Walk schema locations only: defaults/const/enum are data, not schemas.
    def visit(schema):
        if not isinstance(schema, dict):
            return
        if "$schema" in schema and schema["$schema"].rstrip("#") != DIALECT:
            raise ValueError("只接受 JSON Schema Draft 2020-12，不能混用旧版关键字语义。")
        # In this dialect format is an annotation. A vocabulary declaration in
        # an instance schema does not turn it into a different meta-schema.
        for key in ("$defs", "properties", "patternProperties", "dependentSchemas"):
            for item in schema.get(key, {}).values():
                visit(item)
        for key in ("allOf", "anyOf", "oneOf", "prefixItems"):
            for item in schema.get(key, []):
                visit(item)
        for key in ("items", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
                    "propertyNames", "if", "then", "else", "not", "contentSchema"):
            if key in schema:
                visit(schema[key])
    visit(value)
    return value


class FormSchemaContext:
    def __init__(self, schema):
        self.resources = {}
        self.registry = Registry(retrieve=self.retrieve)
        self.resolver = self.registry.resolver_with_root(DRAFT202012.create_resource(schema))

    def retrieve(self, uri):
        if uri in self.resources:
            return self.resources[uri]
        if urlsplit(uri).scheme not in ("http", "https"):
            raise ValueError("外部引用必须为 HTTP(S) 地址，或在输入 Schema 中通过 $id 提供对应资源。")
        if len(self.resources) >= 20:
            raise ValueError("本表单外部 Schema 超过 20 个资源，请合并资源后重试。")
        try:
            with urlopen(Request(uri, headers={"Accept": "application/schema+json, application/json"}), timeout=10) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError("单个外部 Schema 超过 8 MiB")
            schema = parse_schema(raw.decode("utf-8-sig"))
        except Exception as error:
            # Do not expose credentials/query strings embedded in reference URLs.
            raise ValueError(f"无法取得外部 Schema（主机 {urlsplit(uri).hostname}）：{type(error).__name__}") from None
        resource = DRAFT202012.create_resource(schema)
        self.resources[uri] = resource
        return resource

    def validator(self, schema, resolver=None):
        return FormValidator(schema, registry=self.registry, _resolver=resolver or self.resolver)

    def child(self, schema, resolver):
        return schema, resolver.in_subresource(DRAFT202012.create_resource(schema))

    def expand(self, entries, value, seen=None):
        seen = set() if seen is None else seen
        result = []
        for schema, resolver in entries:
            if schema is True:
                continue
            if schema is False:
                return [(False, resolver)]
            marker = (id(schema), resolver._base_uri)
            if marker in seen:
                continue
            visited = seen | {marker}
            result.append(({k: v for k, v in schema.items() if k not in ("$ref", "$dynamicRef", "allOf", "if", "then", "else", "dependentSchemas")}, resolver))
            for keyword in ("$ref", "$dynamicRef"):
                if keyword in schema:
                    resolved = resolver.lookup(schema[keyword])
                    result.extend(self.expand([(resolved.contents, resolved.resolver)], value, visited))
            for child in schema.get("allOf", []):
                result.extend(self.expand([self.child(child, resolver)], value, visited))
            if "if" in schema:
                condition, condition_resolver = self.child(schema["if"], resolver)
                branch = "then" if self.validator(condition, condition_resolver).is_valid(value) else "else"
                if branch in schema:
                    result.extend(self.expand([self.child(schema[branch], resolver)], value, visited))
            if isinstance(value, dict):
                for key, child in schema.get("dependentSchemas", {}).items():
                    if key in value:
                        result.extend(self.expand([self.child(child, resolver)], value, visited))
        return result

    def presentation(self, schema, value, entries=None, depth=0, budget=None):
        # This is only a view of applicable fields. Validation always uses the
        # original schema, including constraints that have no dedicated widget.
        budget = [4000] if budget is None else budget
        budget[0] -= 1
        if depth > 32 or budget[0] < 0:
            return {"description": "深层结构继续使用通用字段编辑，确认时校验原始规则。"}
        entries = self.expand(entries if entries is not None else [(schema, self.resolver)], value)
        if any(s is False for s, _ in entries):
            return False
        for index, (s, resolver) in enumerate(entries):
            keyword = "oneOf" if "oneOf" in s else "anyOf" if "anyOf" in s else None
            if keyword:
                plain = {k: v for k, v in s.items() if k not in ("oneOf", "anyOf", "$ref", "$dynamicRef", "allOf", "if", "then", "else", "dependentSchemas")}
                base = entries[:index] + [(plain, resolver)] + entries[index + 1:]
                return {keyword: [self.presentation(schema, value, base + [self.child(child, resolver)], depth + 1, budget)
                                  for child in s[keyword]], "title": s.get("title", "")}
        result = {}
        allowed = {"object", "array", "string", "number", "integer", "boolean", "null"}
        constrained = False
        for s, _ in entries:
            if "type" in s:
                types = {s["type"]} if isinstance(s["type"], str) else set(s["type"])
                if "number" in types:
                    types.add("integer")
                allowed &= types
                constrained = True
            for key in ("title", "description", "default", "format", "pattern", "const", "enum", "multipleOf"):
                if key in s:
                    result[key] = s[key]
            for key in ("minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"):
                if key in s:
                    result[key] = max(result.get(key, s[key]), s[key])
            for key in ("maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"):
                if key in s:
                    result[key] = min(result.get(key, s[key]), s[key])
        if constrained:
            if not allowed:
                return False
            if "number" in allowed:
                allowed.discard("integer")
            result["type"] = sorted(allowed)[0] if len(allowed) == 1 else sorted(allowed)
        props, required = {}, set()
        names = list(value) if isinstance(value, dict) else []
        for s, _ in entries:
            names.extend(s.get("properties", {}))
            names.extend(s.get("required", []))
            required.update(s.get("required", []))
            if isinstance(value, dict):
                for key, dependencies in s.get("dependentRequired", {}).items():
                    if key in value:
                        names.extend(dependencies)
                        required.update(dependencies)
        for name in dict.fromkeys(names):
            child_entries = []
            for s, resolver in entries:
                matched = name in s.get("properties", {})
                if matched:
                    child_entries.append(self.child(s["properties"][name], resolver))
                for pattern, child in s.get("patternProperties", {}).items():
                    if re.search(pattern, name):
                        matched = True
                        child_entries.append(self.child(child, resolver))
                if not matched and "additionalProperties" in s:
                    child_entries.append(self.child(s["additionalProperties"], resolver))
            child_value = value.get(name) if isinstance(value, dict) else None
            # Do not infinitely pre-expand recursive, absent optional fields.
            props[name] = self.presentation(schema, child_value, child_entries, depth + 1, budget) if depth < 8 or isinstance(value, dict) and name in value else True
        if props:
            result["properties"] = props
        if required:
            result["required"] = sorted(required)
        # Every expanded entry applies together. An annotation-only $ref wrapper
        # does not relax a referenced object's ban on arbitrary new properties.
        if any(s.get("additionalProperties") is False and not s.get("patternProperties") for s, _ in entries):
            result["additionalProperties"] = False
        length = max([len(value) if isinstance(value, list) else 0] + [len(s.get("prefixItems", [])) for s, _ in entries])
        if length:
            result["prefixItems"] = []
            for index in range(length):
                children = [self.child(s["prefixItems"][index] if index < len(s.get("prefixItems", [])) else s.get("items", True), resolver) for s, resolver in entries]
                item = value[index] if isinstance(value, list) and index < len(value) else None
                result["prefixItems"].append(self.presentation(schema, item, children, depth + 1, budget))
        tails = [self.child(s.get("items", True), resolver) for s, resolver in entries if "items" in s]
        if tails:
            result["items"] = self.presentation(schema, None, tails, depth + 1, budget) if depth < 8 else True
        return result


@lru_cache(maxsize=16)
def schema_context(serialized):
    return FormSchemaContext(json.loads(serialized))


def context_for(schema):
    return schema_context(json.dumps(schema, ensure_ascii=False))


def display_path(presentation, value, path):
    labels = []
    candidates = [presentation]
    for part in path:
        expanded = []
        for item in candidates:
            if isinstance(item, dict):
                expanded.extend(item.get("oneOf", item.get("anyOf", [item])))
        children = []
        for item in expanded:
            if not isinstance(item, dict):
                continue
            if isinstance(part, int):
                prefix = item.get("prefixItems", [])
                children.append(prefix[part] if part < len(prefix) else item.get("items", {}))
            else:
                children.append(item.get("properties", {}).get(part, {}))
        titles = {item.get("title") for item in children if isinstance(item, dict) and item.get("title")}
        title = next(iter(titles)) if len(titles) == 1 else None
        if isinstance(part, int):
            label = f"元素 {part}" + (f" · {title}" if title else "")
            member = value[part] if isinstance(value, list) and part < len(value) else None
            for item in children:
                if isinstance(item, dict) and item.get("type") == "object" and isinstance(member, dict):
                    name = next((member[key] for key in item.get("properties", {})
                                 if isinstance(member.get(key), str) and member[key].strip()), None)
                    if name:
                        label = name
                        break
            value = member
        else:
            label = title or str(part)
            value = value.get(part) if isinstance(value, dict) else None
        labels.append(label)
        candidates = children
    return ".".join(labels) or "整个表单"


def validate_value(schema, value):
    presentation = None
    def path_label(path):
        nonlocal presentation
        if presentation is None:
            presentation = context_for(schema).presentation(schema, value)
        return display_path(presentation, value, path)

    value = json_copy(value)
    validator = context_for(schema).validator(schema)
    errors = []
    seen = set()
    try:
        for error in validator.iter_errors(value):
            path = "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in error.absolute_path) if error.absolute_path else "$"
            parts = list(error.absolute_path)
            location = " → ".join(f"第 {part + 1} 项" if isinstance(part, int) else str(part) for part in parts) or "整个表单"
            message = validation_message(error, root_schema=schema)
            display_message = validation_message(error, root_schema=schema, path_label=path_label)
            key = (path, str(error.validator), message)
            if key in seen:
                continue
            seen.add(key)
            errors.append({"path": path, "rule": str(error.validator), "message": message, "display_message": display_message,
                           "location": location, "field": str(parts[-1]) if parts and not isinstance(parts[-1], int) else f"第 {parts[-1] + 1} 项" if parts else "整个表单",
                           "technical_message": error.message,
                           "schema_path": "/" + "/".join(map(str, error.absolute_schema_path))})
    except Exception as error:
        # An unresolved reference is not a successful validation.
        raise ValueError(f"Schema 校验无法完成：{error}") from error
    return value, errors


def public_request(entry):
    return {key: entry[key] for key in ("request_id", "node_id", "workflow_id", "schema", "value", "has_value")}


def insert_type_backups(schema, value, candidates):
    """Keep conflict values only when their new sibling key introduces no rule violation."""
    value = json_copy(value)
    if not isinstance(candidates, list) or len(candidates) > 1000:
        raise ValueError("类型冲突备份一次最多处理 1000 项")
    validator = context_for(schema).validator(schema)

    def failures():
        result = set()

        def collect(error):
            if error.context:
                for child in error.context:
                    collect(child)
            else:
                # These object rules can report different offending keys at the
                # same schema/path. Other existing field errors must not prevent
                # a legal backup elsewhere in an unfinished form.
                detail = error.message if "propertyNames" in error.absolute_schema_path or error.validator in {
                    "additionalProperties", "unevaluatedProperties", "propertyNames",
                    "required", "dependentRequired", "maxProperties", "minProperties",
                } else ""
                result.add((tuple(error.absolute_path), tuple(error.absolute_schema_path), str(error.validator), detail))
        for error in validator.iter_errors(value):
            collect(error)
        return result

    decisions = []
    for candidate in candidates:
        parent = value
        view = context_for(schema).presentation(schema, value)
        path, source = candidate["path"], candidate["key"]
        if not isinstance(path, str) or not isinstance(source, str) or not (path == "$" or path.startswith("$/")):
            raise ValueError("类型冲突备份路径无效")
        try:
            for part in path.split("/")[1:]:
                key = part.replace("~1", "/").replace("~0", "~")
                if isinstance(parent, list):
                    index = int(key)
                    prefixes = view.get("prefixItems", []) if isinstance(view, dict) else []
                    view = prefixes[index] if index < len(prefixes) else view.get("items", True) if isinstance(view, dict) else True
                    parent = parent[index]
                else:
                    view = view.get("properties", {}).get(key, True) if isinstance(view, dict) else True
                    parent = parent[key]
        except (KeyError, IndexError, TypeError, ValueError):
            decisions.append({"path": path, "source": source, "kept": False})
            continue
        if not isinstance(parent, dict):
            decisions.append({"path": path, "source": source, "kept": False})
            continue
        number = 1
        def reserved_names(node):
            if not isinstance(node, dict):
                return set()
            names = set(node.get("properties", {}))
            for branch in node.get("oneOf", node.get("anyOf", [])):
                names.update(reserved_names(branch))
            return names
        reserved = reserved_names(view) | parent.keys()
        while f"{source}_备份{number}" in reserved:
            number += 1
        key = f"{source}_备份{number}"
        before = failures()
        parent[key] = json_copy(candidate["value"])
        kept = not (failures() - before)
        if not kept:
            del parent[key]
        else:
            # Show the backup immediately beside its source in the generated view.
            ordered = []
            for name, item in parent.items():
                if name != key:
                    ordered.append((name, item))
                if name == source:
                    ordered.append((key, parent[key]))
            if source not in parent:
                ordered.append((key, parent[key]))
            parent.clear()
            parent.update(ordered)
        decisions.append({"path": path, "source": source, "key": key, "kept": kept})
    return value, decisions


def submit(request_id, value=None, cancel=False):
    with LOCK:
        entry = PENDING.get(request_id)
        if entry is None or entry["done"]:
            raise KeyError("该次填写已结束或失效，请等待当前请求；不会把旧表单提交到下一轮。")
        if cancel:
            entry.update(done=True, cancelled=True)
            return []
        schema = entry["schema"]
    value, errors = validate_value(schema, value)
    with LOCK:
        if PENDING.get(request_id) is not entry or entry["done"]:
            raise KeyError("该次填写已结束或失效；校验期间表单状态已变化。")
        if not errors:
            entry.update(done=True, result=value)
        return errors


async def inspect_form(request):
    try:
        data = await request.json()
        schema = parse_schema(data["schema"])
        def inspect():
            value = data.get("value")
            backups = None
            if "backup_candidates" in data:
                value, backups = insert_type_backups(schema, value, data["backup_candidates"])
            errors = validate_value(schema, value)[1] if "value" in data else []
            try:
                presentation = context_for(schema).presentation(schema, value)
            except Exception as error:
                raise ValueError(f"表单字段规则无法解析（{type(error).__name__}），请检查引用目标是否存在且可访问。") from None
            result = {"schema": schema, "presentation": presentation, "errors": errors}
            if backups is not None:
                result.update(value=value, backups=backups)
            return result
        result = await asyncio.to_thread(inspect)
        return web.json_response(result, dumps=lambda obj: json.dumps(obj, ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError, KeyError, RecursionError) as error:
        return web.json_response({"error": str(error)}, status=400)


async def pending_forms(request):
    workflow_id = request.query.get("workflow_id", "")
    with LOCK:
        values = [public_request(entry) for entry in PENDING.values()
                  if entry["workflow_id"] == workflow_id and not entry["done"]]
    return web.json_response({"requests": values}, headers={"Cache-Control": "no-store"})


async def submit_form(request):
    try:
        data = await request.json()
        errors = await asyncio.to_thread(submit, data["request_id"], data.get("value"), data.get("cancel") is True)
        return web.json_response({"errors": errors}, status=422 if errors else 200)
    except KeyError as error:
        return web.json_response({"error": str(error)}, status=409)
    except (ValueError, TypeError, RecursionError) as error:
        return web.json_response({"error": str(error)}, status=400)


if getattr(PromptServer, "instance", None):
    PromptServer.instance.routes.post("/liuxinyu/template_form/inspect")(inspect_form)
    PromptServer.instance.routes.get("/liuxinyu/template_form/pending")(pending_forms)
    PromptServer.instance.routes.post("/liuxinyu/template_form/submit")(submit_form)
    PromptServer.instance.routes.post("/liuxinyu/template_form/presence")(notice_presence)
    PromptServer.instance.routes.get("/liuxinyu/template_form/notification/{token}")(notification_target)
    PromptServer.instance.routes.post("/liuxinyu/template_form/activate/{token}")(activate_notice)
    PromptServer.instance.routes.post("/liuxinyu/template_form/activated")(activated_notice)


class LiuxinyuTemplateSchemaCache(io.ComfyNode):
    """Execution-only sink used by the form's input-chain refresh button."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuTemplateSchemaCache", is_dev_only=True, is_output_node=True,
            inputs=[io.String.Input("schema", force_input=True)], outputs=[],
        )

    @classmethod
    def execute(cls, schema):
        parsed = parse_schema(schema)
        if parsed is False:
            raise ValueError("Schema 为 false，不允许任何结果，不能作为可填写模板。")
        # History retains this result even if the page reloads or the sink is cached.
        return io.NodeOutput(ui={"lxy_template_schema": [parsed]})


class LiuxinyuTemplateForm(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuTemplateForm", display_name="JSON Schema填写模版", category="liuxinyu/结构化数据",
            description="输入 Draft 2020-12 JSON Schema，在节点内填写表单并确认。支持 x-error-message 自定义校验报错，未设置时自动生成中文解释；注解不进入填写结果。最左侧按钮可计算上游链以更新模板缓存，不执行下游；复位使用最近缓存的模板。已有草稿按新规则补齐必填键，同名且类型兼容的值保留；类型冲突时重建，旧值仅在规则允许时保存为编号备份键。补齐或重建后需要确认。已确认值在字段结构不变且当前校验通过时自动复用。后台由 Python 发送 Windows 通知。数组整体输出。",
            inputs=[
                io.String.Input("schema", force_input=True, display_name="JSON Schema",
                                tooltip="连接 Draft 2020-12 JSON Schema 字符串；按当前值展开条件、组合和引用，支持 HTTP(S) 外部引用。format 按默认方言作为注解；最终按原始 Schema 校验。"),
                io.String.Input("form_state", default="{}", socketless=True, advanced=True,
                                  tooltip="前端保存 Schema、填写值、确认状态、模板快照和最近一次复位备份的内部字段，随工作流保存；编辑或复位后需要重新确认。"),
            ],
            outputs=[JSON_VALUE.Output(display_name="填写结果")],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    async def execute(cls, schema, form_state="{}"):
        schema = parse_schema(schema)
        if schema is False:
            raise ValueError("Schema 为 false，不允许任何结果，无法填写。")
        try:
            stored = json.loads(form_state or "{}")
        except (ValueError, RecursionError) as error:
            raise ValueError(f"表单草稿 JSON 无效：{error}") from error
        has_value = isinstance(stored, dict) and "value" in stored
        value = json_copy(stored["value"]) if has_value else None
        server = PromptServer.instance
        client_id = server.client_id
        node_id = str(cls.hidden.unique_id)
        if cls.hidden.dynprompt:
            node_id = str(cls.hidden.dynprompt.get_display_node_id(node_id))
        workflow = (cls.hidden.extra_pnginfo or {}).get("workflow", {})
        context = get_executing_context()
        # Already-queued loop expansions carry an older widget snapshot. Reuse only
        # inside that exact prompt/node/snapshot; an edited draft in a later run wins.
        cache_key = (context.prompt_id, str(workflow.get("id", "")), node_id, form_state) if context else None
        with LOCK:
            candidate = CONFIRMED_IN_PROMPT.get(cache_key, stored) if cache_key else stored
        if await asyncio.to_thread(reusable, candidate, schema):
            result = json_copy(candidate["value"])
            reused_entry = {
                "request_id": uuid.uuid4().hex, "node_id": node_id, "workflow_id": str(workflow.get("id", "")),
                "schema": schema, "value": result,
            }
            register_notice(reused_entry, workflow, client_id, reused=True)
            server.send_sync("liuxinyu.template_form_reused", reused_entry, client_id)
            return io.NodeOutput(result)
        entry = {"request_id": uuid.uuid4().hex, "node_id": node_id, "workflow_id": str(workflow.get("id", "")),
                 "schema": schema, "value": value, "has_value": has_value, "done": False, "cancelled": False}
        with LOCK:
            PENDING[entry["request_id"]] = entry
        register_notice(public_request(entry), workflow, client_id)
        try:
            server.send_sync("liuxinyu.template_form", public_request(entry), client_id)
            while True:
                throw_exception_if_processing_interrupted()
                with LOCK:
                    if entry["done"]:
                        if entry["cancelled"]:
                            raise InterruptProcessingException("已取消JSON Schema填写模版。")
                        if cache_key:
                            CONFIRMED_IN_PROMPT[cache_key] = {"schema": schema, "value": deepcopy(entry["result"]), "confirmed": True}
                            CONFIRMED_IN_PROMPT.move_to_end(cache_key)
                            while len(CONFIRMED_IN_PROMPT) > 128:
                                CONFIRMED_IN_PROMPT.popitem(last=False)
                        return io.NodeOutput(deepcopy(entry["result"]))
                await asyncio.sleep(0.15)
        finally:
            with LOCK:
                PENDING.pop(entry["request_id"], None)
            await close_notice(entry["request_id"])
            completion = {"request_id": entry["request_id"], "node_id": node_id, "workflow_id": entry["workflow_id"]}
            if "result" in entry:
                completion.update(schema=schema, value=entry["result"], confirmed=True)
            server.send_sync("liuxinyu.template_form_done", completion, client_id)
