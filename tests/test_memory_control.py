"""Run the controls through validation, caching, and the real graph executor."""

import asyncio
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK.parents[1]), str(PACK)]

import execution
import nodes
import torch
from comfy_api.latest import io
from comfy_execution.caching import RAMPressureCache
from comfy_execution.graph_utils import ExecutionBlocker
from comfy.model_management import InterruptProcessingException
from memory_control import LiuxinyuIgnoreMemoryChecks, LiuxinyuRestoreMemoryChecks

EVENTS = []
CAPTURED = []


class MemoryTestValue(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id=cls.__name__, inputs=[io.AnyType.Input("payload")],
                         outputs=[io.AnyType.Output(is_output_list=True)])

    @classmethod
    def execute(cls, payload):
        EVENTS.append(payload.get("tag"))
        if payload.get("fail"):
            raise RuntimeError("intentional failure")
        if payload.get("interrupt"):
            raise InterruptProcessingException()
        return io.NodeOutput(payload["items"])


class MemoryTestCapture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id=cls.__name__, is_input_list=True, is_output_node=True,
                         inputs=[io.AnyType.Input("value")], outputs=[])

    @classmethod
    def execute(cls, value):
        CAPTURED.append(value)
        return io.NodeOutput()


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def chain(restore=True):
    prompt = {
        "source": node("MemoryTestValue", payload={"items": [7]}),
        "ignore": node("LiuxinyuIgnoreMemoryChecks", value0=["source", 0]),
        "capture": node("MemoryTestCapture", value=["ignore", 0]),
    }
    if restore:
        prompt["restore"] = node("LiuxinyuRestoreMemoryChecks", value0=["ignore", 0])
        prompt["capture"]["inputs"]["value"] = ["restore", 0]
    return prompt


class MemoryControlTests(unittest.TestCase):
    def setUp(self):
        EVENTS.clear()
        CAPTURED.clear()
        self.current = None
        self.reclaims = []
        self.queries = []
        self.switches = []
        classes = [MemoryTestValue, MemoryTestCapture, LiuxinyuIgnoreMemoryChecks, LiuxinyuRestoreMemoryChecks]
        self.enterContext(patch.dict(nodes.NODE_CLASS_MAPPINGS, {c.define_schema().node_id: c for c in classes}))
        real_execute = execution.execute

        async def traced_execute(*args, **kwargs):
            self.current = args[3]
            return await real_execute(*args, **kwargs)

        self.enterContext(patch.object(execution, "execute", traced_execute))
        self.enterContext(patch.object(RAMPressureCache, "ram_release", lambda *a, **kw: self.record_reclaim()))
        self.enterContext(patch.object(execution.comfy.system_memory, "virtual_memory_available", self.record_query))
        real_switch = execution.ExecutionList.set_ram_checks_enabled

        def switch(scheduler, enabled):
            self.switches.append(enabled)
            return real_switch(scheduler, enabled)

        self.enterContext(patch.object(execution.ExecutionList, "set_ram_checks_enabled", switch))
        self.executor = execution.PromptExecutor(
            SimpleNamespace(client_id=None, send_sync=lambda *a: None), execution.CacheType.RAM_PRESSURE,
            {"ram": 1, "ram_inactive": 1, "lru": 0})

    def record_reclaim(self):
        self.reclaims.append(self.current)
        return 0

    def record_query(self):
        self.queries.append(self.current)
        return 8 * 1024 ** 3

    def run_graph(self, prompt, success=True):
        valid, error, outputs, _ = asyncio.run(execution.validate_prompt("memory-test", prompt, None))
        self.assertTrue(valid, error)
        self.executor.execute(prompt, "memory-test", execute_outputs=outputs)
        self.assertEqual(self.executor.success, success, self.executor.status_messages)

    def test_switches_and_restore_terminal(self):
        prompt = chain()
        del prompt["capture"]
        self.run_graph(prompt)
        self.assertEqual(self.switches, [False, True])
        self.assertEqual(self.reclaims, ["source", "restore"])
        self.assertEqual(self.queries, ["source", "restore"])

    def test_missing_restore_and_same_executor_next_task(self):
        self.run_graph(chain(False))
        self.assertEqual(self.reclaims, ["source"])
        self.reclaims.clear()
        self.run_graph({"next": node("MemoryTestCapture", value=9)})
        self.assertEqual(self.reclaims, ["next"])

    def test_cached_inputs_still_execute_both_switches(self):
        self.run_graph(chain())
        self.run_graph(chain())
        self.assertEqual(self.switches, [False, True, False, True])
        self.assertEqual(CAPTURED, [[7], [7]])

    def test_failure_and_interruption_do_not_leak(self):
        for failure in ("fail", "interrupt"):
            prompt = chain(False)
            prompt["bad"] = node("MemoryTestValue", payload={"items": [], failure: True})
            # Force the failing node to wait for Ignore without changing its payload.
            prompt["bad"]["inputs"]["payload"] = ["ignore", 0]
            prompt["source"]["inputs"]["payload"]["items"] = [{"items": [], failure: True}]
            prompt["capture"]["inputs"]["value"] = ["bad", 0]
            self.run_graph(prompt, False)
            self.reclaims.clear()
            self.run_graph({"after": node("MemoryTestCapture", value=failure)})
            self.assertIn("after", self.reclaims)

    def test_over_100_ports_and_all_dependencies_are_validated(self):
        prompt = chain()
        for index in range(150):
            key = f"s{index}"
            prompt[key] = node("MemoryTestValue", payload={"items": [index]})
            prompt["ignore"]["inputs"][f"value{index}"] = [key, 0]
            prompt["restore"]["inputs"][f"value{index}"] = ["ignore", index]
        prompt["capture"]["inputs"]["value"] = ["restore", 149]
        self.run_graph(prompt)
        self.assertEqual(CAPTURED[-1], [149])
        self.assertEqual(self.switches, [False, True])
        broken = deepcopy(prompt)
        broken["s149"]["inputs"] = {}
        self.assertFalse(asyncio.run(execution.validate_prompt("bad", broken, None))[0])

    def test_sparse_ports_arrays_lists_and_tensor_identity(self):
        image = torch.zeros(2, 3, 4, 3)
        for items in ([], [1, 2, 3], [[1, 2]], [{"a": [1]}], [image], [None]):
            prompt = {
                "source": node("MemoryTestValue", payload={"items": items}),
                "ignore": node("LiuxinyuIgnoreMemoryChecks", value125=["source", 0]),
                "restore": node("LiuxinyuRestoreMemoryChecks", value210=["ignore", 125]),
                "capture": node("MemoryTestCapture", value=["restore", 210]),
            }
            self.run_graph(prompt)
            self.assertEqual(len(CAPTURED[-1]), len(items))
            self.assertTrue(all(a is b for a, b in zip(items, CAPTURED[-1])))

    def test_blocked_input_does_not_switch_and_blocks_high_output(self):
        prompt = {
            "source": node("MemoryTestValue", payload={"items": [ExecutionBlocker(None)]}),
            "ignore": node("LiuxinyuIgnoreMemoryChecks", value123=["source", 0]),
            "capture": node("MemoryTestCapture", value=["ignore", 123]),
        }
        self.run_graph(prompt)
        self.assertEqual(self.switches, [])
        self.assertEqual(CAPTURED, [])

    def test_empty_or_unmatched_ports_rejected(self):
        for inputs in ({}, {"wrong": 3}, {"value01": 3}):
            prompt = {"ignore": node("LiuxinyuIgnoreMemoryChecks", **inputs)}
            self.assertFalse(asyncio.run(execution.validate_prompt("bad", prompt, None))[0])
        prompt = chain()
        prompt["capture"]["inputs"]["value"] = ["restore", 100]
        result = asyncio.run(execution.validate_prompt("bad", prompt, None))
        self.assertNotIn("capture", result[2])


if __name__ == "__main__":
    unittest.main()
