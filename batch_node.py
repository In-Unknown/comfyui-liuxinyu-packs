import os
import re
import uuid
from pathlib import Path

import numpy as np
import torch
from PIL import Image
import folder_paths
from liuxinyu_cache import cached_preview, preview_path, rebuilding_preview


class SaveSelectedFromBatch:
    DISPLAY_NAME = "从批次中选择保存图片"
    _VALID_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    _PREFIX = "SaveSelectedFromBatch"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE", {"display_name": "图片", "tooltip": "要保存的输入图像批次。整批图片会先暂存到 ComfyUI 临时目录用于在节点上预览，然后根据「多选序列」自动保存到目标文件夹，或等待你在节点上勾选后手动保存。"}),
            "folder": ("STRING", {"default": "", "multiline": False, "display_name": "文件夹", "tooltip": "保存文件的绝对路径。仅预览时可留空；自动保存或点击「保存所选」前，需填写绝对路径，或点击「选择文件夹」按钮选择。"}),
            "filename": ("STRING", {"default": "image.png", "multiline": False, "display_name": "文件名", "tooltip": "保存时使用的文件名前缀，需包含扩展名（支持 .png / .jpg / .jpeg / .webp / .bmp）。仅接受纯文件名，不能包含路径分隔符。保存时按 {stem}_{k}.{ext}（k 从 1 递增）的顺序写入目标文件夹；多次保存会追加编号，不会覆盖已有文件。"}),
            "selection": ("STRING", {"default": "", "multiline": False, "display_name": "多选序列", "tooltip": "可选。指定要自动保存的批次下标，0-based，以英文逗号分隔，例如 \"1,3,6,0\"。为空时进入手动选择模式，需在节点预览中勾选图片后点击「保存所选」按钮。非空时按这些下标自动保存到目标文件夹，但仍可继续手动勾选并触发额外保存。"}),
        }}

    RETURN_TYPES = ()
    INPUT_IS_LIST = True
    FUNCTION = "execute"
    OUTPUT_NODE = True
    CATEGORY = "image"
    DESCRIPTION = "SaveSelectedFromBatch 节点将输入的整批图片先暂存到临时目录用于预览，再根据多选序列或手动勾选将选中的图片保存到指定绝对路径。仅预览时可留空保存文件夹，实际保存前再选择。"

    @staticmethod
    def _to_pil(image_tensor, ext):
        pixels = np.clip(image_tensor.detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
        if pixels.shape[-1] == 1:
            pixels = pixels[..., 0]
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

    @staticmethod
    def _parse_selection(selection, batch_size):
        if not selection:
            return []
        tokens = re.split(r"[,\s]+", selection.strip())
        seen = set()
        result = []
        for token in tokens:
            if not token:
                continue
            if not token.lstrip("+-").isdigit():
                continue
            idx = int(token)
            if idx < 0 or idx >= batch_size:
                continue
            if idx in seen:
                continue
            seen.add(idx)
            result.append(idx)
        return result

    @staticmethod
    def _find_max_k(folder, stem, suffix):
        if not os.path.isdir(folder):
            return 0
        pattern = re.compile(rf"^{re.escape(stem)}_(\d+){re.escape(suffix)}$")
        max_k = 0
        for name in os.listdir(folder):
            m = pattern.match(name)
            if m:
                k = int(m.group(1))
                if k > max_k:
                    max_k = k
        return max_k

    @staticmethod
    def _preview_name(session_id, index):
        return f"{SaveSelectedFromBatch._PREFIX}_{session_id}_{index:06d}.png"

    @classmethod
    def _validate_destination(cls, folder, filename):
        if not isinstance(folder, str) or not folder.strip():
            raise ValueError("请先选择保存文件夹；仅预览时可留空，多选序列也需留空。")
        folder = os.path.normpath(folder.strip())
        if not os.path.isabs(folder):
            raise ValueError(f"保存文件夹必须是绝对路径：{folder}")
        if not isinstance(filename, str) or not filename.strip():
            raise ValueError("filename cannot be empty")
        filename = filename.strip()
        fp = Path(filename)
        if fp.is_absolute() or fp.name != filename:
            raise ValueError("filename must contain only a file name")
        if not fp.suffix:
            raise ValueError("filename must include a file extension, e.g. image.png")
        stem = fp.stem
        suffix = fp.suffix
        ext = suffix.lower()
        if ext not in cls._VALID_EXTS:
            raise ValueError(f"unsupported extension: {ext}")
        return folder, stem, suffix, ext

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def execute(self, image, folder, filename, selection):
        return cached_preview("SaveSelectedFromBatch", dict(
            image=image, folder=folder, filename=filename, selection=selection,
        ), self._render)

    def _render(self, image, folder, filename, selection):
        if not isinstance(image, torch.Tensor) or image.ndim != 4:
            raise ValueError("IMAGE 必须是 [B, H, W, C] 张量，请检查上游节点是否保留了批次维度。")
        batch_size = image.shape[0]
        indices = self._parse_selection(selection, batch_size)
        selected = set(indices)
        if indices:
            folder, stem, suffix, ext = self._validate_destination(folder, filename)
        session_id = uuid.uuid4().hex

        ui_images = []
        for i in range(batch_size):
            preview_name = self._preview_name(session_id, i)
            img = self._to_pil(image[i], ".png")
            img.save(preview_path(preview_name), format="PNG")
            ui_images.append({
                "filename": preview_name,
                "subfolder": "",
                "type": "temp",
                "selected": i in selected,
            })

        auto_saved = []
        if indices and not rebuilding_preview():
            Path(folder).mkdir(parents=True, exist_ok=True)
            start_k = self._find_max_k(folder, stem, suffix) + 1
            for offset, idx in enumerate(indices):
                k = start_k + offset
                target = Path(folder) / f"{stem}_{k}{suffix}"
                img = self._to_pil(image[idx], ext)
                self._save_image(img, target, ext)
                auto_saved.append(str(target))

        ui = {"images": ui_images, "session_id": [session_id]}
        if auto_saved:
            ui["text"] = ["已自动保存 " + str(len(auto_saved)) + " 张：\n" + "\n".join(auto_saved)]
        else:
            ui["text"] = ["已生成 " + str(batch_size) + " 张预览，请在节点上勾选后点击「保存所选」按钮。"]

        return {"ui": ui}

    @staticmethod
    def save_selected_from_temp(session_id, indices, folder, filename, preview_files=None):
        """按显示下标读取对应预览文件；旧请求仍可指定单个 session。"""
        if not indices:
            return {"error": "请先勾选要保存的图片。"}
        if not isinstance(indices, list) or any(type(idx) is not int or idx < 0 for idx in indices):
            return {"error": "invalid indices"}
        if preview_files is not None:
            if not isinstance(preview_files, list) or any(
                not isinstance(name, str) or not re.fullmatch(r"SaveSelectedFromBatch_[0-9a-f]{32}_[0-9]{6,}\.png", name)
                for name in preview_files
            ):
                return {"error": "invalid preview filenames"}
            if any(idx >= len(preview_files) for idx in indices):
                return {"error": "preview index out of range"}
        elif not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f]{32}", session_id):
            return {"error": "invalid session_id; refresh the browser before saving multiple batches"}

        try:
            folder, stem, suffix, ext = SaveSelectedFromBatch._validate_destination(folder, filename)
        except ValueError as exc:
            return {"error": str(exc)}

        temp_dir = Path(folder_paths.get_temp_directory())
        Path(folder).mkdir(parents=True, exist_ok=True)
        start_k = SaveSelectedFromBatch._find_max_k(folder, stem, suffix) + 1

        saved = []
        skipped = []
        for idx in indices:
            preview_name = preview_files[idx] if preview_files is not None else SaveSelectedFromBatch._preview_name(session_id, idx)
            src = temp_dir / preview_name
            if not src.exists():
                skipped.append(idx)
                continue
            k = start_k + len(saved)
            target = Path(folder) / f"{stem}_{k}{suffix}"
            with Image.open(src) as img:
                if ext in {".jpg", ".jpeg"} and img.mode != "RGB":
                    with img.convert("RGB") as converted:
                        SaveSelectedFromBatch._save_image(converted, target, ext)
                else:
                    SaveSelectedFromBatch._save_image(img, target, ext)
            saved.append(str(target))

        msg = "已保存 " + str(len(saved)) + " 张"
        if skipped:
            msg += "，跳过 " + str(len(skipped)) + " 张（下标: " + ",".join(str(x) for x in skipped) + "）"
        return {"saved": saved, "skipped": skipped, "message": msg}
