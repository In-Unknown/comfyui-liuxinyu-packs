"""Explicit workflow failure controlled by a boolean input."""

from comfy_api.latest import io


class LiuxinyuRaiseIf(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuRaiseIf",
            display_name="条件为真时报错停止",
            category="liuxinyu/流程控制",
            is_output_node=True,
            description=(
                "条件为 true 时，用错误信息中提供的文本报错，停止当前执行；false 时继续并输出 true。"
                "可作为末端检查节点，或把继续执行输出接入下游条件分支，确保下游先等待检查。"
                "只有需要报错时才读取已连接的错误信息。不取消其他排队任务，也不撤销已产生的外部结果。"
            ),
            inputs=[
                io.Boolean.Input("condition", display_name="停止条件", default=False,
                                 tooltip="true 报错停止；false 正常继续。校验通过状态需要先接 Not 取反。"),
                io.String.Input("message", display_name="错误信息", default="条件满足，停止当前执行。",
                                multiline=True, lazy=True,
                                tooltip="需要停止时显示的错误文本；空文本使用默认错误信息。"),
            ],
            outputs=[io.Boolean.Output(display_name="继续执行")],
        )

    @classmethod
    def check_lazy_status(cls, condition, message=None):
        return ["message"] if condition and message is None else []

    @classmethod
    def execute(cls, condition, message=None):
        if condition:
            raise ValueError(message or "条件满足，停止当前执行。")
        return io.NodeOutput(True)
