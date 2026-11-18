"""Assemble same-typed values into one array without converting its items."""

import re

import nodes
from comfy_api.latest import io
from comfy_execution.graph_utils import is_link


class LiuxinyuAnyArray(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="LiuxinyuAnyArray", display_name="组装任意为数组",
            category="utils/conversion",
            search_aliases=["任意数组", "组装任意数组", "多个任意值组成数组", "any array"],
            description=(
                "按输入编号顺序把同类型的值组成一个完整数组，连接末尾输入后自动增加输入口，无固定数量上限。"
                "首次连接确定成员类型，其他输入同步限制为该类型；全部断开后恢复任意类型。整数、浮点数和布尔值互不混用。"
                "保留每项类型、嵌套数组和图片批次，不展开、不序列化、不进行数值类型转换。"
                "未连接的输入不占位置，空值也按独立类型校验，没有输入时输出空数组。"
                "输入执行列表时按 ComfyUI 规则逐项执行；整批收集请用执行列表收集为数组。"
            ),
            inputs=[io.AnyType.Input("value0", display_name="任意值 1", optional=True,
                                     tooltip="成员可选任意类型，但所有已连接输入必须同类型；数组或图片批次作为一项保留。")],
            outputs=[io.Array.Output(display_name="完整数组")],
            hidden=[io.Hidden.dynprompt, io.Hidden.unique_id],
            accept_all_inputs=True,
        )

    @classmethod
    def _validate_member_types(cls, input_types):
        allowed = None
        for name, source_type in input_types.items():
            if not re.fullmatch(r"value[0-9]+", name):
                return f"未知任意值输入口：{name}"
            types = {part.strip() for part in str(source_type).split(",")}
            if "*" in types:
                continue
            allowed = types if allowed is None else allowed & types
            if not allowed:
                return f"所有数组成员必须同类型；{name} 的来源类型 {source_type} 与其他输入不兼容。"
        return True

    @classmethod
    def execute(cls, **values):
        for name in values:
            if not re.fullmatch(r"value[0-9]+", name):
                raise ValueError(f"未知任意值输入口：{name}")
        # accept_all_inputs forwards arbitrary sockets, but ComfyUI's ordinary
        # input_types validation only visits statically declared sockets.
        # Check declared source types too: IMAGE and MASK both use tensors.
        if cls.hidden and cls.hidden.dynprompt:
            graph = cls.hidden.dynprompt
            inputs = graph.get_node(cls.hidden.unique_id)["inputs"]
            types = {}
            for name, link in inputs.items():
                if name not in values or not is_link(link):
                    continue
                source = graph.get_node(link[0])
                types[name] = nodes.NODE_CLASS_MAPPINGS[source["class_type"]].RETURN_TYPES[link[1]]
            valid = cls._validate_member_types(types)
            if valid is not True:
                raise ValueError(valid)
        ordered = sorted(values.items(), key=lambda item: int(item[0][5:]))
        if ordered:
            first_name, first_value = ordered[0]
            for name, value in ordered[1:]:
                if type(value) is not type(first_value):
                    raise ValueError(
                        f"数组成员必须同类型：{name} 为 {type(value).__name__}，"
                        f"{first_name} 为 {type(first_value).__name__}；不会自动转换。"
                    )
        return io.NodeOutput([value for _, value in ordered])
