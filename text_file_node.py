from pathlib import Path, PureWindowsPath

from comfy_api.latest import io


class LiuxinyuSaveTextFile(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuSaveTextFile",
            display_name="保存文本到文本文件",
            category="utils/string",
            description=(
                "将文本按 UTF-8 原样写入绝对路径，不额外添加 BOM 或换行。"
                "文件名可用任意后缀或无后缀，不按扩展名解析或转换内容。"
                "目录不存在时自动创建；关闭覆盖时自动追加 _1、_2… 避免重名。"
                "每次执行均写入，执行列表逐项保存；覆盖开启且文件名相同时，后项覆盖前项。"
            ),
            inputs=[
                io.String.Input("text", display_name="文本", default="", multiline=True,
                                tooltip="输入或连接要保存的文本。保留空格和换行，空字符串写为空文件；对象或数组请先字符串化。"),
                io.String.Input("folder", display_name="文件夹", default=r"D:\AI\outputs",
                                tooltip="保存目录的绝对路径，可点击选择文件夹。不存在的目录会自动创建。"),
                io.String.Input("filename", display_name="文件名", default="test.txt",
                                tooltip="纯文件名，例如 report.json、example.cs、data.png 或 README。不限制后缀，不转换文件格式。"),
                io.Boolean.Input("overwrite", display_name="覆盖已有文件", default=True,
                                 tooltip="开启时覆盖同名文件；关闭时在最后一个后缀前追加 _1、_2…，使用第一个未占用的名称。"),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, text, folder, filename, overwrite=True):
        folder = folder.strip()
        filename = filename.strip()
        if not folder or not Path(folder).is_absolute():
            raise ValueError("文件夹必须为非空的绝对路径。")
        if (not filename or filename in (".", "..")
                or PureWindowsPath(filename).name != filename
                or ":" in filename or filename.endswith(".")):
            raise ValueError("文件名必须是纯文件名，不能包含路径、冒号或以句点结尾。")
        if not isinstance(text, str):
            raise ValueError("文本必须为字符串；对象或数组请先转换为字符串。")
        data = text.encode("utf-8")
        path = Path(folder) / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        if overwrite:
            path.write_bytes(data)
        else:
            candidate = path
            counter = 0
            while True:
                if candidate.exists():
                    counter += 1
                    candidate = path.with_name(f"{path.stem}_{counter}{path.suffix}")
                    continue
                try:
                    stream = candidate.open("xb")
                except FileExistsError:
                    counter += 1
                    candidate = path.with_name(f"{path.stem}_{counter}{path.suffix}")
                    continue
                with stream:
                    stream.write(data)
                path = candidate
                break
        return io.NodeOutput(ui={"text": [f"已保存：{path}"]})
