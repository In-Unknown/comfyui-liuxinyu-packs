"""Exercise status outputs, conditional failure and index lists with Comfy's executor."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]
import execution
import nodes
from comfy_api.latest import io
from comfy_extras.nodes_logic import NotNode, SwitchNode
from logic_node import LiuxinyuRaiseIf
from string_node import (LiuxinyuParseJSONRecords, LiuxinyuArrayObjectPaths,
                         LiuxinyuBuildKeyValuePairs, LiuxinyuReadJSObjectPath)
from execution_list_node import LiuxinyuArrayToExecutionList
from structured_data_node import LiuxinyuCollectExecutionList, LiuxinyuMergeDictionaryArray

VALUES = {}
CONSUMED = []


class Value(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='ControlValue', inputs=[io.String.Input('key')], outputs=[io.AnyType.Output()])

    @classmethod
    def execute(cls, key):
        return io.NodeOutput(VALUES[key])


class Capture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='ControlCapture', inputs=[io.AnyType.Input('value')], outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, value):
        CONSUMED.append(value)
        return io.NodeOutput(ui={'values': [value]})


class CaptureList(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='ControlCaptureList', inputs=[io.AnyType.Input('value')], outputs=[],
                         is_input_list=True, is_output_node=True)

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(ui={'values': value})


class UnneededMessage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='UnneededMessage', inputs=[], outputs=[io.String.Output()])

    @classmethod
    def execute(cls):
        raise AssertionError('False stop condition must not evaluate its message branch')


class RecordControlTests(unittest.TestCase):
    def run_graph(self, graph):
        classes = [LiuxinyuRaiseIf, LiuxinyuParseJSONRecords, LiuxinyuArrayObjectPaths,
                   LiuxinyuBuildKeyValuePairs, LiuxinyuReadJSObjectPath,
                   LiuxinyuArrayToExecutionList, LiuxinyuCollectExecutionList, LiuxinyuMergeDictionaryArray,
                   NotNode, SwitchNode, Value, Capture, CaptureList, UnneededMessage]
        mapping = {cls.define_schema().node_id: cls for cls in classes}
        CONSUMED.clear()
        with patch.dict(nodes.NODE_CLASS_MAPPINGS, mapping), patch('logging.error'), \
                patch('server.PromptServer.instance', SimpleNamespace(client_id=None), create=True):
            valid = asyncio.run(execution.validate_prompt('record-control', graph, None))
            self.assertTrue(valid[0], valid)
            executor = execution.PromptExecutor(SimpleNamespace(client_id=None, send_sync=lambda *args: None),
                                               execution.CacheType.RAM_PRESSURE, {'ram': 0, 'ram_inactive': 0})
            executor.execute(graph, 'record-control', execute_outputs=valid[2])
        return executor

    def parser(self, text):
        return {'class_type': 'LiuxinyuParseJSONRecords',
                'inputs': {'text': text, 'fields': '{"id":"string"}', 'allow_extra': False}}

    def guarded_graph(self, text):
        return {
            'parse': self.parser(text),
            'not': {'class_type': 'ComfyNotNode', 'inputs': {'value': ['parse', 1]}},
            'stop': {'class_type': 'LiuxinyuRaiseIf', 'inputs': {'condition': ['not', 0], 'message': ['parse', 2]}},
            'gate': {'class_type': 'ComfySwitchNode', 'inputs': {'switch': ['stop', 0], 'on_true': ['parse', 0]}},
            'consume': {'class_type': 'ControlCapture', 'inputs': {'value': ['gate', 0]}},
        }

    def test_invalid_parser_is_data_not_execution_error(self):
        graph = {'parse': self.parser('[{"id":4}]')}
        for i in range(3):
            graph[f'out{i}'] = {'class_type': 'ControlCapture', 'inputs': {'value': ['parse', i]}}
        run = self.run_graph(graph)
        self.assertTrue(run.success)
        outputs = run.history_result['outputs']
        self.assertEqual(outputs['out0']['values'], [[]])
        self.assertEqual(outputs['out1']['values'], [False])
        self.assertIn('id', outputs['out2']['values'][0])

    def test_invalid_parser_can_select_fallback_without_stopping(self):
        VALUES['fallback'] = [{'id': 'fallback'}]
        run = self.run_graph({
            'parse': self.parser('broken'),
            'fallback': {'class_type': 'ControlValue', 'inputs': {'key': 'fallback'}},
            'switch': {'class_type': 'ComfySwitchNode', 'inputs': {
                'switch': ['parse', 1], 'on_true': ['parse', 0], 'on_false': ['fallback', 0]}},
            'consume': {'class_type': 'ControlCapture', 'inputs': {'value': ['switch', 0]}},
        })
        self.assertTrue(run.success)
        self.assertEqual(CONSUMED, [[{'id': 'fallback'}]])

    def test_explicit_failure_blocks_consumers_and_reports_parser_message(self):
        run = self.run_graph(self.guarded_graph('[{"id":4}]'))
        self.assertFalse(run.success)
        self.assertEqual(CONSUMED, [])
        errors = [data for event, data in run.status_messages if event == 'execution_error']
        self.assertEqual(errors[0]['node_id'], 'stop')
        self.assertIn('id', errors[0]['exception_message'])

    def test_valid_records_and_valid_empty_array_pass_guard(self):
        for text, expected in [('[{"id":"A"}]', [{'id': 'A'}]), ('[]', [])]:
            with self.subTest(text=text):
                run = self.run_graph(self.guarded_graph(text))
                self.assertTrue(run.success)
                self.assertEqual(CONSUMED, [expected])

    def test_false_condition_skips_error_message_branch(self):
        run = self.run_graph({
            'unused': {'class_type': 'UnneededMessage', 'inputs': {}},
            'stop': {'class_type': 'LiuxinyuRaiseIf', 'inputs': {'condition': False, 'message': ['unused', 0]}},
            'consume': {'class_type': 'ControlCapture', 'inputs': {'value': ['stop', 0]}},
        })
        self.assertTrue(run.success)
        self.assertEqual(CONSUMED, [True])

    def test_terminal_stop_runs_without_outgoing_connection(self):
        run = self.run_graph({'stop': {'class_type': 'LiuxinyuRaiseIf',
                                      'inputs': {'condition': True, 'message': '自定义停止原因'}}})
        self.assertFalse(run.success)
        errors = [data for event, data in run.status_messages if event == 'execution_error']
        self.assertIn('自定义停止原因', errors[0]['exception_message'])

    def test_index_array_and_execution_list_have_distinct_dispatch(self):
        for source, expected in [([[{}, {}], []], ['[0][0]', '[0][1]']), ([], [])]:
            with self.subTest(source=source):
                VALUES['source'] = source
                run = self.run_graph({
                    'source': {'class_type': 'ControlValue', 'inputs': {'key': 'source'}},
                    'paths': {'class_type': 'LiuxinyuArrayObjectPaths', 'inputs': {
                        'content': ['source', 0], 'depth': -1, 'include_fields': False, 'include_arrays': True}},
                    'array': {'class_type': 'ControlCapture', 'inputs': {'value': ['paths', 0]}},
                    'items': {'class_type': 'ControlCaptureList', 'inputs': {'value': ['paths', 1]}},
                })
                self.assertTrue(run.success)
                self.assertEqual(run.history_result['outputs']['array']['values'], [expected])
                self.assertEqual(run.history_result['outputs']['items']['values'], expected)

    def test_pair_builder_preserves_whole_array_and_null_values_in_executor(self):
        for keys, payload, expected in [('settings', [10,20], {'settings':[10,20]}),
                                        (['A','B'], [10,20], {'A':[10,20],'B':[10,20]}),
                                        ('A', None, {'A':None}), ([], False, {})]:
            with self.subTest(keys=keys, payload=payload):
                VALUES.update(keys=keys, payload=payload)
                run=self.run_graph({
                    'keys':{'class_type':'ControlValue','inputs':{'key':'keys'}},
                    'payload':{'class_type':'ControlValue','inputs':{'key':'payload'}},
                    'pairs':{'class_type':'LiuxinyuBuildKeyValuePairs','inputs':{
                        'key':['keys',0],'value':['payload',0]}},
                    'out':{'class_type':'ControlCapture','inputs':{'value':['pairs',0]}},
                })
                self.assertTrue(run.success,run.status_messages)
                self.assertEqual(CONSUMED,[expected])

    def test_read_then_build_keeps_execution_items_paired(self):
        VALUES['rows']=[{'name':'A','score':10},{'name':'B','score':20}]
        run=self.run_graph({
            'rows':{'class_type':'ControlValue','inputs':{'key':'rows'}},
            'items':{'class_type':'LiuxinyuArrayToExecutionList','inputs':{'array':['rows',0]}},
            'keys':{'class_type':'LiuxinyuReadJSObjectPath','inputs':{'content':['items',0],'expression':'name'}},
            'values':{'class_type':'LiuxinyuReadJSObjectPath','inputs':{'content':['items',0],'expression':'score'}},
            'pairs':{'class_type':'LiuxinyuBuildKeyValuePairs','inputs':{'key':['keys',0],'value':['values',0]}},
            'collect':{'class_type':'LiuxinyuCollectExecutionList','inputs':{'value':['pairs',0]}},
            'out':{'class_type':'ControlCapture','inputs':{'value':['collect',0]}},
        })
        self.assertTrue(run.success,run.status_messages)
        self.assertEqual(CONSUMED,[[{'A':10},{'B':20}]])

    def test_collect_then_merge_outputs_one_dictionary_including_empty_list(self):
        for rows,expected in [([{'name':'A'},{'score':20}],{'name':'A','score':20}),([], {})]:
            with self.subTest(rows=rows):
                VALUES['rows']=rows
                run=self.run_graph({
                    'rows':{'class_type':'ControlValue','inputs':{'key':'rows'}},
                    'items':{'class_type':'LiuxinyuArrayToExecutionList','inputs':{'array':['rows',0]}},
                    'collect':{'class_type':'LiuxinyuCollectExecutionList','inputs':{'value':['items',0]}},
                    'merge':{'class_type':'LiuxinyuMergeDictionaryArray','inputs':{'dictionaries':['collect',0]}},
                    'out':{'class_type':'ControlCaptureList','inputs':{'value':['merge',0]}},
                })
                self.assertTrue(run.success,run.status_messages)
                self.assertEqual(run.history_result['outputs']['out']['values'],[expected])


if __name__ == '__main__':
    unittest.main()
