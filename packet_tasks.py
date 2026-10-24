"""Paired packet loops using ComfyUI's native loop boundaries and scheduler."""

import nodes
from comfy_api.latest import io
from comfy_execution.graph_utils import GraphBuilder, is_link


MAX_SOCKETS = 100
CONDITION = io.Custom("LIUXINYU_PACKET_CONDITION")


def packet_columns(inputs, execution_lists=()):
    columns = {}
    for name, values in inputs.items():
        if name.startswith("value") and name[5:].isdigit():
            index = int(name[5:])
            if index >= MAX_SOCKETS:
                raise ValueError(f"最多支持 {MAX_SOCKETS} 对输入输出。")
            # An atomic ARRAY arrives wrapped in one extra executor list.
            if name not in execution_lists and len(values) == 1 and isinstance(values[0], (list, tuple)):
                values = values[0]
            columns[index] = values
    if not columns:
        raise ValueError("请至少连接一个待分包的输入。")
    count = max(map(len, columns.values()))
    if count and any(not column for column in columns.values()):
        raise ValueError("有输入是空数组，无法复用其最后一个值；请补充该输入或断开连接。")
    return columns, count


def value_outputs(is_list=False):
    return [io.AnyType.Output(display_name=f"输出 {index + 1}", is_output_list=is_list)
            for index in range(MAX_SOCKETS)]


def value_inputs():
    # The frontend exposes these existing valueN sockets as pairs are connected.
    # All must be declared so partial-execution validation visits every branch.
    return [io.AnyType.Input(f"value{index}", display_name=f"输入 {index + 1}", optional=True)
            for index in range(MAX_SOCKETS)]


class LiuxinyuPacketStart(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPacketStart", display_name="分包执行子流回归", category="liuxinyu/流程控制",
            description="按最长数组逐包执行子流，等待本包回归后再发下一包。短数组重复最后一项，单值重复使用。当前轮次输出从 1 开始的整数，嵌套时各自计数。将分包回归条件连接到回归分包子流条件节点。",
            is_input_list=True, accept_all_inputs=True, enable_expand=True, loop_boundary="start",
            inputs=value_inputs(),
            outputs=[CONDITION.Output(display_name="分包回归条件")] + value_outputs() + [io.Int.Output(display_name="当前轮次")],
            hidden=[io.Hidden.dynprompt, io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, **kwargs):
        dynprompt = cls.hidden.dynprompt
        unique_id = cls.hidden.unique_id
        opener = dynprompt.get_node(unique_id)
        execution_lists = set()
        for name, value in opener["inputs"].items():
            if name.startswith("value") and is_link(value):
                upstream = nodes.NODE_CLASS_MAPPINGS[dynprompt.get_node(value[0])["class_type"]]
                flags = getattr(upstream, "OUTPUT_IS_LIST", ())
                if value[1] < len(flags) and flags[value[1]]:
                    execution_lists.add(name)
        columns, count = packet_columns(kwargs, execution_lists)
        if "_loop_end" not in opener:
            raise ValueError("请将分包回归条件连接到「回归分包子流条件」，并把本包处理结果接入该回归节点。")
        close_id = opener["_loop_end"]
        close = dynprompt.get_node(close_id)
        if close["class_type"] != "LiuxinyuPacketEnd" or close["inputs"].get("condition") != [unique_id, 0]:
            raise ValueError("回归节点的分包回归条件必须直接连接对应的「分包执行子流回归」。")
        body = {key: dynprompt.get_node(key) for key in opener["_loop_body"]}
        used = {value[1] - 1 for node in [*body.values(), close] for value in node.get("inputs", {}).values()
                if is_link(value) and value[0] == unique_id and 0 < value[1] <= MAX_SOCKETS}
        if used - columns.keys():
            raise ValueError("有输出已连接，但对应输入尚未连接；请补齐同一编号的输入。")
        plan = {"start": unique_id, "end": close_id, "body": body,
                "returns": {key: value for key, value in close["inputs"].items() if key.startswith("value")},
                "columns": columns, "count": count}
        graph = GraphBuilder()
        graph.node("LiuxinyuPacketStep", "step", plan=plan, position=0, previous={})

        scheduler = cls.hidden.execution_list
        scheduler.add_node(close_id)
        scheduler.add_external_block(close_id)
        scheduler.inhibit_nodes(body)
        dynprompt.override_node(close_id, {**close, "inputs": {"condition": [unique_id, 0]}})
        return io.NodeOutput({"start": unique_id}, *([None] * MAX_SOCKETS), 0, expand=graph.finalize())


class LiuxinyuPacketEnd(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPacketEnd", display_name="回归分包子流条件", category="liuxinyu/流程控制",
            description="等待本包所有已连接输入完成，再处理下一包。所有包完成后，各输出按包顺序汇总，保留数组值。",
            loop_boundary="end", is_input_list=True, accept_all_inputs=True, is_output_node=True,
            inputs=[CONDITION.Input("condition", display_name="分包回归条件")] + value_inputs(),
            outputs=value_outputs(is_list=True),
            hidden=[io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, condition, **kwargs):
        results = cls.hidden.execution_list.get_external_block_result(cls.hidden.unique_id)
        if results is None:
            raise ValueError("尚未收到分包执行结果，请检查分包回归条件连线。")
        return io.NodeOutput(*(results.get(f"value{index}", []) for index in range(MAX_SOCKETS)))


class LiuxinyuPacketSource(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuPacketSource", is_dev_only=True,
                         inputs=[io.AnyType.Input("values"), io.Int.Input("round_number")],
                         outputs=[CONDITION.Output()] + value_outputs() + [io.Int.Output(display_name="当前轮次")])

    @classmethod
    def execute(cls, values, round_number):
        return io.NodeOutput({}, *(values.get(index) for index in range(MAX_SOCKETS)), round_number)

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")


class LiuxinyuPacketStep(io.ComfyNode):
    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # Releasing the matching End is an execution-scoped scheduling action.
        return float("nan")

    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuPacketStep", is_dev_only=True, enable_expand=True,
                         is_output_node=True,
                         inputs=[io.AnyType.Input("plan"), io.Int.Input("position"), io.AnyType.Input("previous")],
                         outputs=[io.AnyType.Output()], hidden=[io.Hidden.execution_list])

    @classmethod
    def execute(cls, plan, position, previous):
        if position == plan["count"]:
            cls.hidden.execution_list.release_external_block(plan["end"], previous)
            return io.NodeOutput(previous)
        graph = GraphBuilder()
        values = {index: column[min(position, len(column) - 1)] for index, column in plan["columns"].items()}
        source = graph.node("LiuxinyuPacketSource", "source", values=values, round_number=position + 1)
        copies = {key: graph.node(node["class_type"], f"body_{key}") for key, node in plan["body"].items()}

        def copied_link(value):
            if is_link(value):
                if value[0] == plan["start"]:
                    return source.out(value[1])
                if value[0] in copies:
                    return copies[value[0]].out(value[1])
            return value

        for key, copy in copies.items():
            copy.set_override_display_id(key)
            copy.inputs.update({name: copied_link(value) for name, value in plan["body"][key].get("inputs", {}).items()})
        collect = graph.node("LiuxinyuPacketCollect", "collect", previous=previous,
                             condition=source.out(0),
                             **{name: copied_link(value) for name, value in plan["returns"].items()})
        next_step = graph.node("LiuxinyuPacketStep", "next", plan=plan, position=position + 1,
                               previous=collect.out(0))
        expanded = graph.finalize()
        # Preserve native loop metadata when a packet contains another paired loop.
        for key, copy in copies.items():
            original = plan["body"][key]
            if "_loop_end" in original:
                expanded[copy.id]["_loop_body"] = [copies[item].id for item in original["_loop_body"]]
                expanded[copy.id]["_loop_end"] = copies[original["_loop_end"]].id
        return io.NodeOutput(next_step.out(0), expand=expanded)


class LiuxinyuPacketCollect(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuPacketCollect", is_dev_only=True,
                         is_input_list=True, accept_all_inputs=True,
                         inputs=[io.AnyType.Input("previous"), CONDITION.Input("condition")],
                         outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, previous, condition, **kwargs):
        results = {name: list(values) for name, values in previous[0].items()}
        for name, values in kwargs.items():
            if name.startswith("value") and name[5:].isdigit():
                results.setdefault(name, []).extend(values)
        return io.NodeOutput(results)
