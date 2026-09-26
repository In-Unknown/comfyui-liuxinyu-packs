import asyncio
import ctypes
import os
from pathlib import Path

import numpy as np
from PIL import Image
import folder_paths


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
            if hr == 0x800704C7:  # ERROR_CANCELLED
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

    PromptServer.instance.routes.get("/save_image_to_path/select_folder")(_select_folder)


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


NODE_CLASS_MAPPINGS = {"SaveImageToAbsolutePath": SaveImageToAbsolutePath}
NODE_DISPLAY_NAME_MAPPINGS = {"SaveImageToAbsolutePath": "保存图像到绝对路径"}
WEB_DIRECTORY = "."
