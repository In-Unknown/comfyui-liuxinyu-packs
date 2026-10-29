"""Task-local controls for the executor's periodic RAM checks and reclaim."""

from comfy_api.latest import io


def control_schema(node_id, display_name, description):
    return io.Schema(
        node_id=node_id, display_name=display_name, category="liuxinyu/流程控制",
        description=description + " 等待全部已连接输入后切换，数据按编号原样输出，端口随连接增加，无固定数量上限。至少连接一项输入。仅影响当前任务调度步骤后的 RAM 检查和回收，不改变模型加载、显存管理或分配失败处理。",
        inputs=[io.AnyType.Input("value0", display_name="输入 1", optional=True)],
        outputs=[io.AnyType.Output(display_name="输出 1", is_output_list=True)],
        dynamic_io_prefix="value", accept_all_inputs=True, is_input_list=True, is_output_node=True,
        hidden=[io.Hidden.execution_list],
    )


def validate_values(values):
    if not values:
        return "至少连接一项输入，以确定切换内存检查和回收的执行顺序。"
    for name in values:
        suffix = name.removeprefix("value")
        if not name.startswith("value") or not suffix.isascii() or not suffix.isdigit() or str(int(suffix)) != suffix:
            return f"无效的数据端口：{name}。"
    return True


def switch_checks(cls, enabled, values):
    valid = validate_values(values)
    if valid is not True:
        raise ValueError(valid)
    cls.hidden.execution_list.set_ram_checks_enabled(enabled)
    count = max(int(name[5:]) for name in values) + 1
    return io.NodeOutput(*(values.get(f"value{i}", []) for i in range(count)))


class LiuxinyuIgnoreMemoryChecks(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return control_schema("LiuxinyuIgnoreMemoryChecks", "当前忽略内存检查和回收",
                              "从本节点执行后，暂停当前工作流本次运行任务的 RAM 检查和回收；作用于该任务后续所有分支、循环和子图。任务结束、报错或取消后不延续到下一任务。")

    @classmethod
    def fingerprint_inputs(cls, **values):
        return float("nan")

    @classmethod
    def validate_inputs(cls, input_types, **values):
        return validate_values(values)

    @classmethod
    def execute(cls, **values):
        return switch_checks(cls, False, values)


class LiuxinyuRestoreMemoryChecks(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return control_schema("LiuxinyuRestoreMemoryChecks", "恢复内存检查和回收",
                              "从本节点执行后，恢复当前运行任务正常的 RAM 检查和回收。需要等待的分支都应接入本节点；不需要与忽略节点逐口配对。")

    @classmethod
    def fingerprint_inputs(cls, **values):
        return float("nan")

    @classmethod
    def validate_inputs(cls, input_types, **values):
        return validate_values(values)

    @classmethod
    def execute(cls, **values):
        return switch_checks(cls, True, values)
