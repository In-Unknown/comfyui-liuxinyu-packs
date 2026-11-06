"""Run frontend-compiled virtual connections through the real executor."""

import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK.parents[1]), str(PACK)]

import execution
import nodes
import packet_tasks
import torch
from comfy_api.latest import io
from execution_list_node import LiuxinyuArrayToExecutionList
from virtual_connections import LiuxinyuVirtualInput, LiuxinyuVirtualOutput


EVENTS = []
CAPTURED = []


class VirtualTestSource(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id=cls.__name__, inputs=[io.AnyType.Input("payload")],
                         outputs=[io.AnyType.Output(is_output_list=True)])

    @classmethod
    def execute(cls, payload):
        EVENTS.append(payload.get("tag"))
        return io.NodeOutput(payload["items"])


class VirtualTestCapture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id=cls.__name__, is_input_list=True, is_output_node=True,
                         inputs=[io.AnyType.Input("a"), io.AnyType.Input("b", optional=True)], outputs=[])

    @classmethod
    def execute(cls, **values):
        EVENTS.append("capture")
        CAPTURED.append(values)
        return io.NodeOutput()


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


class VirtualTestIdentity(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id=cls.__name__, inputs=[io.AnyType.Input("value")], outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(value)


def compile_prompt(prompt):
    javascript = """
const fs = require('node:fs'), vm = require('node:vm');
const context = {app: {registerExtension() {}}, queueMicrotask};
vm.createContext(context);
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8').replace(/^import .*;/gm, '') +
  '\\nglobalThis.compile = compileConnections;', context);
process.stdout.write(JSON.stringify(context.compile(JSON.parse(fs.readFileSync(0, 'utf8')))));
"""
    result = subprocess.run([shutil.which('node'), '-e', javascript, str(PACK / 'virtual_connections.js')],
                            input=json.dumps(prompt), text=True, encoding='utf-8', capture_output=True, check=True)
    return json.loads(result.stdout)


def graph():
    return {
        'source': node('VirtualTestSource', payload={'items': [10, 20, 30], 'tag': 'source'}),
        'other': node('VirtualTestSource', payload={'items': ['one'], 'tag': 'other'}),
        '12:send': node('LiuxinyuVirtualOutput', key='数据', value0=['source', 0], value1=['other', 0]),
        '30:receive': node('LiuxinyuVirtualInput', key='数据'),
        'out': node('VirtualTestCapture', a=['30:receive', 0], b=['30:receive', 1]),
    }


class VirtualConnectionsTests(unittest.TestCase):
    def setUp(self):
        if not shutil.which('node'):
            self.skipTest('Node.js is required to exercise the actual frontend compiler.')
        CAPTURED.clear()
        EVENTS.clear()
        classes = [VirtualTestSource, VirtualTestCapture, VirtualTestIdentity, LiuxinyuArrayToExecutionList]
        classes += [c for c in vars(packet_tasks).values()
                    if isinstance(c, type) and c.__module__ == packet_tasks.__name__ and hasattr(c, 'define_schema')]
        self.enterContext(patch.dict(nodes.NODE_CLASS_MAPPINGS, {c.define_schema().node_id: c for c in classes}))

    def run_graph(self, prompt, cache=execution.CacheType.CLASSIC):
        pid = uuid.uuid4().hex
        valid, error, outputs, details = asyncio.run(execution.validate_prompt(pid, prompt, ['out']))
        self.assertTrue(valid, (error, details))
        executor = execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *a: None), cache,
                                            {'ram': 0, 'ram_inactive': 0, 'lru': 100})
        executor.execute(prompt, pid, execute_outputs=outputs)
        self.assertTrue(executor.success, executor.status_messages)
        return CAPTURED[-1]

    def test_separate_execution_lists_keep_their_lengths(self):
        for cache in execution.CacheType:
            with self.subTest(cache=cache):
                compiled = compile_prompt(graph())
                self.assertFalse(any(n['class_type'].startswith('LiuxinyuVirtual') for n in compiled.values()))
                self.assertEqual(self.run_graph(compiled, cache), {'a': [10, 20, 30], 'b': ['one']})

    def test_array_dictionary_image_and_empty_list_are_unchanged(self):
        image = torch.zeros(2, 3, 4, 3)
        compiled = compile_prompt(graph())
        for values in ([], [[]], [[1, [2, 3]]], [{'topic': '承重'}], [image], [None, False, 0, '']):
            with self.subTest(length=len(values)):
                compiled['source']['inputs']['payload']['items'] = values
                result = self.run_graph(compiled)
                self.assertEqual(len(result['a']), len(values))
                self.assertTrue(all(a is b for a, b in zip(result['a'], values)))

    def test_unused_lane_does_not_force_an_unrelated_branch(self):
        prompt = graph()
        del prompt['out']['inputs']['b']
        self.run_graph(compile_prompt(prompt))
        self.assertIn('source', EVENTS)
        self.assertNotIn('other', EVENTS)

    def test_multiple_receivers_share_source_and_preserve_values(self):
        for cache in execution.CacheType:
            with self.subTest(cache=cache):
                EVENTS.clear()
                prompt = graph()
                prompt['50:receive'] = node('LiuxinyuVirtualInput', key='数据')
                prompt['out']['inputs'] = {'a': ['30:receive', 0], 'b': ['50:receive', 0]}
                compiled = compile_prompt(prompt)
                values = [[1, 2], {'topic': '承重'}, torch.zeros(1, 2, 2, 3)]
                compiled['source']['inputs']['payload']['items'] = values
                result = self.run_graph(compiled, cache)
                for name in ('a', 'b'):
                    self.assertEqual(len(result[name]), len(values))
                    self.assertTrue(all(a is b for a, b in zip(result[name], values)))
                self.assertEqual(EVENTS.count('source'), 1)
                self.assertNotIn('other', EVENTS)

    def test_virtual_link_into_packet_start_keeps_execution_list_detection(self):
        prompt = graph()
        prompt.update({
            'start': node('LiuxinyuPacketStart', value0=['30:receive', 0]),
            'business': node('VirtualTestIdentity', value=['start', 1]),
            'end': node('LiuxinyuPacketEnd', condition=['start', 0], value0=['business', 0]),
        })
        prompt['out']['inputs'] = {'a': ['end', 0]}
        self.assertEqual(self.run_graph(compile_prompt(prompt)), {'a': [10, 20, 30]})

    def test_virtual_link_in_nested_packet_body_preserves_boundaries(self):
        prompt = graph()
        prompt['source']['inputs']['payload']['items'] = [[1, 2], [3, 4]]
        prompt.update({
            'outer': node('LiuxinyuPacketStart', value0=['source', 0]),
            'inner_values': node('LiuxinyuArrayToExecutionList', array=['outer', 1]),
            'inner': node('LiuxinyuPacketStart', value0=['inner_values', 0]),
            'business': node('VirtualTestIdentity', value=['30:receive', 0]),
            'inner_end': node('LiuxinyuPacketEnd', condition=['inner', 0], value0=['business', 0]),
            'outer_end': node('LiuxinyuPacketEnd', condition=['outer', 0], value0=['inner_end', 0]),
        })
        prompt['12:send']['inputs']['value0'] = ['inner', 1]
        prompt['out']['inputs'] = {'a': ['outer_end', 0]}
        self.assertEqual(self.run_graph(compile_prompt(prompt)), {'a': [1, 2, 3, 4]})

    def test_uncompiled_receiver_explains_required_frontend_export(self):
        with self.assertRaisesRegex(RuntimeError, '前端导出的 API 工作流'):
            LiuxinyuVirtualInput.execute(key='test')
        for cls in (LiuxinyuVirtualInput, LiuxinyuVirtualOutput):
            schema = cls.FINALIZE_SCHEMA()
            self.assertTrue(schema.inputs[0].socketless)
            self.assertEqual(schema.inputs[0].default, '')


if __name__ == '__main__':
    unittest.main()
