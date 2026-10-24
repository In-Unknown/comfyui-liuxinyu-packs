"""Session-only file fingerprints and the latest preview per node.

Image tensors stay in ComfyUI's own cache. This module retains only hashes,
paths and UI metadata, never a second copy of image tensors.
"""

import atexit
from collections import OrderedDict
from contextvars import ContextVar
import copy
import hashlib
import json
import logging
from pathlib import Path
import uuid

import torch
import folder_paths
from comfy.model_management import throw_exception_if_processing_interrupted
from comfy_execution.utils import get_executing_context


def file_digest(paths):
    """Read contents, not just mtime/size (same-size overwrites are common)."""
    digest = hashlib.sha256()
    for path in paths:
        path = Path(path)
        digest.update(str(path.resolve()).encode("utf-8"))
        digest.update(b"\0")
        try:
            if path.is_dir():
                for item in sorted(path.rglob("*")):
                    throw_exception_if_processing_interrupted()
                    stat = item.stat()
                    digest.update(repr((str(item.relative_to(path)), stat.st_mode, stat.st_size,
                                        stat.st_mtime_ns, stat.st_atime_ns, stat.st_ctime_ns,
                                        getattr(stat, "st_file_attributes", 0))).encode("utf-8"))
            else:
                with path.open("rb") as source:
                    while block := source.read(1024 * 1024):
                        throw_exception_if_processing_interrupted()
                        digest.update(block)
        except OSError as error:
            digest.update(f"missing:{type(error).__name__}:{error.errno}".encode())
        digest.update(b"\0")
    return digest.hexdigest()


def single_file(path):
    return [Path(path.strip().strip('"'))] if path.strip() else []


class FileChanges:
    """Watch resolved paths too: ComfyUI passes None for links in IS_CHANGED.

    Older linked values remain watched because RAM/LRU caches can revisit them.
    Evicting a watch advances the revision, invalidating those older cache keys.
    """

    def __init__(self):
        self.nodes = OrderedDict()

    def _state(self, kind):
        context = get_executing_context()
        if context is None:
            return None
        key = (kind, context.node_id)
        if key not in self.nodes:
            if len(self.nodes) >= 256:
                self.nodes.popitem(last=False)
            self.nodes[key] = {"revision": uuid.uuid4().hex, "sources": OrderedDict()}
        self.nodes.move_to_end(key)
        return self.nodes[key]

    @staticmethod
    def _digest(resolve, value):
        try:
            return file_digest(resolve(value))
        except (OSError, ValueError) as error:
            return (type(error).__name__, str(error))

    def fingerprint(self, kind, value, resolve=single_file):
        state = self._state(kind)
        if state is None:
            return self._digest(resolve, value) if value is not None else float("nan")
        sources = state["sources"]
        for previous, old_digest in list(sources.items()):
            new_digest = self._digest(resolve, previous)
            if new_digest != old_digest:
                sources[previous] = new_digest
                state["revision"] = uuid.uuid4().hex
        values = value if isinstance(value, (list, tuple)) else [value]
        for item in values:
            if item is not None:
                self._remember(state, item, resolve)
        preview = _source_previews.get((kind, get_executing_context().node_id))
        if preview and (
            (all(item is not None for item in values) and tuple(values) != preview["paths"])
            or not all(path.is_file() for path in preview["files"])
        ):
            state["revision"] = uuid.uuid4().hex
        return state["revision"]

    def _remember(self, state, value, resolve):
        sources = state["sources"]
        if value not in sources:
            if len(sources) >= 64:
                sources.popitem(last=False)
                state["revision"] = uuid.uuid4().hex
            sources[value] = self._digest(resolve, value)
        sources.move_to_end(value)

    def remember(self, kind, value, resolve=single_file):
        state = self._state(kind)
        if state is not None:
            self._remember(state, value, resolve)


file_changes = FileChanges()
_preview_entries = OrderedDict()
_source_previews = OrderedDict()
_writing_files = ContextVar("liuxinyu_preview_files", default=None)
_reuse_files = ContextVar("liuxinyu_reuse_preview_files", default=())
_rebuild_only = ContextVar("liuxinyu_rebuild_only", default=False)


def rebuilding_preview():
    return _rebuild_only.get()


def preview_path(name):
    path = Path(folder_paths.get_temp_directory()) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    files = _writing_files.get()
    if files is not None:
        files.append(path)
    return path


def save_source_preview(img, prefix):
    files = _writing_files.get()
    reusable = _reuse_files.get()
    if files is not None and len(files) < len(reusable) and reusable[len(files)].is_file():
        path = reusable[len(files)]
        files.append(path)
    else:
        path = preview_path(f"{prefix}_{uuid.uuid4().hex}.png")
        img.save(path, format="PNG")
    return {"filename": path.name, "subfolder": "", "type": "temp"}


def source_previews(kind, paths, render, output_count):
    """Map file loaders together so shorter lists also retire unused previews."""
    context = get_executing_context()
    if context is None:
        return render(paths)
    paths = paths if isinstance(paths, list) else [paths]
    key = (kind, context.node_id)
    state = file_changes._state(kind)
    signature = (str(Path(folder_paths.get_temp_directory()).resolve()), tuple(
        (path, file_digest(single_file(path))) for path in paths
    ))
    previous = _source_previews.get(key)
    reusable = previous["files"] if previous and signature == previous["signature"] else ()
    files = []
    token = _writing_files.set(files)
    reuse_token = _reuse_files.set(reusable)
    try:
        outputs = tuple([] for _ in range(output_count))
        ui = {"images": []}
        for path in paths:
            result = render(path)
            for output, value in zip(outputs, result["result"]):
                output.append(value)
            ui["images"].extend(result["ui"]["images"])
    except BaseException:
        _remove_files(set(files) - set(reusable))
        raise
    finally:
        _reuse_files.reset(reuse_token)
        _writing_files.reset(token)
    if previous and files != previous["files"]:
        # Old RAM/LRU entries must not reuse UI pointing at retired filenames.
        if state["revision"] == previous["revision"]:
            state["revision"] = uuid.uuid4().hex
        _remove_files(set(previous["files"]) - set(files))
    _source_previews[key] = {"signature": signature, "files": files, "paths": tuple(paths), "revision": state["revision"]}
    _source_previews.move_to_end(key)
    while len(_source_previews) > 256:
        evicted_key, evicted = _source_previews.popitem(last=False)
        file_changes.nodes.pop(evicted_key, None)
        _remove_files(evicted["files"])
    return {"result": outputs, "ui": ui}


def _remove_files(files):
    for path in files:
        try:
            path.unlink(missing_ok=True)
        except OSError as error:
            logging.warning("[liuxinyu] Cannot remove temporary preview %s: %s", path, error)


def _update_digest(digest, value):
    if isinstance(value, torch.Tensor):
        digest.update(str((tuple(value.shape), str(value.dtype))).encode())
        # Hash exact values before 8-bit conversion, one frame at a time.
        for frame in value.detach():
            throw_exception_if_processing_interrupted()
            pixels = frame.contiguous().cpu().view(torch.uint8).numpy()
            digest.update(memoryview(pixels).cast("B"))
    elif isinstance(value, (list, tuple)):
        digest.update(f"list:{len(value)}[".encode())
        for item in value:
            _update_digest(digest, item)
        digest.update(b"]")
    else:
        digest.update(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    digest.update(b"\0")


def cached_preview(kind, inputs, render):
    """Run terminal previews as one transaction, including mapped IMAGE lists.

    These nodes deliberately check their inputs on each run instead of letting
    the native RAM cache return old UI referencing files we have already retired.
    """
    context = get_executing_context()
    if context is None:
        return render(**inputs)
    values = {key: value if isinstance(value, list) else [value] for key, value in inputs.items()}
    key = (str(Path(folder_paths.get_temp_directory()).resolve()), kind, context.node_id)
    digest = hashlib.sha256()
    for name, value in sorted(values.items()):
        digest.update(name.encode())
        _update_digest(digest, value)
    signature = digest.hexdigest()
    previous = _preview_entries.get(key)
    if previous and previous["signature"] == signature and all(p.is_file() for p in previous["files"]):
        _preview_entries.move_to_end(key)
        return copy.deepcopy(previous["result"])

    files = []
    token = _writing_files.set(files)
    rebuilding = previous is not None and previous["signature"] == signature
    rebuild_token = _rebuild_only.set(rebuilding)
    try:
        ui = {"images": []}
        count = max((len(value) for value in values.values()), default=0) if all(values.values()) else 0
        for index in range(count):
            throw_exception_if_processing_interrupted()
            result = render(**{name: value[min(index, len(value) - 1)] for name, value in values.items()})
            for name, items in result["ui"].items():
                ui.setdefault(name, []).extend(items)
        if rebuilding and "text" in previous["result"]["ui"]:
            ui["text"] = copy.deepcopy(previous["result"]["ui"]["text"])
        result = {"ui": ui}
    except BaseException:
        _remove_files(files)
        raise
    finally:
        _rebuild_only.reset(rebuild_token)
        _writing_files.reset(token)

    _preview_entries[key] = {"signature": signature, "files": files, "result": copy.deepcopy(result)}
    _preview_entries.move_to_end(key)
    if previous:
        _remove_files(previous["files"])
    while len(_preview_entries) > 256:
        _, evicted = _preview_entries.popitem(last=False)
        _remove_files(evicted["files"])
    return result


def clear_previews():
    for entry in _preview_entries.values():
        _remove_files(entry["files"])
    _preview_entries.clear()
    for key, entry in _source_previews.items():
        file_changes.nodes.pop(key, None)
        _remove_files(entry["files"])
    _source_previews.clear()


atexit.register(clear_previews)
