import asyncio
import ctypes
import csv
import io
import importlib.util as _ilu
import os
from pathlib import Path

import numpy as np
import torch
from PIL import Image
import folder_paths


# Load batch_node.py via importlib so the package works regardless of how
# ComfyUI registers the custom_node module name (which contains a dash and
# cannot be imported through a normal relative import).
_batch_spec = _ilu.spec_from_file_location(
    "_save_image_to_path_batch_node",
    os.path.join(os.path.dirname(__file__), "batch_node.py"),
)
if _batch_spec is None or _batch_spec.loader is None:
    raise ImportError("Failed to load batch_node.py spec")
_batch_module = _ilu.module_from_spec(_batch_spec)
_batch_spec.loader.exec_module(_batch_module)
SaveSelectedFromBatch = _batch_module.SaveSelectedFromBatch

# 同理加载 compositing_node.py（遮罩区域图片排列组合，基于核心新版 io 框架）
_compositing_spec = _ilu.spec_from_file_location(
    "_save_image_to_path_compositing_node",
    os.path.join(os.path.dirname(__file__), "compositing_node.py"),
)
if _compositing_spec is None or _compositing_spec.loader is None:
    raise ImportError("Failed to load compositing_node.py spec")
_compositing_module = _ilu.module_from_spec(_compositing_spec)
_compositing_spec.loader.exec_module(_compositing_module)
ImageMaskCombinations = _compositing_module.ImageMaskCombinations


if os.name == "nt":
    import ctypes.wintypes as wintypes
    from aiohttp import web
    from server import PromptServer

    class GUID(ctypes.Structure):
        _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort), ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]

    CLSID_FileOpenDialog = "{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}"
    IID_IFileOpenDialog = "{D57C7288-D4AD-4768-BE02-9D969532D960}"
    IID_IShellItem = "{43826D1E-E718-42EE-BC55-A1E261C37BFE}"

    FOS_PICKFOLDERS = 0x00000020
    FOS_FORCEFILESYSTEM = 0x00000040
    FOS_PATHMUSTEXIST = 0x00000800
    SIGDN_FILESYSPATH = 0x80058000
    COINIT_APARTMENTTHREADED = 0x2

    def _com_method(obj, index, restype, *argtypes):
        vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        fn_addr = vtbl[index]
        return ctypes.CFUNCTYPE(restype, ctypes.c_void_p, *argtypes)(fn_addr)

    def _release(obj):
        if obj:
            _com_method(obj, 2, ctypes.c_ulong) (obj)

    def _pick_folder_native(default_path=""):
        default_path = os.path.normpath(default_path.strip()) if default_path else ""
        ole32 = ctypes.windll.ole32
        shell32 = ctypes.windll.shell32
        user32 = ctypes.windll.user32

        # ComfyUI's Python process may not use the same DPI awareness as the
        # browser/official dialogs. Create the native dialog on this worker
        # thread in Per-Monitor V2 so Windows renders it at the monitor's
        # actual scale instead of bitmap-scaling a 96/144-DPI dialog.
        dpi_context = ctypes.c_void_p(-4)  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        set_thread_dpi = user32.SetThreadDpiAwarenessContext
        set_thread_dpi.argtypes = [ctypes.c_void_p]
        set_thread_dpi.restype = ctypes.c_void_p
        old_dpi_context = set_thread_dpi(dpi_context)

        hr = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
        com_initialized = hr in (0, 1)  # S_OK / S_FALSE
        if hr not in (0, 1, 0x80010106):
            raise OSError(f"CoInitializeEx failed: 0x{hr & 0xffffffff:08X}")

        dialog = ctypes.c_void_p()
        try:
            hr = ole32.CoCreateInstance(
                ctypes.byref(_guid(CLSID_FileOpenDialog)),
                None,
                1,  # CLSCTX_INPROC_SERVER
                ctypes.byref(_guid(IID_IFileOpenDialog)),
                ctypes.byref(dialog),
            )
            if hr < 0:
                raise OSError(f"CoCreateInstance failed: 0x{hr & 0xffffffff:08X}")

            options = ctypes.c_uint32()
            hr = _com_method(dialog, 10, ctypes.c_long, ctypes.POINTER(ctypes.c_uint32))(dialog, ctypes.byref(options))
            if hr < 0:
                raise OSError(f"GetOptions failed: 0x{hr & 0xffffffff:08X}")
            options.value |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
            hr = _com_method(dialog, 9, ctypes.c_long, ctypes.c_uint32)(dialog, options.value)
            if hr < 0:
                raise OSError(f"SetOptions failed: 0x{hr & 0xffffffff:08X}")

            title = ctypes.c_wchar_p("选择保存文件夹")
            _com_method(dialog, 17, ctypes.c_long, ctypes.c_wchar_p)(dialog, title)

            # Start from the folder currently written in the node.
            # IFileDialog::SetFolder forces the dialog to open there.
            if default_path and os.path.isdir(default_path):
                shell32.SHCreateItemFromParsingName.argtypes = [
                    ctypes.c_wchar_p,
                    ctypes.c_void_p,
                    ctypes.POINTER(GUID),
                    ctypes.POINTER(ctypes.c_void_p),
                ]
                shell32.SHCreateItemFromParsingName.restype = ctypes.c_long
                shell_item = ctypes.c_void_p()
                iid_shell_item = _guid(IID_IShellItem)
                hr = shell32.SHCreateItemFromParsingName(
                    ctypes.c_wchar_p(default_path),
                    None,
                    ctypes.byref(iid_shell_item),
                    ctypes.byref(shell_item),
                )
                if hr >= 0 and shell_item:
                    try:
                        hr = _com_method(dialog, 12, ctypes.c_long, ctypes.c_void_p)(dialog, shell_item)
                        if hr < 0:
                            raise OSError(f"SetFolder failed: 0x{hr & 0xffffffff:08X}")
                    finally:
                        _release(shell_item)

            owner = user32.GetForegroundWindow()
            hr = _com_method(dialog, 3, ctypes.c_long, wintypes.HWND)(dialog, owner)
            if (hr & 0xffffffff) == 0x800704C7:  # ERROR_CANCELLED
                return None
            if hr < 0:
                raise OSError(f"File dialog failed: 0x{hr & 0xffffffff:08X}")

            shell_item = ctypes.c_void_p()
            hr = _com_method(dialog, 20, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p))(dialog, ctypes.byref(shell_item))
            if hr < 0:
                raise OSError(f"GetResult failed: 0x{hr & 0xffffffff:08X}")
            try:
                path_ptr = ctypes.c_wchar_p()
                hr = _com_method(shell_item, 5, ctypes.c_long, ctypes.c_uint32, ctypes.POINTER(ctypes.c_wchar_p))(shell_item, SIGDN_FILESYSPATH, ctypes.byref(path_ptr))
                if hr < 0 or not path_ptr.value:
                    raise OSError(f"GetDisplayName failed: 0x{hr & 0xffffffff:08X}")
                result = path_ptr.value
                ole32.CoTaskMemFree(path_ptr)
                return result
            finally:
                _release(shell_item)
        finally:
            _release(dialog)
            if com_initialized:
                ole32.CoUninitialize()
            if old_dpi_context:
                set_thread_dpi(old_dpi_context)

    def _pick_file_native(default_path="", multiple=False):
        if multiple and default_path:
            try:
                default_path = LoadImageBatchFromPath._parse_paths(default_path)[0]
            except ValueError:
                default_path = ""
        default_path = os.path.normpath(default_path.strip()) if default_path else ""
        ole32 = ctypes.windll.ole32
        shell32 = ctypes.windll.shell32
        user32 = ctypes.windll.user32

        dpi_context = ctypes.c_void_p(-4)
        set_thread_dpi = user32.SetThreadDpiAwarenessContext
        set_thread_dpi.argtypes = [ctypes.c_void_p]
        set_thread_dpi.restype = ctypes.c_void_p
        old_dpi_context = set_thread_dpi(dpi_context)

        hr = ole32.CoInitializeEx(None, COINIT_APARTMENTTHREADED)
        com_initialized = hr in (0, 1)
        if hr not in (0, 1, 0x80010106):
            raise OSError(f"CoInitializeEx failed: 0x{hr & 0xffffffff:08X}")

        dialog = ctypes.c_void_p()
        try:
            hr = ole32.CoCreateInstance(
                ctypes.byref(_guid(CLSID_FileOpenDialog)),
                None,
                1,
                ctypes.byref(_guid(IID_IFileOpenDialog)),
                ctypes.byref(dialog),
            )
            if hr < 0:
                raise OSError(f"CoCreateInstance failed: 0x{hr & 0xffffffff:08X}")

            options = ctypes.c_uint32()
            hr = _com_method(dialog, 10, ctypes.c_long, ctypes.POINTER(ctypes.c_uint32))(dialog, ctypes.byref(options))
            if hr < 0:
                raise OSError(f"GetOptions failed: 0x{hr & 0xffffffff:08X}")
            options.value |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST
            if multiple:
                options.value |= 0x00000200 | 0x00001000  # FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST
            hr = _com_method(dialog, 9, ctypes.c_long, ctypes.c_uint32)(dialog, options.value)
            if hr < 0:
                raise OSError(f"SetOptions failed: 0x{hr & 0xffffffff:08X}")

            title = ctypes.c_wchar_p("选择图片（多选）" if multiple else "选择文件")
            _com_method(dialog, 17, ctypes.c_long, ctypes.c_wchar_p)(dialog, title)
            if multiple:
                class COMDLG_FILTERSPEC(ctypes.Structure):
                    _fields_ = [("pszName", ctypes.c_wchar_p), ("pszSpec", ctypes.c_wchar_p)]

                extensions = sorted(ext for ext, fmt in Image.registered_extensions().items() if fmt in Image.OPEN)
                filters = (COMDLG_FILTERSPEC * 1)(COMDLG_FILTERSPEC("图片", ";".join("*" + ext for ext in extensions)))
                hr = _com_method(dialog, 4, ctypes.c_long, ctypes.c_uint, ctypes.POINTER(COMDLG_FILTERSPEC))(dialog, 1, filters)
                if hr < 0:
                    raise OSError(f"SetFileTypes failed: 0x{hr & 0xffffffff:08X}")

            if default_path and os.path.isfile(default_path):
                pidl = ctypes.c_void_p()
                shell32.SHParseDisplayName.argtypes = [
                    ctypes.c_wchar_p,
                    ctypes.c_void_p,
                    ctypes.POINTER(ctypes.c_void_p),
                    ctypes.c_ulong,
                    ctypes.POINTER(ctypes.c_ulong),
                ]
                shell32.SHParseDisplayName.restype = ctypes.c_long
                attrs = ctypes.c_ulong()
                hr = shell32.SHParseDisplayName(
                    ctypes.c_wchar_p(default_path),
                    None,
                    ctypes.byref(pidl),
                    0,
                    ctypes.byref(attrs),
                )
                if hr >= 0 and pidl:
                    try:
                        shell_item = ctypes.c_void_p()
                        iid_shell_item = _guid(IID_IShellItem)
                        shell32.SHCreateItemFromParsingName.argtypes = [
                            ctypes.c_wchar_p,
                            ctypes.c_void_p,
                            ctypes.POINTER(GUID),
                            ctypes.POINTER(ctypes.c_void_p),
                        ]
                        shell32.SHCreateItemFromParsingName.restype = ctypes.c_long
                        hr = shell32.SHCreateItemFromParsingName(
                            ctypes.c_wchar_p(os.path.dirname(default_path)),
                            None,
                            ctypes.byref(iid_shell_item),
                            ctypes.byref(shell_item),
                        )
                        if hr >= 0 and shell_item:
                            try:
                                _com_method(dialog, 12, ctypes.c_long, ctypes.c_void_p)(dialog, shell_item)
                            finally:
                                _release(shell_item)
                    finally:
                        ole32.CoTaskMemFree(pidl)

            owner = user32.GetForegroundWindow()
            hr = _com_method(dialog, 3, ctypes.c_long, wintypes.HWND)(dialog, owner)
            if (hr & 0xffffffff) == 0x800704C7:
                return None
            if hr < 0:
                raise OSError(f"File dialog failed: 0x{hr & 0xffffffff:08X}")

            if multiple:
                items = ctypes.c_void_p()
                hr = _com_method(dialog, 27, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p))(dialog, ctypes.byref(items))
                if hr < 0:
                    raise OSError(f"GetResults failed: 0x{hr & 0xffffffff:08X}")
                try:
                    count = ctypes.c_uint32()
                    hr = _com_method(items, 7, ctypes.c_long, ctypes.POINTER(ctypes.c_uint32))(items, ctypes.byref(count))
                    if hr < 0:
                        raise OSError(f"GetCount failed: 0x{hr & 0xffffffff:08X}")
                    paths = []
                    for index in range(count.value):
                        item = ctypes.c_void_p()
                        hr = _com_method(items, 8, ctypes.c_long, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p))(items, index, ctypes.byref(item))
                        if hr < 0:
                            raise OSError(f"GetItemAt failed: 0x{hr & 0xffffffff:08X}")
                        try:
                            path_ptr = ctypes.c_wchar_p()
                            hr = _com_method(item, 5, ctypes.c_long, ctypes.c_uint32, ctypes.POINTER(ctypes.c_wchar_p))(item, SIGDN_FILESYSPATH, ctypes.byref(path_ptr))
                            try:
                                if hr < 0 or not path_ptr.value:
                                    raise OSError(f"GetDisplayName failed: 0x{hr & 0xffffffff:08X}")
                                paths.append(path_ptr.value)
                            finally:
                                if path_ptr:
                                    ole32.CoTaskMemFree(path_ptr)
                        finally:
                            _release(item)
                    return paths
                finally:
                    _release(items)

            shell_item = ctypes.c_void_p()
            hr = _com_method(dialog, 20, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p))(dialog, ctypes.byref(shell_item))
            if hr < 0:
                raise OSError(f"GetResult failed: 0x{hr & 0xffffffff:08X}")
            try:
                path_ptr = ctypes.c_wchar_p()
                hr = _com_method(shell_item, 5, ctypes.c_long, ctypes.c_uint32, ctypes.POINTER(ctypes.c_wchar_p))(shell_item, SIGDN_FILESYSPATH, ctypes.byref(path_ptr))
                if hr < 0 or not path_ptr.value:
                    raise OSError(f"GetDisplayName failed: 0x{hr & 0xffffffff:08X}")
                result = path_ptr.value
                ole32.CoTaskMemFree(path_ptr)
                return result
            finally:
                _release(shell_item)
        finally:
            _release(dialog)
            if com_initialized:
                ole32.CoUninitialize()
            if old_dpi_context:
                set_thread_dpi(old_dpi_context)

    def _guid(value):
        guid = GUID()
        ole32 = ctypes.windll.ole32
        hr = ole32.CLSIDFromString(ctypes.c_wchar_p(value), ctypes.byref(guid))
        if hr != 0:
            raise OSError(f"CLSIDFromString failed: 0x{hr & 0xffffffff:08X}")
        return guid

    async def _select_folder(request):
        try:
            current_folder = request.query.get("folder", "")
            folder = await asyncio.to_thread(_pick_folder_native, current_folder)
            return web.json_response({"folder": folder})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def _select_file(request):
        try:
            current_path = request.query.get("path", "")
            file_path = await asyncio.to_thread(_pick_file_native, current_path)
            return web.json_response({"path": file_path})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    async def _select_images(request):
        try:
            paths = await asyncio.to_thread(_pick_file_native, request.query.get("path", ""), True)
            return web.json_response({"paths": paths})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    PromptServer.instance.routes.get("/save_image_to_path/select_images")(_select_images)
    PromptServer.instance.routes.get("/save_image_to_path/select_folder")(_select_folder)
    PromptServer.instance.routes.get("/save_image_to_path/select_file")(_select_file)

    async def _save_selected(request):
        try:
            data = await request.json()
            result = SaveSelectedFromBatch.save_selected_from_temp(
                data.get("session_id", ""),
                data.get("indices", []),
                data.get("folder", ""),
                data.get("filename", ""),
            )
            status = 500 if "error" in result else 200
            return web.json_response(result, status=status)
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    PromptServer.instance.routes.post("/save_image_to_path/save_selected")(_save_selected)


class SaveImageToAbsolutePath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE", {"display_name": "图片", "tooltip": "要保存的输入图像。支持批次传入：当批次数量为 1 时保存为单个文件；当批次数量大于 1 时，自动创建与文件名同名的子文件夹，将批次中的每张图片按序号依次保存到其中。"}),
            "folder": ("STRING", {"default": r"D:\\AI\\outputs", "multiline": False, "display_name": "文件夹", "tooltip": "保存文件的绝对路径。必须为绝对路径，不能为空。可点击下方的「选择文件夹」按钮调用系统原生对话框进行选择。"}),
            "filename": ("STRING", {"default": "test.png", "multiline": False, "display_name": "文件名", "tooltip": "要保存的文件名，需包含扩展名（支持 .png / .jpg / .jpeg / .webp / .bmp）。仅接受纯文件名，不能包含路径分隔符。当批次大于 1 时，此名称同时用作子文件夹名，文件夹内的每张图片以「文件名-序号.扩展名」格式命名，序号前导零位数由批次数量决定。"}),
            "overwrite": ("BOOLEAN", {"default": True, "display_name": "覆盖已有文件", "tooltip": "为 True 时直接覆盖同名文件或文件夹。为 False 时启用自动编号：若保存单张图片且目标文件已存在，则在文件名后追加 _1、_2… 后缀，从小到大找到第一个不存在的名称；若保存批次图片且同名文件夹已存在，则对文件夹名追加 _1、_2… 后缀。文件与文件夹的冲突也会被检测，不会出现同名文件与文件夹并存的情况。"}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "image"
    DESCRIPTION = "SaveImageToAbsolutePath 节点将图像保存到指定的绝对路径。支持单张图片和批次图片保存：单张图片直接保存为文件；批次图片自动创建与文件名同名的子文件夹，将批次中的每张图片按序号依次保存。覆盖关闭时自动追加编号避免重名。"

    @staticmethod
    def _to_pil(image_tensor, ext):
        pixels = np.clip(image_tensor.detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
        img = Image.fromarray(pixels)
        if ext in {".jpg", ".jpeg"} and img.mode != "RGB":
            img = img.convert("RGB")
        return img

    @staticmethod
    def _save_image(img, path, ext):
        if ext in {".jpg", ".jpeg"}:
            img.save(path, format="JPEG", quality=95)
        elif ext == ".webp":
            img.save(path, format="WEBP", quality=95)
        elif ext == ".bmp":
            img.save(path, format="BMP")
        else:
            img.save(path, format="PNG")

    def save(self, image, folder, filename, overwrite=True):
        folder = os.path.normpath(folder.strip())
        filename = filename.strip()
        if not folder:
            raise ValueError("folder cannot be empty")
        if not os.path.isabs(folder):
            raise ValueError(f"folder must be an absolute path: {folder}")
        if not filename:
            raise ValueError("filename cannot be empty")
        fp = Path(filename)
        if fp.is_absolute() or fp.name != filename:
            raise ValueError("filename must contain only a file name")
        if not fp.suffix:
            raise ValueError("filename must include a file extension, e.g. test.png")

        stem = fp.stem
        suffix = fp.suffix
        ext = suffix.lower()
        batch_size = image.shape[0]

        preview_dir = Path(folder_paths.get_temp_directory())
        preview_dir.mkdir(parents=True, exist_ok=True)

        if batch_size == 1:
            path = Path(folder) / filename
            if not overwrite and (path.exists() or (Path(folder) / stem).exists()):
                counter = 1
                while True:
                    candidate = path.with_name(f"{stem}_{counter}{suffix}")
                    candidate_folder = Path(folder) / f"{stem}_{counter}"
                    if not candidate.exists() and not candidate_folder.exists():
                        path = candidate
                        break
                    counter += 1
            path.parent.mkdir(parents=True, exist_ok=True)

            img = self._to_pil(image[0], ext)
            self._save_image(img, path, ext)

            preview_name = f"SaveImageToAbsolutePath_{os.getpid()}_{id(image)}.png"
            img.save(preview_dir / preview_name, format="PNG")

            return {
                "ui": {
                    "images": [{
                        "filename": preview_name,
                        "subfolder": "",
                        "type": "temp",
                    }],
                    "text": [f"已保存：{path}"],
                }
            }

        # Batch: save into a subfolder named after the stem.
        digits = len(str(batch_size))
        subfolder = Path(folder) / stem
        if not overwrite and (subfolder.exists() or (Path(folder) / f"{stem}{suffix}").exists()):
            counter = 1
            while True:
                candidate_name = f"{stem}_{counter}"
                candidate = Path(folder) / candidate_name
                if not candidate.exists() and not (Path(folder) / f"{candidate_name}{suffix}").exists():
                    subfolder = candidate
                    stem = candidate_name
                    break
                counter += 1
        subfolder.mkdir(parents=True, exist_ok=True)

        ui_images = []
        for i in range(batch_size):
            file_path = subfolder / f"{stem}-{str(i + 1).zfill(digits)}{suffix}"
            img = self._to_pil(image[i], ext)
            self._save_image(img, file_path, ext)

            preview_name = f"SaveImageToAbsolutePath_{os.getpid()}_{id(image)}_{i}.png"
            img.save(preview_dir / preview_name, format="PNG")
            ui_images.append({
                "filename": preview_name,
                "subfolder": "",
                "type": "temp",
            })

        return {
            "ui": {
                "images": ui_images,
                "text": [f"已保存 {batch_size} 张图片到：{subfolder}"],
            }
        }


class LoadImageFromPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "path": ("STRING", {"default": "", "multiline": False, "display_name": "文件路径", "tooltip": "要加载的图片文件的绝对路径。支持 .png / .jpg / .jpeg / .webp / .bmp 等格式。"}),
        }}

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("图片", "宽度", "高度")
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "image"
    DESCRIPTION = "LoadImageFromPath 节点从指定的绝对路径加载图片文件，输出为 IMAGE 类型及图片的宽度和高度。节点上会显示已加载图片的预览。"

    def execute(self, path):
        path = path.strip()
        if not path or not os.path.isfile(path):
            raise ValueError(f"文件不存在：{path}")

        from PIL import ImageOps
        img = Image.open(path)
        if img is None:
            raise ValueError(f"无法加载图片：{path}")
        img = ImageOps.exif_transpose(img)
        if img is None:
            raise ValueError(f"无法处理图片EXIF：{path}")
        img = img.convert("RGB")
        w, h = img.size
        image = np.array(img).astype(np.float32) / 255.0
        image = torch.from_numpy(image)[None,]

        preview_dir = Path(folder_paths.get_temp_directory())
        preview_dir.mkdir(parents=True, exist_ok=True)
        preview_name = f"LoadImageFromPath_{os.getpid()}_{hash(path)}.png"
        preview_path = preview_dir / preview_name
        img.save(preview_path, format="PNG")

        return {
            "result": (image, w, h),
            "ui": {
                "images": [{
                    "filename": preview_name,
                    "subfolder": "",
                    "type": "temp",
                }],
            },
        }


class LoadImageBatchFromPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "path": ("STRING", {"default": "", "multiline": False, "display_name": "图像路径", "tooltip": "可输入或连接 STRING：单个文件夹（递归加载）、单张图片路径，或用英文逗号分隔且每项用双引号包裹的多图片路径。支持路径内逗号（CSV 双引号转义）。可使用「选择图片（多选）」或「选择文件夹」按钮。文件夹按相对路径排序，多文件保持输入顺序。按 EXIF 修正方向后，所有图片宽高比必须完全一致；不同尺寸使用 LANCZOS 上采样到像素最多的图片尺寸。动图和多页图片仅加载第一帧。"}),
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像批次",)
    FUNCTION = "execute"
    CATEGORY = "image"
    DESCRIPTION = "从文件夹、单文件或 CSV 多文件路径加载 RGB 图像批次。递归目录按路径排序；EXIF 修正后的宽高比必须精确一致，并统一上采样到最大尺寸。"

    @staticmethod
    def _parse_paths(path):
        text = path.strip()
        if not text:
            raise ValueError("图像路径不能为空。")
        if not text.startswith('"'):
            return [text]
        try:
            rows = list(csv.reader(io.StringIO(text), skipinitialspace=True, strict=True))
        except csv.Error as e:
            raise ValueError(f"多文件路径格式错误，请使用双引号包裹每个路径并以英文逗号分隔：{e}") from e
        if len(rows) != 1 or not rows[0] or any(not item.strip() for item in rows[0]):
            raise ValueError("多文件路径格式错误：路径不能为空，且必须为单行 CSV。")
        return rows[0]

    @classmethod
    def _resolve_paths(cls, path):
        paths = [Path(item) for item in cls._parse_paths(path)]
        if len(paths) == 1 and paths[0].is_dir():
            root = paths[0]
            extensions = {ext for ext, fmt in Image.registered_extensions().items() if fmt in Image.OPEN}
            files = []

            def scan_error(error):
                raise ValueError(f"无法读取图像目录：{error.filename}：{error}") from error

            for folder, _, names in os.walk(root, onerror=scan_error):
                files.extend(Path(folder) / name for name in names if Path(name).suffix.lower() in extensions)
            paths = sorted(files, key=lambda p: (p.relative_to(root).as_posix().casefold(), p.relative_to(root).as_posix()))
            if not paths:
                raise ValueError(f"文件夹中没有支持的图片（已递归搜索）：{root}")
        for item in paths:
            if not item.is_file():
                raise ValueError(f"无效图像文件路径（不存在、不可访问或不是文件；多文件输入不允许包含文件夹）：{item}")
        return paths

    @classmethod
    def IS_CHANGED(cls, path):
        # 外部文件或目录内容可能在相同路径下被替换，执行时重新读取。
        return float("nan")

    def execute(self, path):
        from PIL import ImageOps

        paths = self._resolve_paths(path)
        images = []
        try:
            for item in paths:
                try:
                    with Image.open(item) as source:
                        corrected = ImageOps.exif_transpose(source)
                        try:
                            img = corrected.convert("RGB")
                        finally:
                            if corrected is not source:
                                corrected.close()
                    images.append(img)
                except Exception as e:
                    raise ValueError(f"无法加载图片（损坏、不支持或无法读取）：{item}：{e}") from e
                w, h = img.size
                first_w, first_h = images[0].size
                if w * first_h != first_w * h:
                    raise ValueError(f"图片宽高比不一致（EXIF 修正后）：{paths[0]}（{first_w}×{first_h}）与 {item}（{w}×{h}）。所有图片必须具有完全相同的宽高比。")

            target = max((img.size for img in images), key=lambda size: size[0] * size[1])
            tensors = []
            for img in images:
                if img.size == target:
                    pixels = np.array(img, dtype=np.float32) / 255.0
                else:
                    with img.resize(target, Image.Resampling.LANCZOS) as resized:
                        pixels = np.array(resized, dtype=np.float32) / 255.0
                tensors.append(torch.from_numpy(pixels))
            return (torch.stack(tensors),)
        finally:
            for img in images:
                img.close()


class LoadPath:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "path": ("STRING", {"default": "", "multiline": False, "display_name": "文件路径", "tooltip": "文件的绝对路径。可点击下方的「选择文件」按钮调用系统原生对话框进行选择，也可手动输入。"}),
        }}

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("完整路径", "文件名", "无后缀文件名", "后缀")
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "image"
    DESCRIPTION = "LoadPath 节点通过系统原生文件选择对话框选取文件路径，输出完整路径、文件名（含扩展名）、无后缀文件名和后缀。若文件为图片则显示预览。可手动输入或通过按钮选择文件。"

    _IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff"}

    def execute(self, path):
        path = path.strip()
        filename = os.path.basename(path) if path else ""
        if "." in filename:
            stem, ext = filename.rsplit(".", 1)
        else:
            stem, ext = filename, ""

        ui = {}
        if path and os.path.isfile(path) and f".{ext.lower()}" in self._IMAGE_EXTS:
            try:
                from PIL import ImageOps
                img = Image.open(path)
                if img is not None:
                    img = ImageOps.exif_transpose(img)
                    if img is not None:
                        img = img.convert("RGB")
                        preview_dir = Path(folder_paths.get_temp_directory())
                        preview_dir.mkdir(parents=True, exist_ok=True)
                        preview_name = f"LoadPath_{os.getpid()}_{hash(path)}.png"
                        img.save(preview_dir / preview_name, format="PNG")
                        ui["images"] = [{
                            "filename": preview_name,
                            "subfolder": "",
                            "type": "temp",
                        }]
            except Exception:
                pass

        return {"result": (path, filename, stem, ext), "ui": ui}


NODE_CLASS_MAPPINGS = {
    "SaveImageToAbsolutePath": SaveImageToAbsolutePath,
    "SaveSelectedFromBatch": SaveSelectedFromBatch,
    "LoadPath": LoadPath,
    "LoadImageFromPath": LoadImageFromPath,
    "LoadImageBatchFromPath": LoadImageBatchFromPath,
    "ImageMaskCombinations": ImageMaskCombinations,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "SaveImageToAbsolutePath": "保存图像到绝对路径",
    "SaveSelectedFromBatch": "从批次中选择保存图片",
    "LoadPath": "加载路径",
    "LoadImageFromPath": "从路径加载图片",
    "LoadImageBatchFromPath": "从路径加载图像批次",
    "ImageMaskCombinations": "遮罩区域图片排列组合",
}
WEB_DIRECTORY = "."
