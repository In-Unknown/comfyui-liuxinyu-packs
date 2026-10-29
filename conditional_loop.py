"""Feedback loops: run the body once, then repeat while its condition is true."""

import nodes
import torch
from comfy_api.latest import io
from comfy.model_management import throw_exception_if_processing_interrupted
from comfy_execution.graph_utils import GraphBuilder, is_link
from comfy_execution.validation import validate_node_input


MAX_SOCKETS = 100
MAX_ITERATIONS = 10000
HANDLE = io.Custom("LIUXINYU_RETURN_HANDLE")


def single_values(inputs):
    """Unwrap executor lists only, preserving atomic arrays and tensor batches."""
    for name, items in inputs.items():
        if len(items) != 1:
            raise ValueError(f"{name} 每轮必须只有一个值，不能是空或多项执行列表；请先分包，或合并为一个数组/批次。")
    return {name: items[0] for name, items in inputs.items()}


def data_inputs():
    return [io.AnyType.Input(f"value{i}", display_name=f"输入 {i + 1}", optional=True)
            for i in range(MAX_SOCKETS)]


def data_outputs():
    return [io.AnyType.Output(display_name=f"输出 {i + 1}")
            for i in range(MAX_SOCKETS)]


def runtime_type(value):
    if isinstance(value, torch.Tensor):
        return (torch.Tensor, value.ndim)
    return type(value)


def link_type(prompt, value):
    if not is_link(value):
        return "*"
    source = prompt.get_node(value[0])
    return nodes.NODE_CLASS_MAPPINGS[source["class_type"]].RETURN_TYPES[value[1]]


class LiuxinyuReturnPoint(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuReturnPoint", display_name="跳回点", category="liuxinyu/流程控制",
            description="初始数据进入子流；条件回归为 true 时，将本轮数据送回跳回点，再执行一轮子流；为 false 时结束本循环，输出本轮结果并执行回归节点之后的下游节点。调回句柄直接连接配对条件回归。数据口随连接增加，最多100对，数组和图片批次不会在此拆包。",
            enable_expand=True, loop_boundary="start", is_input_list=True,
            inputs=data_inputs(), outputs=[HANDLE.Output(display_name="调回句柄")] + data_outputs(),
            hidden=[io.Hidden.dynprompt, io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, **values):
        throw_exception_if_processing_interrupted()
        values = single_values(values)
        prompt = cls.hidden.dynprompt
        start_id = cls.hidden.unique_id
        start = prompt.get_node(start_id)
        if not values:
            raise ValueError("跳回点至少需要一项初始数据。")
        if "_loop_end" not in start:
            raise ValueError("请将调回句柄直接连接条件回归，并将本轮数据接回对应输入。")
        end_id = start["_loop_end"]
        end = prompt.get_node(end_id)
        if end["class_type"] != "LiuxinyuConditionalReturn" or end["inputs"].get("handle") != [start_id, 0]:
            raise ValueError("调回句柄必须直接连接对应的条件回归，不支持交叉闭合。")
        returns = {name: value for name, value in end["inputs"].items() if name.startswith("value")}
        if set(returns) != set(values):
            raise ValueError("条件回归的数据输入必须与跳回点已连接的输入一一对应，不能缺少或增加。")
        for name, value in returns.items():
            expected = link_type(prompt, start["inputs"][name])
            received = link_type(prompt, value)
            if not validate_node_input(received, expected, strict=True):
                raise ValueError(f"{name} 回归类型 {received} 与初始类型 {expected} 不一致。")
        body = {key: prompt.get_node(key) for key in start["_loop_body"]}
        for node in [*body.values(), end]:
            for value in node["inputs"].values():
                if is_link(value) and value[0] == start_id and value[1] > 0 and f"value{value[1] - 1}" not in values:
                    raise ValueError("跳回点有输出被使用，但对应初始输入未连接。")
        plan = {"start": start_id, "end": end_id, "body": body, "returns": returns,
                "repeat": end["inputs"]["repeat"],
                "types": {name: runtime_type(value) for name, value in values.items()}}
        graph = GraphBuilder()
        graph.node("LiuxinyuConditionalStep", "step", plan=plan, initial=values, repeat=True, position=0)
        scheduler = cls.hidden.execution_list
        scheduler.add_node(end_id)
        scheduler.add_external_block(end_id)
        scheduler.inhibit_nodes(body)
        prompt.override_node(end_id, {**end, "inputs": {"handle": [start_id, 0], "repeat": False}})
        return io.NodeOutput({"start": start_id}, *([None] * MAX_SOCKETS), expand=graph.finalize())


class LiuxinyuConditionalReturn(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuConditionalReturn", display_name="条件回归", category="liuxinyu/流程控制",
            description="连接调回句柄后，复制对应跳回点的数据端口和类型。true：携带本轮数据跳回配对跳回点，重新执行一轮循环，此时不执行回归之后的下游节点。false：不再跳回，结束本循环，将本轮结果从对应输出传给下游并执行下游节点，不是停止整个工作流。布尔输入每轮必须只有一个值；需等待的分支应接入本节点。",
            is_output_node=True, loop_boundary="end",
            inputs=[HANDLE.Input("handle", display_name="调回句柄"),
                    io.Boolean.Input("repeat", display_name="跳回循环（true）/ 进入下游（false）", default=False, force_input=True,
                                     tooltip="true：携带本轮数据跳回，再执行一轮循环；false：结束本循环，输出本轮结果并执行下游节点，不停止整个工作流。") ] + data_inputs(),
            outputs=data_outputs(), hidden=[io.Hidden.execution_list, io.Hidden.unique_id],
        )

    @classmethod
    def execute(cls, handle, repeat, **kwargs):
        result = cls.hidden.execution_list.get_external_block_result(cls.hidden.unique_id)
        if result is None:
            raise ValueError("尚未收到循环结果，请检查调回句柄和数据回归连线。")
        return io.NodeOutput(*(result.get(f"value{i}") for i in range(MAX_SOCKETS)))


class LiuxinyuReturnSource(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuReturnSource", is_dev_only=True,
                         inputs=[io.AnyType.Input("state")],
                         outputs=[HANDLE.Output()] + data_outputs())

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, state):
        return io.NodeOutput({}, *(state.get(f"value{i}") for i in range(MAX_SOCKETS)))


class LiuxinyuConditionalStep(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="LiuxinyuConditionalStep", is_dev_only=True,
                         is_output_node=True, enable_expand=True, is_input_list=True,
                         inputs=[io.AnyType.Input("plan"), io.Boolean.Input("repeat"), io.Int.Input("position"),
                                 io.AnyType.Input("initial", optional=True)] + data_inputs(),
                         outputs=[io.AnyType.Output()], hidden=[io.Hidden.execution_list])

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        return float("nan")

    @classmethod
    def execute(cls, plan, repeat, position, initial=None, **values):
        throw_exception_if_processing_interrupted()
        control = single_values({"plan": plan, "repeat": repeat, "position": position})
        plan, repeat, position = control["plan"], control["repeat"], control["position"]
        if type(repeat) is not bool:
            raise ValueError("条件回归每轮必须收到一个布尔值。")
        state = single_values({"initial": initial})["initial"] if initial is not None else single_values(values)
        if set(state) != set(plan["types"]):
            raise ValueError("回归的数据端口与跳回点不一致。")
        for name, items in state.items():
            expected = plan["types"][name]
            if expected and runtime_type(items) != expected:
                raise ValueError(f"{name} 的回归数据类型与初始数据不一致，请先转换类型。")
        if not repeat:
            cls.hidden.execution_list.release_external_block(plan["end"], state)
            return io.NodeOutput(state)
        if position >= MAX_ITERATIONS:
            raise RuntimeError(f"条件回归已执行 {MAX_ITERATIONS} 轮但仍要求跳回循环；请检查布尔条件和回归数据。")
        graph = GraphBuilder()
        source = graph.node("LiuxinyuReturnSource", "source", state=state)
        source.set_override_display_id(plan["start"])
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
            copy.inputs.update({name: copied_link(value) for name, value in plan["body"][key]["inputs"].items()})
        step = graph.node("LiuxinyuConditionalStep", "next", plan=plan, position=position + 1,
                          repeat=copied_link(plan["repeat"]),
                          **{name: copied_link(value) for name, value in plan["returns"].items()})
        step.set_override_display_id(plan["end"])
        expanded = graph.finalize()
        for key, copy in copies.items():
            original = plan["body"][key]
            if "_loop_end" in original:
                expanded[copy.id]["_loop_body"] = [copies[item].id for item in original["_loop_body"]]
                expanded[copy.id]["_loop_end"] = copies[original["_loop_end"]].id
        return io.NodeOutput(step.out(0), expand=expanded)
