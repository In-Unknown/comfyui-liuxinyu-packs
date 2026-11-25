"""预检工作区文件，仅将明确的普通文档交给 Windows 默认程序。"""

import asyncio
import json
import os
from pathlib import Path

from aiohttp import web
from server import PromptServer


def resolve_workspace_file(user_root, relative_path, *, allow_directory=False):
    if not isinstance(relative_path, str) or not relative_path:
        raise ValueError("请提供相对于工作区的文件路径。")
    parts = relative_path.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") or ":" in part or "\x00" in part for part in parts):
        raise ValueError("文件路径必须位于当前用户的 workflows 目录内。")
    root = (Path(user_root) / "workflows").resolve()
    target = root.joinpath(*parts).resolve()
    if not target.is_relative_to(root):
        raise ValueError("文件路径必须位于当前用户的 workflows 目录内。")
    if not (target.is_file() or (allow_directory and target.is_dir())):
        raise FileNotFoundError("文件不存在或不是普通文件，请刷新工作区列表。")
    return target


def reveal_in_explorer(target):
    """Use Shell item IDs, avoiding command-line quoting and Explorer switches."""
    import ctypes
    from ctypes import wintypes

    shell = ctypes.WinDLL("shell32", use_last_error=True)
    ole = ctypes.WinDLL("ole32", use_last_error=True)
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoTaskMemFree.argtypes = [ctypes.c_void_p]
    ole.CoUninitialize.argtypes = []
    shell.SHParseDisplayName.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p,
                                       ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD, ctypes.c_void_p]
    shell.SHParseDisplayName.restype = ctypes.c_long
    shell.SHOpenFolderAndSelectItems.argtypes = [ctypes.c_void_p, wintypes.UINT,
                                                ctypes.c_void_p, wintypes.DWORD]
    shell.SHOpenFolderAndSelectItems.restype = ctypes.c_long
    initialized = ole.CoInitializeEx(None, 2)
    if initialized < 0:
        raise OSError(f"Windows Shell 初始化失败：HRESULT 0x{initialized & 0xffffffff:08X}")
    item = ctypes.c_void_p()
    try:
        result = shell.SHParseDisplayName(str(target), None, ctypes.byref(item), 0, None)
        if result >= 0:
            # cidl=0 selects this absolute item in its parent, also for folders.
            result = shell.SHOpenFolderAndSelectItems(item, 0, None, 0)
        if result < 0:
            raise OSError(f"Windows Shell 定位失败：HRESULT 0x{result & 0xffffffff:08X}")
    finally:
        if item.value:
            ole.CoTaskMemFree(item)
        ole.CoUninitialize()


async def reveal_workspace_item(request):
    if os.name != "nt":
        return web.json_response({"error": "此功能需要运行在 Windows 上的 ComfyUI。"}, status=501)
    if request.content_type != "application/json":
        return web.json_response({"error": "请求必须使用 application/json。"}, status=400)
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("请求内容必须是包含 path 的对象。")
        user_root = PromptServer.instance.user_manager.get_request_user_filepath(
            request, None, create_dir=False,
        )
        if not user_root:
            return web.json_response({"error": "无法访问当前用户的工作区。"}, status=403)
        target = resolve_workspace_file(user_root, data.get("path"), allow_directory=True)
        await asyncio.to_thread(reveal_in_explorer, target)
        return web.json_response({"revealed": True})
    except KeyError:
        return web.json_response({"error": "无法访问当前用户的工作区。"}, status=403)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except FileNotFoundError:
        return web.json_response({"error": "文件或文件夹不存在，请刷新工作区列表。"}, status=404)
    except OSError as error:
        return web.json_response({"error": "资源管理器定位失败：" + str(error)}, status=500)


def may_be_workflow(target):
    """保守识别工作流痕迹，不校验节点、连线、版本或可执行性。"""
    try:
        with target.open(encoding="utf-8-sig") as file:
            data = json.load(file)
    except (ValueError, UnicodeError, RecursionError):
        # A broken JSON file may be a damaged workflow. Native loading owns
        # its diagnostic; a parse error is not evidence of a normal document.
        return True
    if data == {}:
        return True
    markers = {
        "nodes", "links", "last_node_id", "last_link_id", "definitions",
        "subgraphs", "graph", "workflow", "prompt", "templates", "version",
        "class_type", "inputs", "widgets_values",
    }
    # Preserve wrappers and partially damaged API graphs too. False positives
    # stay in ComfyUI; only documents with no workflow evidence go to Windows.
    stack = [data]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            if markers.intersection(value):
                return True
            if any(key.split(":", 1)[0].isdigit() for key in value):
                return True
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
    return False


async def open_workspace_file(request):
    if os.name != "nt":
        return web.json_response({"error": "此功能需要运行在 Windows 上的 ComfyUI。"}, status=501)
    if request.content_type != "application/json":
        return web.json_response({"error": "请求必须使用 application/json。"}, status=400)
    try:
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError("请求内容必须是包含 path 的对象。")
        # Reuse ComfyUI's user selection, but keep the raw filename intact:
        # passing it to get_request_user_filepath would URL-decode literal %.
        user_root = PromptServer.instance.user_manager.get_request_user_filepath(
            request, None, create_dir=False,
        )
        if not user_root:
            return web.json_response({"error": "无法访问当前用户的工作区。"}, status=403)
        target = resolve_workspace_file(user_root, data.get("path"))
        if (target.suffix.lower() == ".json" or data["path"].lower().endswith(".json")):
            if await asyncio.to_thread(may_be_workflow, target):
                return web.json_response({"opened": False, "action": "workflow"})
        await asyncio.to_thread(os.startfile, str(target), "open")
        return web.json_response({"opened": True})
    except KeyError:
        return web.json_response({"error": "无法访问当前用户的工作区。"}, status=403)
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except FileNotFoundError as error:
        return web.json_response({"error": str(error)}, status=404)
    except OSError as error:
        message = "Windows 未能打开文件：" + str(error)
        if getattr(error, "winerror", None) == 1155:
            message = "Windows 尚未为这种文件格式设置默认程序，请先在系统中设置打开方式。"
        return web.json_response({"error": message}, status=500)


PromptServer.instance.routes.post("/liuxinyu/workspace/open-file")(open_workspace_file)
PromptServer.instance.routes.post("/liuxinyu/workspace/reveal")(reveal_workspace_item)
