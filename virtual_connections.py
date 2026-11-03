"""Canvas endpoints compiled to ordinary links before prompt submission."""

from comfy_api.latest import io


def key_input():
    return io.String.Input("key", display_name="键", default="", socketless=True,
                           tooltip="本工作流中的配对名称，区分大小写和空格。同键只允许一个传入端，可对应多个传出端。")


class LiuxinyuVirtualOutput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuVirtualOutput", display_name="传入虚拟连接", category="liuxinyu/虚拟连接",
            description=("将输入通过多个同键的“传出虚拟连接”送到不同位置。键为空时无数据端口；"
                         "任一端连接时同步增长；某一路在传入端和全部传出端都断开后同步收起，后续编号前移但配对不变；键控件不占数据通道。"
                         "已使用的传出路缺少对应输入时，运行前报错。运行时还原为普通连线，不存储变量。"),
            inputs=[key_input()], outputs=[], accept_all_inputs=True,
        )

    @classmethod
    def execute(cls, **kwargs):
        raise RuntimeError("虚拟连接尚未转换为实际连线。请刷新前端后运行，或使用前端导出的 API 工作流。")


class LiuxinyuVirtualInput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuVirtualInput", display_name="传出虚拟连接", category="liuxinyu/虚拟连接",
            description=("从唯一的同键“传入虚拟连接”取得各路上游结果，按编号一一对应；可在多处添加同键传出端。"
                         "键为空时无数据端口，填写后与所有同键端点双向同步；仅当某一路在全部端点都断开时收起，始终保留一个备用空口。"
                         "输出已连下游而对应传入路缺连时，运行前报错；未用备用口不报错。"
                         "保留原始类型、数组、图片批次和执行列表语义。"),
            inputs=[key_input()], outputs=[io.AnyType.Output(display_name="输出 1")],
        )

    @classmethod
    def execute(cls, **kwargs):
        raise RuntimeError("虚拟连接尚未转换为实际连线。请刷新前端后运行，或使用前端导出的 API 工作流。")
