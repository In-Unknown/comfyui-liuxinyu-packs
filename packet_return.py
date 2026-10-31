"""Packet iteration with explicit carried state and Boolean continuation."""

import nodes
import torch
from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted
from comfy_execution.graph_utils import GraphBuilder, is_link
from comfy_execution.validation import validate_node_input


LIMIT = io.Autogrow._MaxNames
HANDLE = io.Custom("LIUXINYU_PACKET_RETURN")
OPERATORS = ["与", "或", "与非", "或非", "异或", "同或"]


def combine(has_next, condition, operation):
    if type(has_next) is not bool or type(condition) is not bool:
        raise ValueError("回归条件必须是一个布尔值。")
    if operation == "与": return has_next and condition
    if operation == "或": return has_next or condition
    if operation == "与非": return not (has_next and condition)
    if operation == "或非": return not (has_next or condition)
    if operation == "异或": return has_next != condition
    if operation == "同或": return has_next == condition
    raise ValueError(f"未知逻辑运算：{operation!r}。")


def single_values(values):
    for name, items in values.items():
        if len(items) != 1:
            raise ValueError(f"{name} 必须是一个完整值，不能是空或多项执行列表；请先收集为数组。")
    return {name: items[0] for name, items in values.items()}


def value_type(value):
    return (torch.Tensor, value.ndim) if isinstance(value, torch.Tensor) else type(value)


def growing(group, prefix, label, minimum=1):
    return io.Autogrow.Input(group, template=io.Autogrow.TemplatePrefix(
        io.AnyType.Input("value", display_name=label), prefix=prefix, min=minimum, max=LIMIT))


def start_outputs():
    # Runtime outputs are compact: handle, connected states, connected packets, round.
    # Every slot after the handle can change type/position as the inputs change.
    return ([HANDLE.Output(display_name="分包回归条件")]
            + [io.AnyType.Output(display_name=f"当前被处理数据{i + 1}") for i in range(LIMIT)]
            + [io.AnyType.Output(display_name=f"当前分包数据{i + 1}") for i in range(LIMIT)]
            + [io.AnyType.Output(display_name="当前轮次数")])


def ordered_names(values, prefix):
    return sorted(values, key=lambda name: int(name.removeprefix(prefix)))


def start_values(handle, states, packets, round_number):
    return (handle, *(states[name] for name in ordered_names(states, "state")),
            *(packets[name] for name in ordered_names(packets, "packet")), round_number)


def end_outputs():
    return [io.AnyType.Output(display_name=f"处理完成数据{i + 1}") for i in range(LIMIT)]


class LiuxinyuPacketReturnStart(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPacketReturnStart", display_name="分包跳回", category="liuxinyu/流程控制",
            description="逐包执行，同时传递上一轮处理后的完整数据。分包数据按项取出，被处理数据不拆包。"
                        "分包回归条件直接连接携包条件回归。空包跳过循环并输出初始数据；耗尽后仍回归则复用最后一包。",
            inputs=[growing("states", "state", "被处理数据"), growing("packets", "packet", "分包数据")],
            outputs=start_outputs(), is_input_list=True, enable_expand=True, loop_boundary="start",
            hidden=[io.Hidden.dynprompt, io.Hidden.execution_list, io.Hidden.unique_id])

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, packets, states):
        throw_exception_if_processing_interrupted()
        state = single_values(states)
        if not packets or not state:
            raise ValueError("至少连接一项被处理数据和一项分包数据。")
        prompt, start_id = cls.hidden.dynprompt, cls.hidden.unique_id
        start = prompt.get_node(start_id)
        columns = {}
        for name, items in packets.items():
            upstream_link = start["inputs"].get(f"packets.{name}")
            execution_list = False
            if is_link(upstream_link):
                upstream = nodes.NODE_CLASS_MAPPINGS[prompt.get_node(upstream_link[0])["class_type"]]
                flags = getattr(upstream, "OUTPUT_IS_LIST", ())
                execution_list = upstream_link[1] < len(flags) and flags[upstream_link[1]]
            if not execution_list and len(items) == 1 and isinstance(items[0], (list, tuple)):
                items = items[0]
            columns[name] = items
        count = max(map(len, columns.values()))
        if count and any(not column for column in columns.values()):
            raise ValueError("分包数据混有空列，无法复用其最后一项；请补充或断开空列。")
        if "_loop_end" not in start:
            raise ValueError("请将分包回归条件直接连接对应的携包条件回归。")
        end_id = start["_loop_end"]
        end = prompt.get_node(end_id)
        if end["class_type"] != "LiuxinyuPacketReturnEnd" or end["inputs"].get("handle") != [start_id, 0]:
            raise ValueError("分包跳回必须与携包条件回归直接配对，不能交叉闭合。")
        returns = {name.removeprefix("states."): value for name, value in end["inputs"].items()
                   if name.startswith("states.")}
        if set(returns) != set(state):
            raise ValueError("处理完成数据必须与分包跳回的被处理数据逐项对应，不能缺少或增加。")
        for name, value in returns.items():
            initial = start["inputs"][f"states.{name}"]
            if is_link(initial) and is_link(value):
                expected = nodes.NODE_CLASS_MAPPINGS[prompt.get_node(initial[0])["class_type"]].RETURN_TYPES[initial[1]]
                actual = nodes.NODE_CLASS_MAPPINGS[prompt.get_node(value[0])["class_type"]].RETURN_TYPES[value[1]]
                if not validate_node_input(actual, expected, strict=True):
                    raise ValueError(f"{name} 回归类型 {actual} 与初始类型 {expected} 不一致。")
        body = {key: prompt.get_node(key) for key in start["_loop_body"]}
        for node in [*body.values(), end]:
            for value in node["inputs"].values():
                if is_link(value) and value[0] == start_id and not 0 <= value[1] < len(state) + len(columns) + 2:
                    raise ValueError("分包跳回输出数量与已连接的被处理数据、分包数据不一致。")
        operation = end["inputs"].get("operation", "与")
        if operation not in OPERATORS:
            raise ValueError("逻辑运算必须在携包条件回归节点中选择。")
        plan = {"start": start_id, "end": end_id, "body": body, "returns": returns,
                "condition": end["inputs"].get("condition", True), "operation": operation,
                "columns": columns, "count": count,
                "types": {name: value_type(value) for name, value in state.items()}}
        graph = GraphBuilder()
        graph.node("LiuxinyuPacketReturnStep", "step", plan=plan, position=0, condition=True, initial=state)
        scheduler = cls.hidden.execution_list
        scheduler.add_node(end_id)
        scheduler.add_external_block(end_id)
        scheduler.inhibit_nodes(body)
        prompt.override_node(end_id, {**end, "inputs": {"handle": [start_id, 0], "condition": True, "operation": operation}})
        return io.NodeOutput(*start_values({"start": start_id}, dict.fromkeys(state), dict.fromkeys(columns), 0),
                             expand=graph.finalize())


class LiuxinyuPacketReturnEnd(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuPacketReturnEnd", display_name="携包条件回归", category="liuxinyu/流程控制",
            description="连接分包回归条件后，按被处理数据的数量生成处理完成数据输入与输出。"
                        "将内部的‘还有下一包’与输入布尔做选定运算。true 回归新数据；false 输出处理完成数据。"
                        "耗尽后仍继续时复用最后一包；默认‘与’和 true 遍历全部包。",
            inputs=[HANDLE.Input("handle", display_name="分包回归条件"),
                    io.Boolean.Input("condition", display_name="输入布尔", default=True),
                    io.Combo.Input("operation", display_name="逻辑运算", options=OPERATORS, default="与", socketless=True),
                    growing("states", "state", "处理完成数据", minimum=0)],
            outputs=end_outputs(), loop_boundary="end", is_output_node=True,
            hidden=[io.Hidden.execution_list, io.Hidden.unique_id])

    @classmethod
    def execute(cls, handle, condition=True, operation="与", states=None):
        result = cls.hidden.execution_list.get_external_block_result(cls.hidden.unique_id)
        if result is None:
            raise ValueError("尚未收到携包循环结果，请检查配对和回归数据连线。")
        return io.NodeOutput(*(result[name] for name in ordered_names(result, "state")))


class LiuxinyuPacketReturnSource(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuPacketReturnSource", is_dev_only=True,
                         inputs=[io.AnyType.Input("payload")], outputs=start_outputs())

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, payload):
        return io.NodeOutput(*start_values({}, payload["state"], payload["packets"], payload["round"]))


class LiuxinyuPacketReturnStep(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuPacketReturnStep", is_dev_only=True, is_output_node=True,
                         is_input_list=True, enable_expand=True,
                         inputs=[io.AnyType.Input("plan"), io.Int.Input("position"), io.Boolean.Input("condition"),
                                 io.AnyType.Input("initial", optional=True), growing("states", "state", "数据", 0)],
                         outputs=[io.AnyType.Output()], hidden=[io.Hidden.execution_list])

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, plan, position, condition, states, initial=None):
        throw_exception_if_processing_interrupted()
        control = single_values({"plan": plan, "position": position, "condition": condition})
        plan, position, condition = control["plan"], control["position"], control["condition"]
        state = single_values({"initial": initial})["initial"] if initial is not None else single_values(states)
        if set(state) != set(plan["types"]):
            raise ValueError("处理完成数据端口与被处理数据不一致。")
        for name, value in state.items():
            if value_type(value) != plan["types"][name]:
                raise ValueError(f"{name} 回归数据类型与初始数据不一致，请先转换类型。")
        if not plan["count"] or (position > 0 and not combine(position < plan["count"], condition, plan["operation"])):
            cls.hidden.execution_list.release_external_block(plan["end"], state)
            return io.NodeOutput(state)
        graph = GraphBuilder()
        packets = {name: column[min(position, len(column) - 1)] for name, column in plan["columns"].items()}
        source = graph.node("LiuxinyuPacketReturnSource", "source", payload={
            "packets": packets, "state": state, "round": position + 1})
        source.set_override_display_id(plan["start"])
        copies = {key: graph.node(node["class_type"], f"body_{key}") for key, node in plan["body"].items()}

        def copied_link(value):
            if is_link(value):
                if value[0] == plan["start"]: return source.out(value[1])
                if value[0] in copies: return copies[value[0]].out(value[1])
            return value

        for key, copy in copies.items():
            copy.set_override_display_id(key)
            copy.inputs.update({name: copied_link(value) for name, value in plan["body"][key]["inputs"].items()})
        step = graph.node("LiuxinyuPacketReturnStep", "next", plan=plan, position=position + 1,
                          condition=copied_link(plan["condition"]),
                          **{f"states.{name}": copied_link(value) for name, value in plan["returns"].items()})
        step.set_override_display_id(plan["end"])
        expanded = graph.finalize()
        for key, copy in copies.items():
            original = plan["body"][key]
            if "_loop_end" in original:
                expanded[copy.id]["_loop_body"] = [copies[item].id for item in original["_loop_body"]]
                expanded[copy.id]["_loop_end"] = copies[original["_loop_end"]].id
        return io.NodeOutput(step.out(0), expand=expanded)
