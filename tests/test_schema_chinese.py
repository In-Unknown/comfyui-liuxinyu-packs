"""Standalone Schema descriptions; these tests do not load ComfyUI or torch."""

import itertools
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jsonschema import Draft202012Validator
from schema_chinese import DescriptionError, describe, describe_schema, explain_error
from schema_chinese.compiler import ASSERTIONS, CORE, ANNOTATIONS


def object_schema(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties)}


class DescriptionTests(unittest.TestCase):
    def test_optional_path_labels_do_not_change_default_descriptions(self):
        schema = object_schema({'internal': {'type': 'string', 'minLength': 1}})
        label = lambda path: '.'.join('Display name' if p == 'internal' else str(p) for p in path) or 'Form'
        ordinary = describe_schema(schema)
        shown = describe_schema(schema, path_label=label)
        self.assertIn('internal', ordinary)
        self.assertIn('Display name', shown)
        self.assertNotIn('internal', shown)
        error = next(Draft202012Validator(schema).iter_errors({}))
        self.assertIn('Display name', explain_error(error, root_schema=schema, path_label=label))

    def test_import_is_independent_of_comfyui(self):
        self.assertNotIn('torch', sys.modules)
        self.assertNotIn('server', sys.modules)
        self.assertNotIn('comfy_api', sys.modules)

    def test_plain_json_and_boolean_schemas(self):
        self.assertEqual(describe_schema(True), '不限制取值')
        self.assertEqual(describe_schema(False), '不允许任何值')
        self.assertIn('必须是整数', describe_schema('{"type":"integer"}'))
        with self.assertRaises(DescriptionError):
            describe_schema({'type': 'made-up'})
        with self.assertRaises(DescriptionError):
            describe_schema({'$schema': 'https://json-schema.org/draft-07/schema'})

    def test_constraints_do_not_assert_an_implicit_type_or_required_key(self):
        text = describe_schema({'properties': {'name': {'minLength': 1}}})
        self.assertIn('仅当当前值是对象时', text)
        self.assertIn('字段 name 存在时', text)
        self.assertIn('仅当name是字符串时', text)
        for valid in [None, {}, {'name': 4}]:
            self.assertTrue(Draft202012Validator({'properties': {'name': {'minLength': 1}}}).is_valid(valid))

    def test_conjunction_disjunction_exclusivity_and_negation_are_distinct(self):
        for keyword, phrase in [('allOf', '全部满足'), ('anyOf', '至少满足一项'), ('oneOf', '恰好满足一项')]:
            result = describe({keyword: [{'minimum': 1}, {'maximum': 4}]})
            self.assertIn(phrase, result.text)
            self.assertEqual(result.requirement.kind, keyword)
        text = describe_schema({'not': {'anyOf': [{'const': 1}, {'const': 2}]}})
        self.assertIn('不能满足以下条件', text)
        self.assertIn('至少满足一项', text)

    def test_if_does_not_become_an_assertion_and_dependencies_apply_to_whole_object(self):
        self.assertEqual(describe_schema({'if': {'const': 1}}), '不限制取值')
        self.assertEqual(describe_schema({'then': False, 'else': False}), '不限制取值')
        text = describe_schema({'if': {'const': 1}, 'then': {'type': 'integer'},
                                'dependentSchemas': {'flag': {'required': ['other']}}})
        for phrase in ['条件本身不要求必须成立', '条件不成立时', '不限制取值', '整个对象还须满足']:
            self.assertIn(phrase, text)

    def test_array_positions_counts_and_evaluation_scope(self):
        text = describe_schema({'type': 'array', 'prefixItems': [{'type': 'string'}], 'items': False,
                                'contains': {'const': 'x'}, 'minContains': 0, 'maxContains': 1,
                                'unevaluatedItems': False, 'uniqueItems': True, 'minItems': 1, 'maxItems': 3})
        for phrase in ['第 1 项存在时', '从第 2 项起', '至少 0 项且至多 1 项', '仍未标记为已评估', '比较完整值', '至多 3 项']:
            self.assertIn(phrase, text)
        ignored = describe({'minContains': 3})
        self.assertEqual(ignored.requirement.kind, 'true')
        self.assertIn('不产生校验要求', ignored.text)

    def test_additional_properties_is_not_unevaluated_properties(self):
        text = describe_schema({'properties': {'name': True}, 'patternProperties': {'^x': {'type': 'number'}},
                                'additionalProperties': False, 'unevaluatedProperties': False,
                                'propertyNames': {'minLength': 1}, 'dependentRequired': {'name': ['id']}})
        for phrase in ['本层 properties', '本层 patternProperties', '多条匹配规则同时适用', '经相关规则成功求值', '每个字段名作为字符串', '还必须包含 id']:
            self.assertIn(phrase, text)

    def test_numeric_and_string_bounds_have_precise_semantics(self):
        text = describe_schema({'minimum': 1, 'maximum': 5, 'exclusiveMinimum': 0, 'exclusiveMaximum': 6,
                                'multipleOf': 0.5, 'minLength': 1, 'maxLength': 10, 'pattern': '\\S'})
        for phrase in ['≥ 1', '≤ 5', '> 0', '< 6', '0.5 的整数倍', 'Unicode 码点', '不是默认匹配整个字符串']:
            self.assertIn(phrase, text)

    def test_annotations_and_error_text_never_become_assertions(self):
        result = describe({'title': 'task', 'default': {'x-error-message': 'data'}, 'format': 'date',
                           'contentEncoding': 'base64', 'contentMediaType': 'application/json', 'contentSchema': False,
                           'x-error-message': 'do not invent a business rule', 'x-owner': 'author'})
        self.assertEqual(result.requirement.kind, 'true')
        self.assertNotIn('do not invent', result.text)
        self.assertIn('不作为通过／失败条件', result.text)
        self.assertIn('不据此自动解码', result.text)
        self.assertIn('扩展注解', result.text)
        self.assertIn('须符合 "date" 格式', describe_schema({'format': 'date'}, format_assertion=True))

    def test_refs_definitions_anchors_and_recursion_are_finite(self):
        schema = {'$id': 'https://example.test/tree', '$anchor': 'root', 'type': 'object',
                  'properties': {'children': {'type': 'array', 'items': {'$ref': '#root'}}}}
        result = describe(schema)
        self.assertTrue(result.complete)
        self.assertEqual(len(result.definitions), 1)
        self.assertLess(len(result.text), 2500)
        self.assertIn('规则 R1', result.text)
        root = {'$defs': {'文字': {'type': 'string', 'minLength': 1}}}
        text = describe_schema({'$ref': '#/$defs/%E6%96%87%E5%AD%97'}, root_schema=root)
        self.assertIn('必须是字符串', text)

    def test_external_refs_are_supplied_not_fetched_and_missing_refs_are_explicit(self):
        schema = {'$ref': 'https://example.test/field'}
        missing = describe(schema)
        self.assertFalse(missing.complete)
        self.assertIn('尚未描述该目标', missing.text)
        found = describe(schema, resources={'https://example.test/field': {'type': 'integer'}})
        self.assertTrue(found.complete)
        self.assertIn('必须是整数', found.text)

    def test_nested_resource_id_uses_its_own_reference_scope(self):
        schema = {'$id': 'https://example.test/root', 'properties': {'part': {
            '$id': 'nested', '$defs': {'local': {'const': 7}}, '$ref': '#/$defs/local'}}}
        result = describe(schema)
        self.assertTrue(result.complete)
        self.assertIn('等于 7', result.text)

    def test_dynamic_refs_remain_dynamic_in_the_description(self):
        schema = {'$id': 'https://example.test/tree', '$dynamicAnchor': 'node', 'type': 'object',
                  'properties': {'next': {'$dynamicRef': '#node'}}}
        result = describe(schema)
        self.assertTrue(result.complete)
        self.assertIn('按动态作用域选定', result.text)
        self.assertIn('最外层匹配锚点', result.text)

    def test_finite_domain_negation_deduction_matches_exhaustive_truth_table(self):
        groups = ['a', 'b', 'c']
        schema = object_schema({name: object_schema({'status': {'enum': ['waiting', 'ready', 'skip']}}) for name in groups})
        schema['not'] = object_schema({name: object_schema({'status': {'enum': ['waiting', 'skip']}}) for name in groups})
        result = describe(schema)
        inferred = [r for r in result.requirement.children if r.schema_path == ('not',)][0]
        self.assertEqual(inferred.kind, 'anyOf')
        self.assertEqual(len(inferred.children), 3)
        for name, rule in zip(groups, inferred.children):
            self.assertEqual(rule.text, f'{name}.status取 "ready" 中的一个值')
        validator = Draft202012Validator(schema)
        for values in itertools.product(['waiting', 'ready', 'skip'], repeat=3):
            value = {name: {'status': status} for name, status in zip(groups, values)}
            self.assertEqual(validator.is_valid(value), 'ready' in values)

    def test_unrecognized_constraints_are_not_dropped_by_deduction(self):
        schema = object_schema({'flag': {'enum': ['on', 'off']}})
        schema['not'] = {**object_schema({'flag': {'const': 'off'}}), 'maxProperties': 1}
        result = describe(schema)
        forbidden = [r for r in result.requirement.children if r.kind == 'not'][0]
        self.assertIn('至多 1 个字段', forbidden.render())

    def test_author_overrides_apply_to_errors_not_to_formal_descriptions(self):
        schema = {'type': 'string', 'minLength': 1, 'x-error-message': '请填写名称'}
        error = next(Draft202012Validator(schema).iter_errors(''))
        self.assertEqual(explain_error(error), '请填写名称')
        self.assertNotIn('请填写名称', describe_schema(schema))
        self.assertIn('至少 1 个 Unicode 码点', describe_schema(schema))

    def test_limits_fail_explicitly_and_output_is_deterministic(self):
        schema = {'properties': {'name': {'type': 'string'}}}
        with self.assertRaises(DescriptionError):
            describe(schema, max_rules=1)
        for _ in range(3):
            self.assertEqual(describe_schema({'x-b': True, 'x-a': False}), describe_schema({'x-b': True, 'x-a': False}))

    def test_every_standard_validator_keyword_has_a_declared_translation(self):
        self.assertFalse(set(Draft202012Validator.VALIDATORS) - ASSERTIONS - CORE - ANNOTATIONS)


if __name__ == '__main__':
    unittest.main()
