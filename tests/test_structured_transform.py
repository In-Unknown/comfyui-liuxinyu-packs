"""Typed JSONata contract and real-executor failure routing (no model/network calls)."""
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
from comfy_execution.graph_utils import ExecutionBlocker
from comfy_extras.nodes_logic import NotNode, SwitchNode
from logic_node import LiuxinyuRaiseIf
from structured_data_node import LiuxinyuStructuredTransform as Transform, JSON_TYPES


class Source(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='JSONReviewSource', inputs=[], outputs=[io.Dict.Output()])

    @classmethod
    def execute(cls):
        return io.NodeOutput({'a': 1})


class ImageSource(Source):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='JSONReviewImage', inputs=[], outputs=[io.Image.Output()])


class Capture(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id='JSONReviewCapture', inputs=[io.AnyType.Input('value')],
                         outputs=[], is_output_node=True)

    @classmethod
    def execute(cls, value):
        return io.NodeOutput(ui={'value': [value]})


class StructuredTransformTests(unittest.TestCase):
    def call(self, value, expression='data0', kind='字典'):
        return Transform.execute({'data0': value}, expression, kind).result

    def failed(self, result):
        self.assertIsInstance(result[0], ExecutionBlocker)
        self.assertEqual(result[1], False)
        self.assertTrue(result[2])

    def test_all_seven_types_and_false_empty_success(self):
        for kind, value in [('字典', {}), ('数组', []), ('字符串', ''), ('整数', 0),
                            ('浮点数', 0.25), ('布尔值', False), ('空值', None)]:
            with self.subTest(kind=kind):
                self.assertEqual(self.call(value, kind=kind), (value, True, ''))

    def test_no_implicit_type_conversion(self):
        for value, kind in [(True, '整数'), (1, '布尔值'), (1, '浮点数'),
                            (1.25, '整数'), ({}, '数组'), ('{}', '字典'), (None, '数组')]:
            with self.subTest(value=value, kind=kind):
                self.failed(self.call(value, kind=kind))

    def test_missing_and_explicit_null_differ(self):
        self.failed(self.call({}, 'data0.missing', '空值'))
        self.assertEqual(self.call({'x': None}, 'data0.x', '空值'), (None, True, ''))

    def test_zero_one_many_filter_arrays(self):
        for prices in [[], [5,20], [20,30]]:
            value=[{'price': p} for p in prices]
            self.assertEqual(self.call(value, '[data0[price>10]]', '数组'),
                             ([{'price': p} for p in prices if p>10], True, ''))
        self.failed(self.call([{'price':20}], 'data0[price>10]', '数组'))

    def test_sort_example_and_multi_input_merge(self):
        source=[{'percent':p} for p in [2,3,1]]
        result=self.call(source, '$sort(data0,function($a,$b){$a.percent>$b.percent})', '数组')
        self.assertEqual([x['percent'] for x in result[0]], [1,2,3])
        self.assertEqual(Transform.execute({'data0':{'a':1},'data1':{'b':2}},
                                          '$merge([data0,data1])','字典').result, ({'a':1,'b':2},True,''))

    def test_unsupported_values_fail_before_data_loss(self):
        cyclic=[];cyclic.append(cyclic)
        for value in [{1:'int','1':'string'}, {'x':(1,2)}, {'x':{1,2}}, cyclic,
                      {'x':float('nan')}, {'x':float('inf')}, {'x':9007199254740993}]:
            with self.subTest(type=type(value).__name__):self.failed(self.call(value))

    def test_numeric_bounds_also_apply_to_results(self):
        self.assertEqual(self.call(9007199254740991,kind='整数'),(9007199254740991,True,''))
        self.failed(self.call(9007199254740991,'data0+1','整数'))
        self.failed(self.call(1,'9007199254740993','整数'))

    def test_input_and_output_do_not_share_mutable_values(self):
        shared={'x':[1]};source={'a':shared,'b':shared}
        result=self.call(source)[0];result['a']['x'].append(2)
        self.assertEqual(source, {'a':{'x':[1]},'b':{'x':[1]}})

    def test_syntax_assert_and_missing_dependency_are_status(self):
        for expr in ['data0[', '$assert(false,"测试失败")']:
            self.failed(self.call({},expr))
        with patch.dict(sys.modules, {'jsonata':None}):self.failed(self.call({}))

    def test_schema_has_no_any_or_duplicate_text_output(self):
        schema=Transform.GET_NODE_INFO_V1()
        self.assertEqual(schema['output'], [JSON_TYPES,'BOOLEAN','STRING'])
        self.assertEqual(schema['output_name'], ['结果','执行成功','错误信息'])

    def run_graph(self, graph):
        classes=[Transform,Source,ImageSource,Capture,NotNode,SwitchNode,LiuxinyuRaiseIf]
        mapping={cls.define_schema().node_id:cls for cls in classes}
        with patch.dict(nodes.NODE_CLASS_MAPPINGS,mapping), patch('logging.error'), \
                patch('server.PromptServer.instance',SimpleNamespace(client_id=None),create=True):
            valid=asyncio.run(execution.validate_prompt('typed-jsonata',graph,None))
            self.assertTrue(valid[0],valid)
            runner=execution.PromptExecutor(SimpleNamespace(client_id=None,send_sync=lambda *a:None),
                                           execution.CacheType.RAM_PRESSURE,{'ram':0,'ram_inactive':0})
            runner.execute(graph,'typed-jsonata',execute_outputs=valid[2])
        return runner

    def base(self, expression):
        return {'source':{'class_type':'JSONReviewSource','inputs':{}},
                'transform':{'class_type':'LiuxinyuStructuredTransform','inputs':{
                    'sources.data0':['source',0],'expression':expression,'result_type':'字典'}}}

    def test_executor_blocks_only_result_not_status(self):
        graph=self.base('data0.missing')
        for i in range(3):graph[f'out{i}']={'class_type':'JSONReviewCapture','inputs':{'value':['transform',i]}}
        run=self.run_graph(graph)
        self.assertTrue(run.success)
        outputs=run.history_result['outputs']
        self.assertNotIn('out0',outputs)
        self.assertEqual(outputs['out1']['value'],[False])
        self.assertIn('没有得到结果',outputs['out2']['value'][0])

    def test_executor_fallback_ignores_blocked_true_branch(self):
        graph=self.base('data0.missing')
        # Keep the blocked result uncached at the fallback switch's own inputs.
        graph.update(bridge={'class_type':'ComfySwitchNode','inputs':{
            'switch':True,'on_true':['transform',0]}},
            gate={'class_type':'ComfySwitchNode','inputs':{
            'switch':['transform',1],'on_true':['bridge',0],'on_false':['source',0]}},
            out={'class_type':'JSONReviewCapture','inputs':{'value':['gate',0]}})
        run=self.run_graph(graph)
        self.assertTrue(run.success)
        self.assertEqual(run.history_result['outputs']['out']['value'],[{'a':1}])

    def test_cached_blocker_also_blocks_native_switch(self):
        graph=self.base('data0.missing')
        graph.update(gate={'class_type':'ComfySwitchNode','inputs':{
            'switch':['transform',1],'on_true':['transform',0],'on_false':['source',0]}},
            out={'class_type':'JSONReviewCapture','inputs':{'value':['gate',0]}})
        run=self.run_graph(graph)
        self.assertTrue(run.success)
        self.assertNotIn('out',run.history_result['outputs'])

    def test_executor_explicit_stop_and_success(self):
        for expression,success in [('data0',True),('data0.missing',False)]:
            with self.subTest(expression=expression):
                graph=self.base(expression)
                graph.update(negate={'class_type':'ComfyNotNode','inputs':{'value':['transform',1]}},
                    stop={'class_type':'LiuxinyuRaiseIf','inputs':{'condition':['negate',0],'message':['transform',2]}},
                    gate={'class_type':'ComfySwitchNode','inputs':{'switch':['stop',0],'on_true':['transform',0]}},
                    out={'class_type':'JSONReviewCapture','inputs':{'value':['gate',0]}})
                run=self.run_graph(graph)
                self.assertEqual(run.success,success)
                if success:self.assertEqual(run.history_result['outputs']['out']['value'],[{'a':1}])
                else:
                    errors=[v for event,v in run.status_messages if event=='execution_error']
                    self.assertEqual(errors[0]['node_id'],'stop')
                    self.assertIn('没有得到结果',errors[0]['exception_message'])

    def test_backend_rejects_non_json_socket_and_dynamic_result_type(self):
        classes=[Transform,Source,ImageSource,Capture]
        with patch.dict(nodes.NODE_CLASS_MAPPINGS,{c.define_schema().node_id:c for c in classes}):
            for invalid in ['image','type_link']:
                graph=self.base('data0')
                graph['out']={'class_type':'JSONReviewCapture','inputs':{'value':['transform',0]}}
                if invalid=='image':graph['source']['class_type']='JSONReviewImage'
                else:graph['transform']['inputs']['result_type']=['source',0]
                valid=asyncio.run(execution.validate_prompt('typed-invalid',graph,None))
                self.assertFalse(valid[0],valid)
                messages=str(valid[3])
                self.assertNotIn('exception_during_inner_validation',messages)
                self.assertIn('不接受 IMAGE' if invalid=='image' else '固定选择',messages)


if __name__=='__main__':unittest.main(verbosity=2)
