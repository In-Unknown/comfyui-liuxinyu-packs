"""Bounded local focus evidence. No workflow values or execution dependencies."""
import asyncio
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import threading

from aiohttp import web
import folder_paths
from server import PromptServer

_lock = threading.Lock()
_logger = None
_native = None
_recorder = None
_last_page = None


def log_path():
    return Path(folder_paths.get_user_directory()) / "liuxinyu" / "diagnostics" / "focus.jsonl"


def write_event(source, event):
    global _logger
    with _lock:
        if _logger is None:
            path = log_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(path, maxBytes=2*1024*1024, backupCount=3, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(message)s"))
            _logger = logging.Logger("liuxinyu.focus", logging.INFO)
            _logger.addHandler(handler)
        _logger.info(json.dumps({"receivedAt": datetime.now(timezone.utc).isoformat(),
                                 "source": source, **event}, ensure_ascii=False))
    if _recorder is not None and source != "recorder":
        _recorder.observe(source, event)


def clean_record(record):
    if not isinstance(record, dict) or not isinstance(record.get("kind"), str):
        raise ValueError("Invalid focus event")
    result = {}
    for key in ("kind", "time", "stack", "method"):
        if isinstance(record.get(key), str):
            result[key] = record[key][:3000 if key == "stack" else 100]
    for key in ("sequence", "interactionAgeMs"):
        value = record.get(key)
        if type(value) in (int, float) and 0 <= value < 1e15:
            result[key] = value
    for key in ("hidden", "hasFocus", "trusted", "suspicious"):
        if isinstance(record.get(key), bool):
            result[key] = record[key]
    for key in ("activeElement", "target", "relatedTarget"):
        value = record.get(key)
        if isinstance(value, dict):
            result[key] = {k: value[k][:200] for k in ("tag", "id", "classes") if isinstance(value.get(k), str)}
    value = record.get("viewport")
    if isinstance(value, list) and len(value) == 2 and all(type(v) is int and 0 <= v <= 100000 for v in value):
        result["viewport"] = value
    value = record.get("userActivation")
    if isinstance(value, dict):
        result["userActivation"] = {k: value[k] for k in ("active", "hasBeenActive") if isinstance(value.get(k), bool)}
    return result


def persist(batch):
    global _native, _recorder, _last_page
    for record in batch["records"]:
        write_event("page", {"session": batch["session"], **record})
    _last_page = {"session": batch["session"], "receivedAt": datetime.now(timezone.utc).isoformat()}
    if batch["dropped"]:
        write_event("transport", {"session": batch["session"], "dropped": batch["dropped"]})
    # Start once, only after a page actually enables monitoring.
    with _lock:
        if _native is None:
            import importlib.util
            spec = importlib.util.spec_from_file_location("liuxinyu_focus_recorder", Path(__file__).with_name("focus_recorder.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _recorder = module.FocusRecorder(log_path().parent, write_event)
            _recorder.start()
            spec = importlib.util.spec_from_file_location("liuxinyu_focus_native", Path(__file__).with_name("focus_native.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _native = module.NativeFocusMonitor(write_event)
            _native.start()


@PromptServer.instance.routes.post("/liuxinyu/focus/events")
async def focus_events(request):
    raw = await request.read()
    if len(raw) > 196608:
        raise web.HTTPRequestEntityTooLarge(max_size=196608, actual_size=len(raw))
    try:
        data = json.loads(raw)
        session = data["session"]
        if not isinstance(session, str) or len(session) > 80:
            raise ValueError("Invalid session")
        records = data["records"]
        if not isinstance(records, list) or not 1 <= len(records) <= 40:
            raise ValueError("Expected 1 to 40 events")
        dropped = data.get("dropped", 0)
        if type(dropped) is not int or not 0 <= dropped <= 1000000000:
            raise ValueError("Invalid dropped count")
        batch = {"session": session, "dropped": dropped, "records": [clean_record(r) for r in records]}
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest(text="Invalid focus log batch")
    await asyncio.to_thread(persist, batch)
    return web.json_response({"accepted": len(batch["records"])})


@PromptServer.instance.routes.get("/liuxinyu/focus/status")
async def focus_status(request):
    return web.json_response({"logFile": str(log_path()), "native": _native.status if _native else "not_started",
                              "recorder": _recorder.status if _recorder else "not_started",
                              "lastCapture": _recorder.last_capture if _recorder else None,
                              "lastCaptureResult": _recorder.last_capture_result if _recorder else None,
                              "lastPageBatch": _last_page, "maxFileBytes": 2*1024*1024, "backups": 3})
