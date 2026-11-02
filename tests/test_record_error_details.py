"""Actionable validation feedback without changing acceptance or returned data."""
from copy import deepcopy
import json
from pathlib import Path
import re
import sys
import unittest

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]
from string_node import LiuxinyuParseJSONRecords as Parse
from structured_data_node import LiuxinyuStructuredTransform as Transform


class RecordErrorDetailsTests(unittest.TestCase):
    def error(self, rows, fields, allow_extra=False):
        result, passed, error = Parse.execute(json.dumps(rows, ensure_ascii=False),
                                              json.dumps(fields, ensure_ascii=False), allow_extra).result
        self.assertEqual(result, [])
        self.assertIs(passed, False)
        return error

    def test_scalar_reports_record_path_expected_and_actual(self):
        message = self.error([{'count': 2}, {'count': '2'}], {'count': 'integer'})
        self.assertEqual(message, '第 2 项的 \'count\' 必须是 integer。位置 $[1]["count"]；实际为 string，值为 "2"。')
        for value, actual in ((True, 'boolean，值为 true'), (2.0, 'number，值为 2.0'),
                              (None, 'null，值为 null'), ([], 'array，含 0 个元素'),
                              ({'nested': 1}, 'object，含 1 个字段')):
            with self.subTest(value=value):
                self.assertIn(actual, self.error([{'count': value}], {'count': 'integer'}))

    def test_array_member_position_and_container_type(self):
        message = self.error([{'recordPaths': []}, {'recordPaths': ['a', 'b', 123, False]}],
                             {'recordPaths': 'string[]'})
        self.assertEqual(message, '第 2 项的 \'recordPaths\' 第 3 个元素 必须是 string。位置 $[1]["recordPaths"][2]；实际为 integer，值为 123。')
        self.assertNotIn('false', message)
        self.assertIn('必须是 string[]', self.error([{'recordPaths': 'a'}], {'recordPaths': 'string[]'}))
        self.assertIn('["values"][1]', self.error([{'values': [1, True]}], {'values': 'integer[]'}))

    def test_special_field_names_are_unambiguous(self):
        key = 'a.b[0]"\n'
        message = self.error([{key: 5}], {key: 'string'})
        self.assertIn('$[0][' + json.dumps(key, ensure_ascii=False) + ']', message)

    def test_first_error_and_allowed_extra_fields(self):
        message = self.error([{'extra': 0}, {'count': 'bad'}], {'count': 'integer'}, True)
        self.assertEqual(message, "第 1 项字段不符合契约；缺少 ['count']，额外 []。位置 $[0]。")
        self.assertNotIn('第 2 项', message)
        self.assertIn("额外 ['extra']", self.error([{'count': 1, 'extra': 0}], {'count': 'integer'}))
        self.assertEqual(self.error([{'count': 1}, None], {'count': 'integer'}),
                         '第 2 项需要是对象。位置 $[1]；实际为 null，值为 null。')

    def test_empty_string_and_bounded_preview(self):
        self.assertIn('nonempty_string', self.error([{'name': '  '}], {'name': 'nonempty_string'}))
        long = 'a' * 120 + 'unprinted-tail'
        message = self.error([{'count': long}], {'count': 'integer'})
        self.assertIn('仅显示前 120 个字符', message)
        self.assertNotIn('unprinted-tail', message)
        self.assertIn('"a\\n\\\"b"', self.error([{'count': 'a\n"b'}], {'count': 'integer'}))

    def test_valid_data_empty_array_and_parser_failures_unchanged(self):
        rows = [{'count': 1, 'paths': ['a', 'b']}, {'count': 2, 'paths': []}]
        self.assertEqual(Parse.execute(json.dumps(rows), '{"count":"integer","paths":"string[]"}').result,
                         (rows, True, ''))
        self.assertEqual(Parse.execute('[]', '{"count":"integer"}').result, ([], True, ''))
        for text in ('not JSON', '[{"count":1,"count":2}]', '[{"count":NaN}]', '[{"count":}]'):
            with self.subTest(text=text):
                result, passed, message = Parse.execute(text, '{"count":"integer"}').result
                self.assertEqual(result, [])
                self.assertIs(passed, False)
                self.assertTrue(message)


class DuplicateTopicFeedbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        doc = (PACK / 'docs/LiuxinyuStructuredTransform.md').read_text(encoding='utf-8')
        cls.expression = re.search(r'```jsonata\n(.*?)\n```', doc, re.S).group(1)

    def run_expression(self, names):
        rows = [{'topic': name, 'definition': '', 'recordPaths': [str(i)]} for i, name in enumerate(names)]
        before = deepcopy(rows)
        result = Transform.execute({'data0': rows}, self.expression, '数组').result
        self.assertEqual(rows, before)
        return rows, result

    def test_lists_all_duplicate_names_and_positions(self):
        _, (_, passed, error) = self.run_expression(['承重', '稳定', '承重', '稳定', '承重'])
        self.assertIs(passed, False)
        self.assertEqual(error, 'JSONata 数据变换失败：topic 分组名称重复：名称「承重」出现在第 1、3、5 项；名称「稳定」出现在第 2、4 项。')

    def test_single_duplicate_and_literal_names(self):
        name = 'a."[0]\\\n中文'
        _, (_, passed, error) = self.run_expression([name, 'other', name])
        self.assertIs(passed, False)
        self.assertIn('名称「' + name + '」出现在第 1、3 项', error)

    def test_success_preserves_data_and_exact_comparison(self):
        for names in ([], ['A'], ['A', 'B'], ['a', 'A', ' A']):
            with self.subTest(names=names):
                rows, (output, passed, error) = self.run_expression(names)
                self.assertEqual(output, rows)
                self.assertIs(passed, True)
                self.assertEqual(error, '')


if __name__ == '__main__':
    unittest.main()
