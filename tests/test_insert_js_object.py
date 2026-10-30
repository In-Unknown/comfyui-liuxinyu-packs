"""Insertion uses the same safe paths as reading and never mutates inputs."""
import asyncio
from copy import deepcopy
from pathlib import Path
import sys
import unittest

PACK=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(PACK),str(PACK.parents[1])]
import execution
import torch
from string_node import LiuxinyuInsertJSObject as Insert, LiuxinyuReadJSObjectPath as Read


def run(content,expression,value):
    output,*_=asyncio.run(execution.get_output_data('insert-test','insert',Insert,
        {'content':[content],'expression':[expression],'value':[value]}))
    return output[0][0]


class InsertTests(unittest.TestCase):
    def test_dictionary_fields_at_nested_and_root_positions(self):
        source={'products':[{'analysis':{'text':'原文'}}],'other':[]}
        before=deepcopy(source)
        added={'topic':'安全','details':[{'中文':True}],'empty':None}
        result=run(source,'products[0].analysis',added)
        self.assertEqual(result['products'][0]['analysis'],{'text':'原文',**added})
        self.assertEqual(source,before)
        self.assertIsNot(result,source)
        self.assertIsNot(result['products'],source['products'])
        self.assertEqual(run({},'',added),added)

    def test_arrays_append_arbitrary_values_as_one_item(self):
        tensor=torch.zeros(2,3)
        for value in (1,0.2,False,None,'中文',{'k':1},[1,2],tensor,object()):
            source={'items':['first']}
            with self.subTest(kind=type(value).__name__):
                result=run(source,'items',value)
                self.assertEqual(len(result['items']),2)
                self.assertIs(result['items'][1],value)
                self.assertEqual(source,{'items':['first']})
        self.assertEqual(run([],'',[1,2]),[[1,2]])

    def test_shared_path_syntax_and_special_keys(self):
        source={'a.b':{'中文':[{}]},'0':{}}
        for path in ['["a.b"].中文[0]', "['a.b']['中文']['0']"]:
            result=run(source,path,{'x':1})
            self.assertEqual(Read.execute(result,path).result[0],{'x':1})
        self.assertEqual(run(source,'[0]',{'x':1})['0'],{'x':1})
        self.assertEqual(run([{}],' [0] ',{'x':1}),[{'x':1}])

    def test_conflicts_are_atomic(self):
        source={'k':1}
        with self.assertRaises(ValueError): run(source,'',{'new':2,'k':3})
        self.assertEqual(source,{'k':1})
        self.assertEqual(run(source,'',{}),source)

    def test_reject_invalid_targets_and_paths(self):
        for path in ['missing','items[9]','items[-1]','items[0].x','items.length','items[0]','items[0];bad()']:
            with self.subTest(path=path),self.assertRaises(ValueError): run({'items':[1]},path,{})
        with self.assertRaises(ValueError): run('raw JSON','',{})
        with self.assertRaises(ValueError): run({},'','not a dictionary')

    def test_existing_reader_behavior(self):
        self.assertEqual(Read.execute({'items':[1,2]},'items.length').result[0],2)
        self.assertEqual(Read.execute({'items':[1,2]},'items[1]').result[0],2)

    def test_execution_list_calls_are_independent(self):
        source={}
        output,*_=asyncio.run(execution.get_output_data('insert-test','insert',Insert,
            {'content':[source],'expression':[''],'value':[{'a':1},{'b':2}]}))
        self.assertEqual(output[0],[{'a':1},{'b':2}])
        self.assertEqual(source,{})


if __name__=='__main__': unittest.main()
