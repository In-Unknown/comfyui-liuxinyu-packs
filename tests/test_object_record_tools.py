"""Generic record tools: exact JSON, paths, key/value assembly and merging."""
from copy import deepcopy
from pathlib import Path
import json
import sys
import unittest

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]
from string_node import (
    LiuxinyuParseJSONRecords as Parse,
    LiuxinyuArrayObjectPaths as Paths,
    LiuxinyuBuildKeyValuePairs as Pairs,
    LiuxinyuReadJSObjectPath as ReadOne,
    LiuxinyuInsertJSObject as Insert,
)
from structured_data_node import LiuxinyuMergeDictionaryArray as Merge


def value(node, *args, **kwargs):
    return node.execute(*args, **kwargs).result[0]


class RecordToolsTests(unittest.TestCase):
    def assert_invalid(self, text, fields='{"id":"string"}'):
        records, valid, error = Parse.execute(text, fields).result
        self.assertEqual(records, [])
        self.assertIs(valid, False)
        self.assertIsInstance(error, str)
        self.assertTrue(error)

    def test_parser_status_distinguishes_valid_empty_array_from_failure(self):
        self.assertEqual(Parse.execute('[]', '{"id":"string"}').result, ([], True, ""))
        self.assertEqual(Parse.execute('[{"id":"A"}]', '{"id":"string"}').result,
                         ([{"id":"A"}], True, ""))
        self.assert_invalid('[{"id":"A"},{"id":3}]')
        self.assert_invalid('bad json')
        self.assert_invalid('[]', '{bad contract}')
        self.assert_invalid(None)

    def test_parser_uses_final_document_and_preserves_literal_characters(self):
        expected = [{"name": '文字 " [ { \\ \n {t1}', "tags": ["x", "y"]}]
        data = json.dumps(expected, ensure_ascii=False)
        for text in (data, "草稿：[]\n最终结果：" + data,
                     '[{"draft":true}]\n' + data,
                     "```json\n[]\n```\n最终结果：" + data,
                     "```json\n[]\n```\n最终结果\n```json\n" + data + "\n```"):
            self.assertEqual(value(Parse, text, '{"name":"string","tags":"string[]"}'), expected)

    def test_parser_rejects_bad_final_document_instead_of_using_draft(self):
        for text in ('[]\n[{"name":', '[]\n[{"name":}]',
                     '```json\n[]\n```\n```json\n[{"name":',
                     '```json\n[]\n```\n```json\n[{"name":}]\n```'):
            with self.subTest(text=text):
                self.assert_invalid(text, '{"name":"string"}')

    def test_parser_rejects_duplicate_keys_and_nonstandard_numbers(self):
        for text in ('[{"id":"a","id":"b"}]', '[{"id":NaN}]', '[{"id":Infinity}]', '[{"id":1e999}]'):
            with self.subTest(text=text):
                self.assert_invalid(text)

    def test_parser_field_contract_is_explicit(self):
        for text in ('{}', '[1]', '[{}]', '[{"id":1}]', '[{"id":"x","extra":1}]'):
            with self.subTest(text=text):
                self.assert_invalid(text)
        self.assertEqual(value(Parse, '[{"id":"x","extra":1}]', '{"id":"string"}', True),
                         [{"id": "x", "extra": 1}])
        self.assert_invalid('[{"id":"  "}]', '{"id":"nonempty_string"}')
        self.assert_invalid('[{"id":true}]', '{"id":"integer"}')
        self.assert_invalid('[]', '{"id":"unknown"}')

    def test_paths_stop_at_objects_and_keep_empty_arrays(self):
        tree = [[], {"nested": [{"not": "another record"}]}, [[{}, {}]], []]
        before = deepcopy(tree)
        self.assertEqual(value(Paths, tree), ['[1]', '[2][0][0]', '[2][0][1]'])
        self.assertEqual(value(Paths, {}), [''])
        self.assertEqual(value(Paths, [[], []]), [])
        self.assertEqual(tree, before)
        for scalar in (1, None, True):
            self.assertEqual(value(Paths, [scalar]), ['[0]'])
        cyclic = []; cyclic.append(cyclic)
        with self.assertRaises(ValueError): value(Paths, cyclic)

    def test_index_depth_and_container_switches(self):
        source = {"items": [{"score": 2}, {"tags": ["x", "y"]}], "enabled": False}
        self.assertEqual(value(Paths, source), [''])
        self.assertEqual(value(Paths, source, 1, True, True), ['["items"]', '["enabled"]'])
        self.assertEqual(value(Paths, source, 2, True, True), ['["items"][0]', '["items"][1]', '["enabled"]'])
        self.assertEqual(value(Paths, source, -1, True, True),
                         ['["items"][0]["score"]', '["items"][1]["tags"][0]', '["items"][1]["tags"][1]', '["enabled"]'])
        self.assertEqual(value(Paths, source, -1, True, False), ['["items"]', '["enabled"]'])
        self.assertEqual(value(Paths, source, -1, False, False), [''])
        self.assertEqual(value(Paths, [[{}]], 1), ['[0]'])
        self.assertEqual(value(Paths, [[{}]], 9), ['[0][0]'])
        self.assertEqual(value(Paths, {}, -1, True), [])
        self.assertEqual(value(Paths, [], -1, False, False), [''])
        for depth in (0, -2, True, 1.5):
            with self.subTest(depth=depth), self.assertRaises(ValueError):
                value(Paths, source, depth)

    def test_index_paths_round_trip_special_keys_and_shared_objects(self):
        shared = {"a.b": ["x", None], 'quote"': {"中文": True}, "": 0}
        source = [shared, shared]
        paths, execution_list = Paths.execute(source, -1, True, True).result
        self.assertEqual(paths, execution_list)
        self.assertEqual([value(ReadOne, source, path) for path in paths], ['x', None, True, 0] * 2)
        self.assertEqual(Paths.execute([], -1).result, ([], []))
        cyclic = {}; cyclic['self'] = cyclic
        with self.assertRaises(ValueError): value(Paths, cyclic, -1, True)
        self.assertEqual(value(Paths, cyclic, 1, True), ['["self"]'])

    def test_index_handles_deep_arrays_without_python_recursion(self):
        source = {}
        for _ in range(1500): source = [source]
        self.assertEqual(value(Paths, source), ['[0]' * 1500])

    def test_read_and_assemble_compose_without_implicit_field_extraction(self):
        groups = [{"owner": "Alice", "ids": ['items[0]', 'items[2]']},
                  {"owner": "Bob", "ids": ['items[1]']}]
        patches = [value(Pairs, value(ReadOne, row, 'ids'),
                         value(Pairs, 'owner', value(ReadOne, row, 'owner'))) for row in groups]
        source = {'items': [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}]}
        result = source
        for path, fields in value(Merge, patches).items():
            result = value(Insert, result, path, fields)
        self.assertEqual(result,
                         {'items': [{'id': 'A', 'owner': 'Alice'}, {'id': 'B', 'owner': 'Bob'},
                                    {'id': 'C', 'owner': 'Alice'}]})
        self.assertEqual(source, {'items': [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}]})

    def test_pairs_keep_literal_keys_types_and_value_references(self):
        for key in ('', 'a.b', '[0]', '["A","B"]', ' 中文\n"\\ '):
            for item in ('text', 0, False, None, {'nested': [1]}, [1, 2], object()):
                with self.subTest(key=key, item=item):
                    result = value(Pairs, key, item)
                    self.assertEqual(list(result), [key])
                    self.assertIs(result[key], item)
        payload = ['x', 'y']
        self.assertEqual(value(Pairs, ['A', 'B'], payload), {'A': ['x', 'y'], 'B': ['x', 'y']})
        self.assertIs(value(Pairs, ['A', 'B'], payload)['A'], payload)
        self.assertEqual(value(Pairs, [], None), {})

    def test_pairs_reject_duplicate_and_nonstring_keys(self):
        for key in (['A', 'A'], ['', ''], [1], ['A', None], [['A']], 1, False, None, {}):
            with self.subTest(key=key), self.assertRaises(ValueError):
                value(Pairs, key, 0)

    def test_read_build_and_merge_keep_paths_and_original_values(self):
        opaque = object()
        source = {"a.b": [{"opaque": opaque}], "other": {}}
        def read_paths(paths):
            return value(Merge, [value(Pairs, path, value(ReadOne, source, path)) for path in paths])
        result = read_paths(['["a.b"][0]', 'other'])
        self.assertIs(result['["a.b"][0]'], source['a.b'][0])
        self.assertIs(result['["a.b"][0]']['opaque'], opaque)
        self.assertEqual(read_paths([]), {})
        for paths in (['other', 'other'], ['missing']):
            with self.assertRaises(ValueError): read_paths(paths)

    def test_merge_dictionary_array_preserves_types_order_and_input(self):
        opaque=object()
        rows=[{'a':[1,2],'b':{'nested':True}}, {}, {'':None,'enabled':False,'count':0,'opaque':opaque}]
        result=value(Merge,rows)
        self.assertEqual(list(result),['a','b','','enabled','count','opaque'])
        self.assertIs(result['a'],rows[0]['a'])
        self.assertIs(result['b'],rows[0]['b'])
        self.assertIs(result['opaque'],opaque)
        self.assertIsNone(result[''])
        self.assertIs(result['enabled'],False)
        self.assertEqual(result['count'],0)
        self.assertEqual(list(rows[0]),['a','b'])
        self.assertEqual(value(Merge,[]),{})
        self.assertEqual(value(Merge,[{},{}]),{})

    def test_merge_rejects_conflicts_and_invalid_members_without_mutation(self):
        for rows in ([{'a':1},{'a':1}], [{'a':{'x':1}},{'a':{'y':2}}],
                     [{'a':1},None], [{'a':1},[]], [{'a':1},'text'], {}, '[{"a":1}]'):
            before=deepcopy(rows)
            with self.subTest(rows=rows),self.assertRaises(ValueError):value(Merge,rows)
            self.assertEqual(rows,before)


if __name__ == '__main__': unittest.main()
