"""Draft 2020-12 forms with human confirmation and validated reuse."""

import asyncio
import base64
from io import BytesIO
from collections import OrderedDict
from copy import deepcopy
from fractions import Fraction
from functools import lru_cache
import json
import hashlib
import os
import tempfile
import logging
import math
import mimetypes
from pathlib import Path
import re
import shutil
import subprocess
import threading
import uuid
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from aiohttp import web
from PIL import Image
import folder_paths
from jsonschema import Draft202012Validator, validators
from jsonschema.exceptions import SchemaError, ValidationError
from referencing import Registry
from referencing.jsonschema import DRAFT202012
from server import PromptServer
from comfy_api.latest import io
from comfy_execution.utils import get_executing_context
from comfy.model_management import InterruptProcessingException, throw_exception_if_processing_interrupted
from template_form_notifications import dispatch as dispatch_notification
from template_color_books import installed_books, read_book
from schema_chinese import explain_error as validation_message

DIALECT = "https://json-schema.org/draft/2020-12/schema"
JSON_VALUE = io.Custom("DICT,ARRAY,STRING,INT,FLOAT,BOOLEAN,NULL")
PENDING = {}
LOCK = threading.Lock()
CONFIRMED_IN_PROMPT = OrderedDict()
NOTICES = OrderedDict()
PAGES = OrderedDict()
SELECTED_FORM_FILES = set()
SYNC_FILES = {}
SYNC_LOCK = threading.Lock()


def read_values_source(schema, values_json=None, sync_file=None):
    if values_json is not None and sync_file is not None:
        raise ValueError("填写值 JSON 和更新同步的文件路径只能连接一个。")
    if sync_file is None:
        return parse_form_values(values_json, schema)
    path = Path(sync_file).expanduser().resolve(strict=True)
    raw = path.read_bytes()
    result = parse_form_values(raw.decode('utf-8-sig'), schema)
    token = uuid.uuid4().hex
    with SYNC_LOCK:
        SYNC_FILES[token] = (path, hashlib.sha256(raw).hexdigest(), schema, json.loads(raw.decode('utf-8-sig')))
    return {**result, "sync_token": token, "sync_file": str(path)}


def write_synced_values(data):
    with SYNC_LOCK:
        record = SYNC_FILES.get(data.get('sync_token'))
        if not record:
            raise ValueError('同步来源已失效，请重新计算输入链。')
        path, digest, schema, original = record
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('文件已被外部修改，请重新计算输入链后再编辑，避免覆盖。')
        value = json_copy(data['value'])
        metadata = {key: data.get(key, {}) for key in ('input_types', 'field_required', 'field_enums')}
        # Draft edits may temporarily violate constraints; execution validates.
        validate_value(schema, value, **metadata)
        payload = {**original, 'value': value, **metadata} if isinstance(original, dict) and original.get('$format') == 'liuxinyu.template-values/v1' else value
        raw = (json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)+'\n').encode('utf-8')
        temp = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
                temp = file.name
                file.write(raw)
            os.replace(temp, path)
        finally:
            if temp and os.path.exists(temp): os.unlink(temp)
        SYNC_FILES[data['sync_token']] = (path, hashlib.sha256(raw).hexdigest(), schema, payload)
    return {'saved': True}


async def sync_form_values(request):
    if request.content_type != 'application/json':
        return web.json_response({'error': '请求必须使用 application/json'}, status=400)
    try:
        return web.json_response(await asyncio.to_thread(write_synced_values, await request.json()))
    except (ValueError, KeyError, TypeError, OSError) as error:
        return web.json_response({'error': str(error)}, status=400)


def encode_form_file(path, mode=None):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("请选择一个文件")
    size = path.stat().st_size
    encoding = "base64" if mode == "base64" or mode != "link" and size < 512 * 1024 else "link"
    value = base64.b64encode(path.read_bytes()).decode("ascii") if encoding == "base64" else str(path)
    SELECTED_FORM_FILES.add(path)
    return {"value": value, "encoding": encoding, "name": path.name,
            "display": str(path), "path": str(path), "size": size, "type": "application/octet-stream"}


def system_form_file(action):
    prefix = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); "
    if action in ("choose", "save-values"):
        script = """Add-Type -AssemblyName System.Windows.Forms;
$owner = New-Object System.Windows.Forms.Form;
$owner.ShowInTaskbar = $false; $owner.TopMost = $true;
$owner.StartPosition = 'CenterScreen'; $owner.Width = 1; $owner.Height = 1; $owner.Opacity = 0;
$dialog = New-Object System.Windows.Forms.OpenFileDialog;
$dialog.Multiselect = $false; $dialog.Title = '选择附件文件';
try {
    $owner.Show(); $owner.Activate(); [System.Windows.Forms.Application]::DoEvents();
    if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.FileName | ConvertTo-Json -Compress }
} finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }
"""
        if action == "save-values":
            script = script.replace("OpenFileDialog", "SaveFileDialog").replace(
                "$dialog.Multiselect = $false; $dialog.Title = '选择附件文件';",
                "$dialog.Title = '保存当前配置值(只用于当前模版)'; $dialog.Filter = 'JSON 文件 (*.json)|*.json'; "
                "$dialog.DefaultExt = 'json'; $dialog.AddExtension = $true; $dialog.OverwritePrompt = $true; "
                "$dialog.FileName = '填写配置.json';")
    else:
        script = "$files = @(Get-Clipboard -Format FileDropList); if ($files.Count) { $files[0].FullName | ConvertTo-Json -Compress }"
    try:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-STA", "-Command", prefix + script],
                                capture_output=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW,
                                timeout=None if action in ("choose", "save-values") else 15)
    except subprocess.TimeoutExpired as error:
        raise ValueError("读取系统剪贴板超过 15 秒，请重新复制文件后粘贴") from error
    if result.returncode:
        raise ValueError("系统文件选择或剪贴板读取失败：" + result.stderr.strip()[:500])
    return json.loads(result.stdout.strip()) if result.stdout.strip() else None


async def select_form_file(request):
    try:
        data = await request.json()
        action, mode = data.get("action"), data.get("mode")
        if action not in ("choose", "clipboard", "convert") or mode not in (None, "link", "base64"):
            raise ValueError("无效文件操作或保存方式")
        if action == "convert":
            path = Path(data.get("path", "")).resolve()
            if path not in SELECTED_FORM_FILES:
                raise ValueError("后端重启后请重新选择该本机文件，再转换保存方式")
        else:
            path = await asyncio.to_thread(system_form_file, action)
        result = await asyncio.to_thread(encode_form_file, path, mode) if path else None
        return web.json_response({"file": result})
    except (ValueError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)


def checked_form_image(path):
    path = Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError("请选择图片文件")
    mime = mimetypes.guess_type(path.name)[0]
    if mime not in ("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/tiff", "image/avif"):
        raise ValueError("请选择 PNG、JPEG、GIF、WebP、BMP、TIFF 或 AVIF 图片")
    try:
        with Image.open(path) as image:
            image.verify()
    except (OSError, ValueError) as error:
        raise ValueError("文件不是可解码的图片") from error
    return path, mime


def encode_form_image(path, mode):
    path, mime = checked_form_image(path)
    if mode == "base64" or mode == "auto" and path.stat().st_size < 512 * 1024:
        return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"
    if mode == "copy":
        root = Path(folder_paths.get_input_directory()) / "template_form"
        root.mkdir(parents=True, exist_ok=True)
        destination = root / f"{path.stem}-{uuid.uuid4().hex[:12]}{path.suffix}"
        shutil.copy2(path, destination)
        return f"template_form/{destination.name}"
    return str(path)


async def select_form_image(request):
    try:
        data = await request.json()
        action, mode = data.get("action"), data.get("mode")
        if action not in ("choose", "convert") or mode not in ("auto", "link", "copy", "base64"):
            raise ValueError("无效图片操作或保存方式")
        path = await asyncio.to_thread(system_form_file, "choose") if action == "choose" else data.get("path")
        if not path:
            return web.json_response({"value": None})
        if action == "convert" and not Path(path).is_absolute():
            root = Path(folder_paths.get_input_directory()).resolve()
            path = (root / path).resolve()
            if not path.is_relative_to(root):
                raise ValueError("图片路径超出 ComfyUI/input")
        value = await asyncio.to_thread(encode_form_image, path, mode)
        return web.json_response({"value": value})
    except (ValueError, OSError, TypeError) as error:
        return web.json_response({"error": str(error)}, status=400)


async def preview_form_image(request):
    try:
        path = request.query.get("path", "")
        if not Path(path).is_absolute():
            raise ValueError("需要本机绝对路径")
        path, mime = await asyncio.to_thread(checked_form_image, path)
    except (ValueError, OSError):
        raise web.HTTPNotFound() from None
    return web.FileResponse(path, headers={"Content-Type": mime, "X-Content-Type-Options": "nosniff",
                                           "Content-Security-Policy": "default-src 'none'; sandbox"})


def form_image_thumbnail(value):
    root = Path(folder_paths.get_input_directory()).resolve()
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = (root / candidate).resolve()
        if not candidate.is_relative_to(root):
            raise ValueError("图片路径超出 ComfyUI/input")
    path, _ = checked_form_image(candidate)
    with Image.open(path) as image:
        image.thumbnail((320, 320), Image.Resampling.LANCZOS)
        buffer = BytesIO()
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        image.save(buffer, format="WEBP", quality=78)
    return buffer.getvalue()


async def preview_form_image_thumbnail(request):
    try:
        value = request.query.get("path", "")
        body = await asyncio.to_thread(form_image_thumbnail, value)
    except (ValueError, OSError):
        raise web.HTTPNotFound() from None
    return web.Response(body=body, content_type="image/webp",
                        headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"})
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
            and not validate_value(schema, stored["value"], stored.get("input_types"), stored.get("field_required"), stored.get("field_enums"))[1])


def decimal_multiple(validator, divisor, instance, schema):
    if validator.is_type(instance, "number"):
        # JSON decimal multiples must not fail because 0.3 / 0.1 is a binary float.
        if Fraction(str(instance)) % Fraction(str(divisor)) != 0:
            yield ValidationError(f"{instance} is not a multiple of {divisor}")


def input_mode_validation(validator, mode, instance, schema):
    from datetime import date, time, datetime
    import re
    if not isinstance(instance, str):
        yield ValidationError("此输入格式要求字符串值")
        return
    # Empty drafts remain editable; minLength controls mandatory content.
    if not instance:
        return
    try:
        if mode == "date":
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", instance):
                raise ValueError()
            date.fromisoformat(instance)
        elif mode == "time":
            if not re.fullmatch(r"\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?", instance):
                raise ValueError()
            time.fromisoformat(instance)
        elif mode == "date-time":
            if "T" not in instance or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", instance):
                raise ValueError()
            datetime.fromisoformat(instance)
        elif mode == "color" and not re.fullmatch(r"#[0-9a-fA-F]{6}", instance):
            raise ValueError()
    except ValueError:
        names = {"date": "有效日期（YYYY-MM-DD）", "time": "有效时间（HH:mm 或 HH:mm:ss）",
                 "date-time": "有效日期时间（YYYY-MM-DDTHH:mm:ss，可带时区）", "color": "HEX 颜色（#RRGGBB）"}
        yield ValidationError("请填写" + names[mode])


def ordered_properties(validator, pairs, instance, schema):
    if not isinstance(instance, dict):
        return
    for lower, upper in pairs:
        a, b = instance.get(lower), instance.get(upper)
        if type(a) in (int, float) and type(b) in (int, float) and a > b:
            yield ValidationError(f"{lower}（{a}）不得大于{upper}（{b}）", path=[upper])


FormValidator = validators.extend(Draft202012Validator, {
    "x-orderedProperties": ordered_properties,
    "multipleOf": decimal_multiple, "x-input-mode": input_mode_validation,
})


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
    def validate_dynamic_properties(schema):
        if not isinstance(schema, dict):
            return
        pairs = schema.get("x-orderedProperties", [])
        if not isinstance(pairs, list) or any(not isinstance(pair, list) or len(pair) != 2
                or any(not isinstance(key, str) for key in pair) for pair in pairs):
            raise ValueError("x-orderedProperties 需要由两个字段名组成的数组列表")
        rule = schema.get("x-requiredPropertiesFrom")
        if rule is not None:
            if (not isinstance(rule, dict) or not isinstance(rule.get("pointer"), str)
                    or not rule["pointer"].startswith("/")
                    or not ("propertySchema" in rule or isinstance(rule.get("propertySchemaByType"), dict))):
                raise ValueError("x-requiredPropertiesFrom 需要以 / 开头的 pointer，以及 propertySchema 或 propertySchemaByType")
            if re.search(r"~(?![01])", rule["pointer"]):
                raise ValueError("x-requiredPropertiesFrom.pointer 含无效的 JSON Pointer 转义")
            schemas = [rule["propertySchema"]] if "propertySchema" in rule else list(rule["propertySchemaByType"].values())
            for property_schema in schemas:
                try:
                    Draft202012Validator.check_schema(property_schema)
                except SchemaError as error:
                    raise ValueError(f"x-requiredPropertiesFrom 属性规则定义错误：{error.message}") from error
        for key in ("$defs", "properties", "patternProperties", "dependentSchemas"):
            for child in schema.get(key, {}).values():
                validate_dynamic_properties(child)
        for key in ("allOf", "anyOf", "oneOf", "prefixItems"):
            for child in schema.get(key, []):
                validate_dynamic_properties(child)
        for key in ("items", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
                    "propertyNames", "if", "then", "else", "not", "contentSchema"):
            if key in schema:
                validate_dynamic_properties(schema[key])
    validate_dynamic_properties(value)
    return value


def materialize_required_properties(schema, value, input_types=None, field_required=None, field_enums=None):
    """Expand the form-only dynamic-key rule into ordinary Draft 2020-12 constraints."""
    if input_types is not None and not isinstance(input_types, dict):
        raise ValueError("字段输入类型记录必须为对象")
    input_types = {path.removeprefix("$"): mode for path, mode in (input_types or {}).items()
                   if isinstance(path, str) and isinstance(mode, str)}
    field_required = {k.removeprefix("$"): v for k, v in (field_required or {}).items() if isinstance(k, str) and type(v) is bool}
    if field_enums is not None and not isinstance(field_enums, dict):
        raise ValueError("枚举选项记录必须为对象")
    field_enums = {k.removeprefix("$"): v for k, v in (field_enums or {}).items() if isinstance(k, str)}
    for options in field_enums.values():
        if not isinstance(options, list) or any(not isinstance(option, str) for option in options) or len(set(options)) != len(options):
            raise ValueError("枚举选项必须为不重复的字符串数组")
    modes = {"image": {"x-image": {}}, "file": {"x-file": {}},
             "date": {"format": "date"}, "time": {"format": "time"},
             "date-time": {"format": "date-time"},
             "color": {"pattern": "^#[0-9A-Fa-f]{6}$"}}

    def selected_schema(current, path=""):
        mode = input_types.get(path)
        result = deepcopy(modes.get(mode, {}))
        if mode in modes:
            result["x-input-mode"] = mode
        if mode == "enum":
            options = field_enums.get(path, [])
            result.update({"type": "string", **({"enum": options} if options else {"not": {}})})
        if isinstance(current, dict):
            props = {key: selected_schema(item, path + "/" + key.replace("~", "~0").replace("/", "~1"))
                     for key, item in current.items()}
            props = {key: rule for key, rule in props.items() if rule}
            if props:
                result["properties"] = props
                result["x-input-mode-properties"] = True
        elif isinstance(current, list):
            items = [selected_schema(item, path + "/" + str(i)) for i, item in enumerate(current)]
            if any(items):
                result["prefixItems"] = items
        return result

    def pointer_value(pointer):
        current = value
        for token in pointer[1:].split("/"):
            token = token.replace("~1", "/").replace("~0", "~")
            if isinstance(current, dict) and token in current:
                current = current[token]
            elif isinstance(current, list) and token.isdigit() and (token == "0" or not token.startswith("0")):
                index = int(token)
                if index >= len(current):
                    return None
                current = current[index]
            else:
                return None
        return current

    def visit(node, depth=0):
        if depth > 64 or not isinstance(node, dict):
            return deepcopy(node)
        result = deepcopy(node)
        rule = result.get("x-requiredPropertiesFrom")
        if isinstance(rule, dict):
            source = pointer_value(rule["pointer"])
            if isinstance(source, dict):
                properties = result.setdefault("properties", {})
                required = result.setdefault("required", [])
                for key, source_value in source.items():
                    property_schema = rule.get("propertySchema")
                    by_type = rule.get("propertySchemaByType")
                    if isinstance(by_type, dict):
                        if source_value is None:
                            value_type = "null"
                        elif type(source_value) is bool:
                            value_type = "boolean"
                        elif type(source_value) is int:
                            value_type = "integer"
                        elif type(source_value) is float:
                            value_type = "number"
                        elif isinstance(source_value, str):
                            value_type = "string"
                        elif isinstance(source_value, list):
                            value_type = "array"
                        else:
                            value_type = "object"
                        source_path = rule["pointer"] + "/" + key.replace("~", "~0").replace("/", "~1")
                        if input_types.get(source_path) == "number" and value_type == "integer":
                            value_type = "number"
                        property_schema = by_type.get(value_type, property_schema)
                    property_schema = deepcopy(property_schema if property_schema is not None else True)
                    source_path = rule["pointer"] + "/" + key.replace("~", "~0").replace("/", "~1")
                    mode_schema = {} if isinstance(source_value, dict) else selected_schema(source_value, source_path)
                    if input_types.get(source_path) in modes:
                        mode_schema["type"] = "string"
                    elif input_types.get(source_path) == "number" and type(source_value) in (int, float):
                        mode_schema["type"] = "number"
                    if mode_schema:
                        if property_schema is True:
                            property_schema = {}
                        if isinstance(property_schema, dict):
                            for field, constraint in mode_schema.items():
                                if field in property_schema and property_schema[field] != constraint:
                                    property_schema.setdefault("allOf", []).append({field: constraint})
                                else:
                                    property_schema[field] = constraint
                    if property_schema is True:
                        property_schema = {"default": deepcopy(source_value)}
                    elif isinstance(property_schema, dict):
                        property_schema["default"] = deepcopy(source_value)
                    if isinstance(source_value, dict) and isinstance(property_schema, dict):
                        property_schema.setdefault("type", "object")
                        property_schema["additionalProperties"] = False
                        property_schema.setdefault("x-requiredPropertiesFrom", {**deepcopy(rule), "pointer": source_path})
                    properties.setdefault(key, property_schema)
                    if field_required.get(source_path, True):
                        if key not in required:
                            required.append(key)
                    elif key not in node.get("required", []):
                        required[:] = [name for name in required if name != key]
                        if isinstance(properties[key], dict):
                            properties[key].pop("default", None)
        for key in ("$defs", "properties", "patternProperties", "dependentSchemas"):
            if isinstance(result.get(key), dict):
                result[key] = {name: visit(child, depth + 1) for name, child in result[key].items()}
        for key in ("allOf", "anyOf", "oneOf", "prefixItems"):
            if isinstance(result.get(key), list):
                result[key] = [visit(child, depth + 1) for child in result[key]]
        for key in ("items", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
                    "propertyNames", "if", "then", "else", "not", "contentSchema"):
            if key in result:
                result[key] = visit(result[key], depth + 1)
        return result

    result = visit(schema)
    selected = selected_schema(value)
    if selected and result is not False:
        if result is True:
            result = {}
        result.setdefault("allOf", []).append(selected)
    return result


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
            for key in ("title", "description", "default", "format", "pattern", "const", "enum", "multipleOf", "x-image", "x-file", "x-requiredPropertiesFrom", "contentMediaType", "contentEncoding"):
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
        if isinstance(value, dict):
            fixed = set().union(*(set(s.get("properties", {})) for s, _ in entries if not s.get("x-input-mode-properties")))
            result["x-editableKeys"] = [name for name in value if name not in fixed]
        result["x-keyPatterns"] = [list(s.get("patternProperties", {})) for s, _ in entries
                                   if s.get("additionalProperties") is False]
        name_rules = [s["propertyNames"] for s, _ in entries if "propertyNames" in s]
        if name_rules:
            result["propertyNames"] = name_rules[0] if len(name_rules) == 1 else {"allOf": name_rules}
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


def validate_value(schema, value, input_types=None, field_required=None, field_enums=None):
    schema = materialize_required_properties(schema, value, input_types, field_required, field_enums)
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
            if error.validator in ("x-input-mode", "x-orderedProperties") and "x-error-message" not in error.schema:
                message = display_message = error.message
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
    return {key: entry[key] for key in ("request_id", "node_id", "workflow_id", "schema", "value", "has_value", "imported", "input_types", "field_required", "field_enums") if key in entry}


def parse_form_values(raw, schema):
    data = json.loads(raw) if isinstance(raw, str) else json_copy(raw)
    metadata = {}
    if isinstance(data, dict) and data.get("$format") == "liuxinyu.template-values/v1":
        if data.get("schema") != schema:
            raise ValueError("配置文件对应的模板与当前 JSON Schema输入键不同，请使用保存时的模板。")
        if "value" not in data:
            raise ValueError("配置文件缺少 value。")
        metadata = {key: data.get(key, {}) for key in ("input_types", "field_required", "field_enums")}
        data = data["value"]
    # Resolve and validate now; the UI preserves compatible values and exposes
    # failed fields for correction rather than silently discarding user material.
    validate_value(schema, data, **metadata)
    return {"value": json_copy(data), **metadata}


async def save_form_values(request):
    if request.content_type != "application/json":
        return web.json_response({"error": "请求必须使用 application/json"}, status=400)
    try:
        data = await request.json()
        schema = parse_schema(data["schema"])
        value = json_copy(data["value"])
        payload = {"$format": "liuxinyu.template-values/v1", "schema": schema, "value": value,
                   **{key: data.get(key, {}) for key in ("input_types", "field_required", "field_enums")}}
        parse_form_values(payload, schema)
        text = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        path = await asyncio.to_thread(system_form_file, "save-values")
        if not path:
            return web.json_response({"cancelled": True})
        await asyncio.to_thread(Path(path).write_text, text, encoding="utf-8")
        return web.json_response({"saved": True, "path": path})
    except (ValueError, TypeError, KeyError, OSError) as error:
        return web.json_response({"error": str(error)}, status=400)


def insert_type_backups(schema, value, candidates, input_types=None, field_required=None, field_enums=None):
    """Keep conflict values only when their new sibling key introduces no rule violation."""
    value = json_copy(value)
    if not isinstance(candidates, list) or len(candidates) > 1000:
        raise ValueError("类型冲突备份一次最多处理 1000 项")
    schema = materialize_required_properties(schema, value, input_types, field_required, field_enums)
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


def submit(request_id, value=None, cancel=False, input_types=None, field_required=None, field_enums=None):
    with LOCK:
        entry = PENDING.get(request_id)
        if entry is None or entry["done"]:
            raise KeyError("该次填写已结束或失效，请等待当前请求；不会把旧表单提交到下一轮。")
        if cancel:
            entry.update(done=True, cancelled=True)
            return []
        schema = entry["schema"]
    value, errors = validate_value(schema, value, input_types, field_required, field_enums)
    with LOCK:
        if PENDING.get(request_id) is not entry or entry["done"]:
            raise KeyError("该次填写已结束或失效；校验期间表单状态已变化。")
        if not errors:
            entry.update(done=True, result=value, input_types=deepcopy(input_types or {}), field_required=deepcopy(field_required or {}), field_enums=deepcopy(field_enums or {}))
        return errors


async def inspect_form(request):
    try:
        data = await request.json()
        schema = parse_schema(data["schema"])
        def inspect():
            value = data.get("value")
            input_types = data.get("input_types") if isinstance(data.get("input_types"), dict) else {}
            field_required = data.get("field_required") if isinstance(data.get("field_required"), dict) else {}
            field_enums = data.get("field_enums") if isinstance(data.get("field_enums"), dict) else {}
            backups = None
            if "backup_candidates" in data:
                value, backups = insert_type_backups(schema, value, data["backup_candidates"], input_types, field_required, field_enums)
            errors = validate_value(schema, value, input_types, field_required, field_enums)[1] if "value" in data else []
            try:
                effective_schema = materialize_required_properties(schema, value, input_types, field_required, field_enums)
                presentation = context_for(effective_schema).presentation(effective_schema, value)
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
        errors = await asyncio.to_thread(submit, data["request_id"], data.get("value"), data.get("cancel") is True,
                                         data.get("input_types") if isinstance(data.get("input_types"), dict) else {},
                                         data.get("field_required") if isinstance(data.get("field_required"), dict) else {},
                                         data.get("field_enums") if isinstance(data.get("field_enums"), dict) else {})
        return web.json_response({"errors": errors}, status=422 if errors else 200)
    except KeyError as error:
        return web.json_response({"error": str(error)}, status=409)
    except (ValueError, TypeError, RecursionError) as error:
        return web.json_response({"error": str(error)}, status=400)


def form_file_path(value):
    root = Path(folder_paths.get_input_directory()).resolve()
    path = (root / value).resolve()
    if (not path.is_relative_to(root) and path not in SELECTED_FORM_FILES) or not path.is_file():
        raise ValueError("文件须位于 ComfyUI/input 内且存在")
    return path


async def download_form_file(request):
    try:
        path = form_file_path(request.query.get("path", ""))
    except (ValueError, OSError):
        raise web.HTTPNotFound() from None
    return web.FileResponse(path, headers={"Content-Type": "application/octet-stream",
                                          "Content-Disposition": "attachment",
                                          "X-Content-Type-Options": "nosniff"})


async def color_books(request):
    books = installed_books()
    key = request.query.get('book')
    if key is None:
        return web.json_response({'books': [{'id': p.name, 'name': p.stem} for p in books]})
    path = next((p for p in books if p.name == key), None)
    if path is None:
        return web.json_response({'error': '色标簿不存在'}, status=404)
    try:
        return web.json_response(await asyncio.to_thread(read_book, path))
    except (OSError, ValueError) as error:
        return web.json_response({'error': str(error)}, status=400)


if getattr(PromptServer, "instance", None):
    PromptServer.instance.routes.post("/liuxinyu/template_form/sync-values")(sync_form_values)
    PromptServer.instance.routes.post("/liuxinyu/template_form/save-values")(save_form_values)
    PromptServer.instance.routes.get("/liuxinyu/template_form/color_books")(color_books)
    PromptServer.instance.routes.post("/liuxinyu/template_form/file")(select_form_file)
    PromptServer.instance.routes.get("/liuxinyu/template_form/file")(download_form_file)
    PromptServer.instance.routes.post("/liuxinyu/template_form/image")(select_form_image)
    PromptServer.instance.routes.get("/liuxinyu/template_form/image")(preview_form_image)
    PromptServer.instance.routes.get("/liuxinyu/template_form/image/thumbnail")(preview_form_image_thumbnail)
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
            inputs=[io.String.Input("schema", force_input=True), io.String.Input("values_json", force_input=True, optional=True), io.String.Input("sync_file", force_input=True, optional=True)], outputs=[],
        )

    @classmethod
    def execute(cls, schema, values_json=None, sync_file=None):
        parsed = parse_schema(schema)
        if parsed is False:
            raise ValueError("Schema 为 false，不允许任何结果，不能作为可填写模板。")
        # History retains this result even if the page reloads or the sink is cached.
        result = {"lxy_template_schema": [parsed]}
        if values_json is not None or sync_file is not None:
            result["lxy_template_values"] = [read_values_source(parsed, values_json, sync_file)]
        return io.NodeOutput(ui=result)


class LiuxinyuTemplateForm(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuTemplateForm", display_name="JSON Schema填写模版", category="liuxinyu/结构化数据",
            description="JSON Schema输入键定义模板，可选填入值JSON Schema输入值导入 JSON 填写内容；底部左侧保存按钮通过 Windows 系统保存框另存当前模板配置，有输入时直接校验输出；文件路径模式可勾选同步输入修改自动写回。输入 Draft 2020-12 JSON Schema，在节点内填写表单并确认。自由字段可选择图片、文件、日期、时间、日期时间和 HEX 颜色；输入格式随工作流保存并随动态字段投影，确认与复用都校验。支持 x-file 任意文件：系统选择真实路径，小于 512 KB 自动保存纯 Base64，否则保存路径，下拉可覆盖。支持 x-image 图片区域点击选图、替换与粘贴，默认选文件时小于 512 KB 保存 Base64 Data URL，否则保存原始本机路径；无路径粘贴保存 Base64 Data URL。图片下拉框可选链接／路径（原始路径）、复制并保存路径（上传副本）或 Base64。空图片为单行。支持 x-error-message 自定义校验报错，未设置时自动生成中文解释；注解不进入填写结果。计算链按钮可计算模板和填写值上游链以更新缓存，不执行下游；复位使用最近缓存的模板。已有草稿按新规则补齐必填键，同名且类型兼容的值保留；类型冲突时重建，旧值仅在规则允许时保存为编号备份键。补齐或重建后需要确认。已确认值在字段结构不变且当前校验通过时自动复用。后台由 Python 发送 Windows 通知。数组整体输出。",
            inputs=[
                io.String.Input("schema", force_input=True, display_name="JSON Schema输入键",
                                tooltip="连接 Draft 2020-12 JSON Schema 字符串；按当前值展开条件、组合和引用，支持 HTTP(S) 外部引用。format 按默认方言作为注解；最终按原始 Schema 校验。"),
                io.String.Input("form_state", default="{}", socketless=True, advanced=True,
                                  tooltip="前端保存 Schema、填写值、输入格式、确认状态、模板快照和最近一次复位备份的内部字段，随工作流保存；编辑或复位后需要重新确认。"),
                io.String.Input("values_json", force_input=True, optional=True, display_name="填入值JSON Schema输入值",
                                tooltip="可选 JSON 文本：原始填写值或保存按钮生成的配置 JSON。配置文件须匹配当前模板；有输入时只读显示，执行校验通过直接输出，失败直接报错。"),
                io.String.Input("sync_file", force_input=True, optional=True, display_name="更新同步的文件路径", tooltip="JSON 文件路径，与填写值 JSON 互斥。默认只读；勾选同步输入修改后编辑自动写回文件。执行时校验，通过直接输出，失败报错。"),
            ],
            outputs=[JSON_VALUE.Output(display_name="填写结果")],
            hidden=[io.Hidden.unique_id, io.Hidden.dynprompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    async def execute(cls, schema, form_state="{}", values_json=None, sync_file=None):
        schema = parse_schema(schema)
        if schema is False:
            raise ValueError("Schema 为 false，不允许任何结果，无法填写。")
        try:
            stored = json.loads(form_state or "{}")
        except (ValueError, RecursionError) as error:
            raise ValueError(f"表单草稿 JSON 无效：{error}") from error
        imported = values_json is not None or sync_file is not None
        if imported:
            stored = {"schema": schema, **await asyncio.to_thread(read_values_source, schema, values_json, sync_file), "confirmed": False}
        has_value = isinstance(stored, dict) and "value" in stored
        value = json_copy(stored["value"]) if has_value else None
        server = PromptServer.instance
        client_id = server.client_id
        node_id = str(cls.hidden.unique_id)
        if cls.hidden.dynprompt:
            node_id = str(cls.hidden.dynprompt.get_display_node_id(node_id))
        workflow = (cls.hidden.extra_pnginfo or {}).get("workflow", {})
        if imported:
            result, errors = await asyncio.to_thread(validate_value, schema, value, stored.get('input_types'), stored.get('field_required'), stored.get('field_enums'))
            server.send_sync('liuxinyu.template_form_source', {**stored, 'node_id': node_id, 'workflow_id': str(workflow.get('id', '')), 'imported': True}, client_id)
            if errors:
                raise ValueError('输入填写值校验失败：' + '; '.join(error['location']+'：'+error['message'] for error in errors))
            return io.NodeOutput(result)
        context = get_executing_context()
        # Already-queued loop expansions carry an older widget snapshot. Reuse only
        # inside that exact prompt/node/snapshot; an edited draft in a later run wins.
        cache_key = (context.prompt_id, str(workflow.get("id", "")), node_id, form_state, values_json) if context else None
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
        if imported:
            entry.update(imported=True, **{key: stored.get(key, {}) for key in ("input_types", "field_required", "field_enums")})
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
                            CONFIRMED_IN_PROMPT[cache_key] = {"schema": schema, "value": deepcopy(entry["result"]),
                                                            "input_types": deepcopy(entry.get("input_types", {})), "field_required": deepcopy(entry.get("field_required", {})), "field_enums": deepcopy(entry.get("field_enums", {})), "confirmed": True}
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
                completion.update(schema=schema, value=entry["result"], input_types=entry.get("input_types", {}), field_required=entry.get("field_required", {}), field_enums=entry.get("field_enums", {}), confirmed=True)
            server.send_sync("liuxinyu.template_form_done", completion, client_id)
