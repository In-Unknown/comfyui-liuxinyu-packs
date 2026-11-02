"""Recognize explicit execution lists and their ordinary mapped outputs."""

import nodes
from comfy_execution.graph_utils import is_link


def is_execution_list(prompt, link, visited=None):
    if not is_link(link):
        return False
    visited = set() if visited is None else visited
    key = tuple(link)
    if key in visited:
        return False
    visited.add(key)
    source = prompt.get_node(link[0])
    cls = nodes.NODE_CLASS_MAPPINGS[source["class_type"]]
    flags = getattr(cls, "OUTPUT_IS_LIST", ())
    if link[1] < len(flags) and flags[link[1]]:
        return True
    # List consumers collapse the input list; ordinary nodes map over it.
    if getattr(cls, "INPUT_IS_LIST", False):
        return False
    return any(is_execution_list(prompt, value, visited) for value in source["inputs"].values())


def require_execution_list(prompt, link, label):
    if not is_execution_list(prompt, link):
        raise ValueError(
            f"{label} 只接受执行列表，不再自动拆分普通数组或接收普通单值。"
            "数组请先连接「将任意数组转为执行列表」；"
            "若要将完整数组、字典、图片批次或标量作为一包，请先连接「批量任意为执行列表」（重复次数 1）。"
        )
