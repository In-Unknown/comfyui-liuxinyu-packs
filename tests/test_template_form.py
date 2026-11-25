"""Real Draft 2020-12 validation and interactive execution; no remote API calls."""

import asyncio
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(PACK), str(PACK.parents[1])]
import execution
import template_form_node as form
import template_form_notifications as notifications
from comfy_api.latest import io
from comfy_execution.graph import DynamicPrompt
from comfy_execution.utils import CurrentNodeContext


class FormTests(unittest.TestCase):
    def test_image_modes_keep_original_path_or_copy_explicitly(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "photo.png"
            Image.new("RGB", (2, 2), "red").save(source)
            with patch.object(form.folder_paths, "get_input_directory", return_value=str(root / "input")):
                self.assertEqual(form.encode_form_image(source, "link"), str(source.resolve()))
                self.assertTrue(form.encode_form_image(source, "auto").startswith("data:image/png;base64,"))
                copied = form.encode_form_image(source, "copy")
                self.assertTrue((root / "input" / copied).is_file())
                large = root / "large.bmp"
                Image.new("RGB", (500, 500), "red").save(large)
                self.assertEqual(form.encode_form_image(large, "auto"), str(large.resolve()))
                (root / "bad.png").write_text("not an image", encoding="utf-8")
                with self.assertRaises(ValueError):
                    form.encode_form_image(root / "bad.png", "link")

    def test_image_thumbnail_uses_small_preview_for_input_path(self):
        from io import BytesIO
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "photo.png"
            Image.new("RGB", (1200, 900), "red").save(source)
            with patch.object(form.folder_paths, "get_input_directory", return_value=str(root)):
                preview = Image.open(BytesIO(form.form_image_thumbnail("photo.png")))
                self.assertLessEqual(max(preview.size), 320)
                self.assertEqual(preview.format, "WEBP")
                with self.assertRaises(ValueError):
                    form.form_image_thumbnail("../outside.png")

    def test_config_values_parse_binding_and_metadata(self):
        schema = {'type': 'object', 'properties': {'n': {'type': 'integer'}}}
        self.assertEqual(form.parse_form_values('{"n":3}', schema)['value'], {'n': 3})
        payload = {'$format': 'liuxinyu.template-values/v1', 'schema': schema, 'value': {'n': 4}, 'field_required': {'$/n': False}}
        result = form.parse_form_values(json.dumps(payload), schema)
        self.assertEqual(result['field_required'], {'$/n': False})
        self.assertEqual(result['value'], {'n': 4})
        with self.assertRaises(ValueError): form.parse_form_values(payload, {'type': 'array'})
        with self.assertRaises(ValueError): form.parse_form_values('not json', schema)
        # Invalid source values remain available to the user for correction.
        self.assertEqual(form.parse_form_values('{"n":"wrong"}', schema)['value'], {'n': 'wrong'})

    def test_input_mode_validation_properties_do_not_lock_dynamic_names(self):
        schema = {"type": "object", "properties": {"keys": {"type": "object", "properties": {"fixed": {"type": "string"}}, "additionalProperties": True}}}
        value = {"keys": {"1": "A", "fixed": "A"}}
        for mode in ("enum", "image", "file", "date", "color"):
            effective = form.materialize_required_properties(schema, value, {"$/keys/1": mode, "$/keys/fixed": mode}, field_enums={"$/keys/1": ["A"], "$/keys/fixed": ["A"]})
            view = form.context_for(effective).presentation(effective, value)
            self.assertEqual(view["properties"]["keys"]["x-editableKeys"], ["1"])

    def test_editable_enum_options_validate_source_projection_and_reuse(self):
        schema={"type":"object","properties":{"keys":{"type":"object"},"rows":{"type":"array","items":{"type":"object","x-requiredPropertiesFrom":{"pointer":"/keys","propertySchema":True}}}}}
        value={"keys":{"style":"A"},"rows":[{"style":"B"}]}
        modes={"$/keys/style":"enum"};options={"$/keys/style":["A","B"]}
        self.assertEqual(form.validate_value(schema,value,modes,field_enums=options)[1],[])
        self.assertTrue(form.reusable({"schema":schema,"value":value,"input_types":modes,"field_enums":options,"confirmed":True},schema))
        value['rows'][0]['style']='C'
        self.assertTrue(form.validate_value(schema,value,modes,field_enums=options)[1])
        self.assertTrue(form.validate_value(schema,value,modes,field_enums={})[1])
        with self.assertRaises(ValueError): form.validate_value(schema,value,modes,field_enums={'$/keys/style':['A','A']})

    def test_projected_required_flag_is_saved_separately_and_validated(self):
        schema={"type":"object","properties":{"keys":{"type":"object"},"rows":{"type":"array","items":{"type":"object","x-requiredPropertiesFrom":{"pointer":"/keys","propertySchema":{"type":"string"}}}}}}
        value={"keys":{"name":"example"},"rows":[{}]}
        self.assertTrue(form.validate_value(schema,value)[1])
        flags={"$/keys/name":False}
        self.assertEqual(form.validate_value(schema,value,field_required=flags)[1],[])
        self.assertTrue(form.reusable({"schema":schema,"value":value,"confirmed":True,"field_required":flags},schema))
        effective=form.materialize_required_properties(schema,value,field_required=flags)
        self.assertNotIn("name",effective["properties"]["rows"]["items"]["required"])

    def test_recursive_projection_requires_nested_keys_and_keeps_defaults(self):
        schema = form.parse_schema({"type": "object", "properties": {
            "keys": {"type": "object"}, "rows": {"type": "array", "items": {
                "type": "object", "x-requiredPropertiesFrom": {"pointer": "/keys", "propertySchema": True}}}}})
        value = {"keys": {"nested": {"photo": "pic.png", "deeper": {"count": 3}}},
                 "rows": [{"nested": {"photo": "other.png", "deeper": {"count": 4}}}]}
        effective = form.materialize_required_properties(schema, value, {"/keys/nested/photo": "image"})
        nested = effective["properties"]["rows"]["items"]["properties"]["nested"]
        self.assertEqual(nested["x-requiredPropertiesFrom"]["pointer"], "/keys/nested")
        self.assertIn("photo", nested["required"])
        self.assertFalse(nested["additionalProperties"])
        self.assertEqual(nested["properties"]["photo"]["default"], "pic.png")
        self.assertIn("x-image", nested["properties"]["photo"])
        self.assertEqual(form.validate_value(schema, value)[1], [])
        del value["rows"][0]["nested"]["deeper"]["count"]
        self.assertTrue(form.validate_value(schema, value)[1])

    def test_ordered_properties_and_editable_key_presentation(self):
        schema = form.parse_schema({"type": "object", "properties": {
            "min": {"type": "integer"}, "max": {"type": "integer"}},
            "x-orderedProperties": [["min", "max"]], "propertyNames": {"minLength": 2}})
        self.assertEqual(form.validate_value(schema, {"min": 2, "max": 2})[1], [])
        errors = form.validate_value(schema, {"min": 3, "max": 2})[1]
        self.assertEqual(errors[0]["path"], "/max")
        self.assertIn("不得大于", errors[0]["message"])
        view = form.context_for(schema).presentation(schema, {"min": 1, "max": 2, "dynamic": 3})
        self.assertEqual(view["x-editableKeys"], ["dynamic"])
        self.assertEqual(view["propertyNames"], {"minLength": 2})

    def test_dynamic_required_properties_are_presented_and_validated(self):
        schema = {
            "type": "object",
            "properties": {
                "区分键": {"type": "object", "additionalProperties": True},
                "SKU列表": {"type": "array", "items": {
                    "type": "object", "properties": {}, "required": [], "additionalProperties": False,
                    "x-requiredPropertiesFrom": {
                        "pointer": "/区分键",
                        "propertySchemaByType": {
                            "string": {"type": "string", "minLength": 1, "pattern": "\\S"},
                            "integer": {"type": "integer"},
                        },
                    },
                }},
            },
            "required": ["区分键", "SKU列表"],
        }
        parsed = form.parse_schema(schema)
        value = {"区分键": {"颜色": "默认色", "数量": 2432}, "SKU列表": [{"颜色": "红色", "数量": 2}]}
        effective = form.materialize_required_properties(parsed, value)
        item_schema = effective["properties"]["SKU列表"]["items"]
        self.assertEqual(item_schema["required"], ["颜色", "数量"])
        self.assertEqual({key: rule["type"] for key, rule in item_schema["properties"].items()},
                         {"颜色": "string", "数量": "integer"})
        self.assertEqual({key: rule["default"] for key, rule in item_schema["properties"].items()},
                         {"颜色": "默认色", "数量": 2432})
        view = form.context_for(effective).presentation(effective, value)
        row_view = view["properties"]["SKU列表"]["prefixItems"][0]
        self.assertEqual(set(row_view["properties"]), {"颜色", "数量"})
        self.assertEqual(set(row_view["required"]), {"颜色", "数量"})
        self.assertIn("x-requiredPropertiesFrom", row_view)
        self.assertEqual(form.validate_value(parsed, value)[1], [])

        missing = {"区分键": {"颜色": "默认色", "数量": 2432}, "SKU列表": [{"颜色": "红色"}]}
        self.assertTrue(form.validate_value(parsed, missing)[1])
        blank = {"区分键": {"颜色": "默认色", "数量": 2432}, "SKU列表": [{"颜色": "  ", "数量": 2}]}
        self.assertTrue(form.validate_value(parsed, blank)[1])
        wrong_type = {"区分键": {"颜色": "默认色", "数量": 2432}, "SKU列表": [{"颜色": "红色", "数量": "2"}]}
        self.assertTrue(form.validate_value(parsed, wrong_type)[1])

    def test_dynamic_string_input_modes_project_to_sku_schema_and_validate(self):
        schema = form.parse_schema({"type": "object", "properties": {
            "区分键": {"type": "object", "additionalProperties": True},
            "SKU列表": {"type": "array", "items": {"type": "object", "properties": {},
                "required": [], "additionalProperties": False,
                "x-requiredPropertiesFrom": {"pointer": "/区分键", "propertySchema": True}}}},
            "required": ["区分键", "SKU列表"]})
        value = {"区分键": {"主图": ""}, "SKU列表": [{"主图": ""}]}
        modes = {"/区分键/主图": "image"}
        projected = form.materialize_required_properties(schema, value, modes)
        item_schema = projected["properties"]["SKU列表"]["items"]["properties"]["主图"]
        self.assertEqual(item_schema["type"], "string")
        self.assertIn("x-image", item_schema)
        self.assertEqual(item_schema["default"], "")
        date_modes = {"/区分键/主图": "date"}
        date_value = {"区分键": {"主图": "2026-11-20"}, "SKU列表": [{"主图": "2026-11-20"}]}
        date_schema = form.materialize_required_properties(schema, date_value, date_modes)
        date_item = date_schema["properties"]["SKU列表"]["items"]["properties"]["主图"]
        self.assertEqual(date_item["format"], "date")
        self.assertEqual(form.validate_value(schema, date_value, date_modes)[1], [])
        invalid = {"区分键": {"主图": "2026-02-30"}, "SKU列表": [{"主图": "2026-02-30"}]}
        self.assertTrue(form.validate_value(schema, invalid, date_modes)[1])
        saved = {"schema": schema, "value": invalid, "input_types": date_modes, "confirmed": True}
        self.assertFalse(form.reusable(saved, schema))
        for mode, valid, bad in [("time", "12:30:59", "25:30"),
                                 ("date-time", "2026-11-20T12:30:00", "2026-02-30T12:00:00"),
                                 ("color", "#ABCDEF", "red")]:
            chosen = {"$/区分键/主图": mode}
            good = {"区分键": {"主图": valid}, "SKU列表": [{"主图": valid}]}
            wrong = {"区分键": {"主图": bad}, "SKU列表": [{"主图": bad}]}
            self.assertEqual(form.validate_value(schema, good, chosen)[1], [])
            self.assertEqual({e["path"] for e in form.validate_value(schema, wrong, chosen)[1]},
                             {"/区分键/主图", "/SKU列表/0/主图"})
        # Existing template constraints survive the added input format.
        schema["properties"]["SKU列表"]["items"]["x-requiredPropertiesFrom"]["propertySchema"] = {
            "type": "string", "pattern": "^red$"}
        self.assertTrue(form.validate_value(schema, date_value, date_modes)[1])

    def test_dynamic_property_rule_rejects_invalid_pointer_definition(self):
        schema = {"type": "array", "items": {"type": "object", "x-requiredPropertiesFrom": {"pointer": "keys"}}}
        with self.assertRaisesRegex(ValueError, "x-requiredPropertiesFrom"):
            form.parse_schema(schema)

    def test_system_file_picker_stays_topmost_without_selection_timeout(self):
        with patch.object(form.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')) as run:
            self.assertIsNone(form.system_form_file('choose'))
            script = run.call_args.args[0][-1]
            self.assertIn('$owner.TopMost = $true', script)
            self.assertIn('$dialog.ShowDialog($owner)', script)
            self.assertIn('$owner.Dispose()', script)
            self.assertIsNone(run.call_args.kwargs['timeout'])
        with patch.object(form.subprocess, 'run', side_effect=form.subprocess.TimeoutExpired('powershell', 15)):
            with self.assertRaisesRegex(ValueError, '15 秒'):
                form.system_form_file('clipboard')

    def test_file_encoding_boundary_and_real_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.bin"
            path.write_bytes(b"a" * (512 * 1024 - 1))
            result = form.encode_form_file(path)
            self.assertEqual(result["encoding"], "base64")
            self.assertEqual(result["display"], str(path.resolve()))
            self.assertEqual(form.base64.b64decode(result["value"]), path.read_bytes())
            path.write_bytes(b"b" * (512 * 1024))
            self.assertEqual(form.encode_form_file(path)["value"], str(path.resolve()))
            self.assertEqual(form.encode_form_file(path, "base64")["encoding"], "base64")
            path.write_bytes(b"")
            self.assertEqual(form.encode_form_file(path)["value"], "")
            self.assertEqual(form.encode_form_file(path, "link")["encoding"], "link")
            form.SELECTED_FORM_FILES.discard(path.resolve())
        schema = {"type": "string", "x-file": {}}
        self.assertEqual(form.context_for(schema).presentation(schema, "")["x-file"], {})

    def test_image_annotations_survive_presentation_without_becoming_fields(self):
        image = {'type': 'string', 'x-image': {'source': 'base64'},
                 'contentMediaType': 'image/png', 'contentEncoding': 'base64'}
        schema = {'type': 'object', '$defs': {'image': image},
                  'properties': {'photo': {'$ref': '#/$defs/image'}},
                  'required': ['photo'], 'additionalProperties': False}
        value = {'photo': 'YWJj'}
        view = form.context_for(schema).presentation(schema, value)
        for key in ('x-image', 'contentMediaType', 'contentEncoding'):
            self.assertEqual(view['properties']['photo'][key], image[key])
        _, errors = form.validate_value(schema, value)
        self.assertEqual(errors, [])
        self.assertEqual(list(value), ['photo'])

    def test_inline_display_names_preserve_card_message_and_machine_paths(self):
        member = {'type': 'object', 'properties': {'make': {
            'type': 'string', 'enum': ['skip', 'make'], 'title': 'Make this time'}}, 'required': ['make']}
        scope = {'type': 'object', 'title': 'Production scope', 'properties': {
            'hero': {**member, 'title': 'Hero image'}, 'detail': {**member, 'title': 'Detail page'}},
            'required': ['hero', 'detail'], 'not': {'properties': {
                'hero': {'properties': {'make': {'const': 'skip'}}, 'required': ['make']},
                'detail': {'properties': {'make': {'const': 'skip'}}, 'required': ['make']}},
                'required': ['hero', 'detail']}}
        schema = {'type': 'object', '$defs': {'scope': scope},
                  'properties': {'scope': {'$ref': '#/$defs/scope'}}, 'required': ['scope']}
        value = {'scope': {'hero': {'make': 'skip'}, 'detail': {'make': 'skip'}}}
        _, errors = form.validate_value(schema, value)
        error = next(e for e in errors if e['rule'] == 'not')
        self.assertEqual(error['path'], '/scope')
        self.assertIn('scope.hero.make', error['message'])
        self.assertIn('Production scope.Hero image.Make this time', error['display_message'])
        self.assertIn('Production scope.Detail page.Make this time', error['display_message'])
        self.assertNotIn('scope.hero.make', error['display_message'])
        scope['x-error-message'] = 'Keep literal scope.hero.make supplied by author.'
        schema['$defs']['scope'] = scope
        _, errors = form.validate_value(schema, value)
        self.assertEqual(errors[0]['message'], scope['x-error-message'])
        self.assertEqual(errors[0]['display_message'], scope['x-error-message'])

    def test_author_messages_override_text_only_and_preserve_validation_metadata(self):
        schema = {'type': 'object', 'properties': {'name': {'type': 'string', 'minLength': 1,
                  'x-error-message': '请填写项目名称。'}}, 'required': ['name']}
        self.assertEqual(form.parse_schema(schema), schema)
        error = form.validate_value(schema, {'name': ''})[1][0]
        self.assertEqual(error['message'], '请填写项目名称。')
        self.assertEqual(error['path'], '/name')
        self.assertEqual(error['rule'], 'minLength')
        self.assertIn('technical_message', error)
        self.assertEqual(form.validate_value(schema, {'name': 'ok'})[1], [])
        self.assertFalse(form.Draft202012Validator(schema).is_valid({'name': ''}))
        bare = json.loads(json.dumps(schema))
        del bare['properties']['name']['x-error-message']
        self.assertEqual(form.schema_structure(schema), form.schema_structure(bare))

    def test_author_message_rule_map_fallback_and_scope(self):
        schema = {'type': 'string', 'minLength': 2, 'maxLength': 4,
                  'x-error-message': {'minLength': '太短，请至少写两个字。', 'default': '请检查文字。'}}
        self.assertEqual(form.validate_value(schema, '')[1][0]['message'], '太短，请至少写两个字。')
        self.assertEqual(form.validate_value(schema, '12345')[1][0]['message'], '请检查文字。')
        schema['x-error-message'] = {'minLength': '  ', 'default': 7}
        self.assertIn('至少 2 个字符', form.validate_value(schema, '')[1][0]['message'])
        parent = {'type': 'object', 'x-error-message': '父对象错误', 'properties': {'child': schema}}
        self.assertNotEqual(form.validate_value(parent, {'child': ''})[1][0]['message'], '父对象错误')
        referenced = {'$defs': {'field': {'minLength': 1, 'x-error-message': '引用字段不能为空'}},
                      'properties': {'child': {'$ref': '#/$defs/field'}}}
        self.assertEqual(form.validate_value(referenced, {'child': ''})[1][0]['message'], '引用字段不能为空')
        combined = {'anyOf': [{'type': 'string'}, {'type': 'number'}],
                    'x-error-message': {'anyOf': '这里只能填写文字或数值'}}
        self.assertEqual(form.validate_value(combined, None)[1][0]['message'], '这里只能填写文字或数值')

    def test_author_message_is_schema_metadata_not_a_closed_object_property(self):
        schema = {'type': 'object', 'additionalProperties': False, 'required': ['name'],
                  'x-error-message': {'additionalProperties': '不能添加其他字段'},
                  'properties': {'name': {'type': 'string', 'minLength': 1, 'x-error-message': '请填写名称'}}}
        form.parse_schema(schema)
        value = {'name': 'ok'}
        result, errors = form.validate_value(schema, value)
        self.assertEqual(result, value)
        self.assertEqual(errors, [])
        self.assertTrue(form.Draft202012Validator(schema).is_valid(value))
        # If metadata accidentally leaks into the result, normal closed-object validation rejects it.
        leaked = {**value, 'x-error-message': 'must not leak'}
        self.assertFalse(form.Draft202012Validator(schema).is_valid(leaked))
        self.assertEqual(form.validate_value(schema, leaked)[1][0]['message'], '不能添加其他字段')

    def test_forbidden_enum_conjunction_reports_paths_values_and_valid_alternatives(self):
        names = ['banner', 'detail', 'sku']
        field = {'type': 'object', 'properties': {'status': {'enum': ['waiting', 'ready', 'skip']}}, 'required': ['status']}
        blocked = {'type': 'object', 'properties': {'status': {'enum': ['waiting', 'skip']}}, 'required': ['status']}
        section = {'type': 'object', 'properties': {name: field for name in names}, 'required': names,
                   'not': {'type': 'object', 'properties': {name: blocked for name in names}, 'required': names}}
        schema = {'type': 'object', 'properties': {'output': section}, 'required': ['output']}
        value = {'output': {name: {'status': 'waiting'} for name in names}}
        message = form.validate_value(schema, value)[1][0]['message']
        self.assertIn('至少将以下字段中的一个设为 "ready"', message)
        for name in names:
            self.assertIn(f'output.{name}.status', message)
            changed = json.loads(json.dumps(value))
            changed['output'][name]['status'] = 'ready'
            self.assertEqual(form.validate_value(schema, changed)[1], [])
        self.assertIn('waiting', message)
        # Another forbidden constraint must not be silently discarded by repair inference.
        section['not']['maxProperties'] = 3
        message = form.validate_value(schema, value)[1][0]['message']
        self.assertNotIn('至少将以下字段', message)
        self.assertIn('至多 3 个字段', message)
        self.assertIn('output.banner.status', message)

    def test_forbidden_enum_values_distinguish_boolean_and_number(self):
        schema = {'enum': [True, 1, False], 'not': {'const': True}}
        message = form.validate_value(schema, True)[1][0]['message']
        self.assertIn('1、false', message)
        self.assertEqual(form.validate_value(schema, 1)[1], [])
        self.assertEqual(form.validate_value(schema, False)[1], [])

    def test_optional_fields_do_not_get_a_required_value_repair(self):
        schema = {'type': 'object', 'properties': {'flag': {'enum': ['on', 'off']}},
                  'not': {'type': 'object', 'properties': {'flag': {'const': 'off'}}, 'required': ['flag']}}
        message = form.validate_value(schema, {'flag': 'off'})[1][0]['message']
        self.assertNotIn('至少将以下字段', message)
        self.assertIn('flag等于 "off"', message)
        self.assertEqual(form.validate_value(schema, {})[1], [])

    def test_template_cache_sink_validates_without_waiting_for_form(self):
        node = form.LiuxinyuTemplateSchemaCache
        schema = node.define_schema()
        self.assertTrue(schema.is_dev_only)
        self.assertTrue(schema.is_output_node)
        self.assertEqual(schema.outputs, [])
        result = node.execute('{"type":"string","default":"updated"}')
        self.assertEqual(result.ui, {"lxy_template_schema": [{"type": "string", "default": "updated"}]})
        for invalid in ['false', '{', '{"type":"unknown"}']:
            with self.assertRaises(ValueError):
                node.execute(invalid)

    def test_referenced_closed_objects_do_not_offer_extra_fields(self):
        closed = {'type': 'object', 'properties': {'name': {'type': 'string'}}, 'additionalProperties': False}
        for wrapper in [{'$ref': '#/$defs/item'}, {'allOf': [{'$ref': '#/$defs/item'}]}]:
            schema = {'type': 'array', '$defs': {'item': closed}, 'items': {**wrapper, 'title': 'Item'}}
            view = form.context_for(schema).presentation(schema, [{'name': 'saved'}])
            self.assertIs(view['prefixItems'][0]['additionalProperties'], False)
            self.assertIs(view['items']['additionalProperties'], False)
        open_schema = {'$defs': {'item': {**closed, 'additionalProperties': True}}, '$ref': '#/$defs/item'}
        self.assertIsNot(form.context_for(open_schema).presentation(open_schema, {}).get('additionalProperties'), False)

    def test_type_backup_obeys_actual_extra_property_rules(self):
        base = {'type': 'object', 'properties': {'name': {'type': 'string', 'minLength': 1}}, 'required': ['name']}
        candidate = [{'path': '$', 'key': 'name', 'value': 12}]
        cases = [({}, True), ({'additionalProperties': False}, False),
                 ({'additionalProperties': {'type': 'integer'}}, True),
                 ({'additionalProperties': {'type': 'string'}}, False),
                 ({'unevaluatedProperties': False}, False),
                 ({'additionalProperties': False, 'patternProperties': {'_备份[0-9]+$': {'type': 'integer'}}}, True),
                 ({'propertyNames': {'pattern': '^[a-z]+$'}}, False),
                 ({'maxProperties': 1}, False)]
        for extra, kept in cases:
            with self.subTest(extra=extra):
                result, decisions = form.insert_type_backups({**base, **extra}, {'name': ''}, candidate)
                self.assertEqual(decisions[0]['kept'], kept)
                self.assertEqual('name_备份1' in result, kept)
                self.assertEqual(result['name'], '')
                self.assertEqual(form.validate_value({**base, **extra}, result)[1][0]['rule'], 'minLength')
        # A ref/allOf must not be approximated by a UI-derived additionalProperties flag.
        schema = {'$defs': {'fields': base}, 'allOf': [{'$ref': '#/$defs/fields'}], 'unevaluatedProperties': False}
        self.assertFalse(form.insert_type_backups(schema, {'name': ''}, candidate)[1][0]['kept'])

    def test_type_backup_names_are_unique_adjacent_and_work_inside_arrays(self):
        schema = {'type': 'object', 'properties': {'rows': {'type': 'array', 'items': {
            'type': 'object', 'properties': {'value': {'type': 'string'}, 'value_备份2': {'type': 'integer'}}}}}}
        value = {'rows': [{'value': '', 'after': True, 'value_备份1': 9}]}
        candidates = [{'path': '$/rows/0', 'key': 'value', 'value': 12}]
        result, decisions = form.insert_type_backups(schema, value, candidates)
        self.assertEqual(decisions[0]['key'], 'value_备份3')
        self.assertEqual(list(result['rows'][0])[:2], ['value', 'value_备份3'])
        self.assertEqual(result['rows'][0]['value_备份3'], 12)
        self.assertNotIn('value_备份3', value['rows'][0])

    def test_notification_uri_restricts_activation_to_local_backend_and_random_token(self):
        token = 'a' * 32
        self.assertEqual(notifications.activation_target(f'comfyui-liuxinyu-form://activate/8188/{token}'), ('http://127.0.0.1:8188', token))
        for uri in ['https://evil.example/', f'comfyui-liuxinyu-form://other/8188/{token}',
                    f'comfyui-liuxinyu-form://activate/70000/{token}', 'comfyui-liuxinyu-form://activate/8188/a;bad']:
            with self.assertRaises(ValueError):
                notifications.activation_target(uri)

    def test_activation_prefers_existing_page_and_only_then_opens_new_tab(self):
        token = 'a' * 32
        from io import BytesIO
        for response, focus, opens in [({'focused': True}, False, False),
                                        ({'existing': True, 'title': 'marker'}, True, False),
                                        ({'existing': True, 'title': 'marker'}, False, True),
                                        ({'existing': False}, False, True)]:
            with patch.object(notifications.urllib.request, 'urlopen', return_value=BytesIO(json.dumps(response).encode())), \
                 patch.object(notifications, 'focus_window', return_value=focus), \
                 patch.object(notifications.webbrowser, 'open') as opened:
                notifications.activate(f'comfyui-liuxinyu-form://activate/8188/{token}')
                self.assertEqual(opened.called, opens)
                if opens:
                    opened.assert_called_once_with(f'http://127.0.0.1:8188/#lxy-form={token}', new=2)

    def test_schema_and_value_types(self):
        info = form.LiuxinyuTemplateForm.GET_NODE_INFO_V1()
        self.assertEqual(info['input']['required']['schema'][0], 'STRING')
        self.assertTrue(info['input']['required']['schema'][1]['forceInput'])
        self.assertNotIn('default', info['input']['required']['schema'][1])
        self.assertEqual(info['output'], ['DICT,ARRAY,STRING,INT,FLOAT,BOOLEAN,NULL'])
        self.assertEqual(info['output_is_list'], [False])
        self.assertTrue(info['input']['required']['form_state'][1]['socketless'])
        for schema, value in [({'type': 'array'}, [[1], [2]]), ({'type': 'object'}, {'x': None}),
                              ({'type': 'integer'}, 3), ({'type': 'null'}, None), (True, 'x')]:
            self.assertEqual(form.validate_value(form.parse_schema(schema), value), (value, []))
        for invalid in [[], 1, 'bad', {'type': 'wrong'}, {'$schema': 'http://json-schema.org/draft-07/schema'}]:
            with self.subTest(schema=invalid), self.assertRaises(ValueError):
                form.parse_schema(invalid)
        self.assertTrue(form.validate_value(False, None)[1])
        self.assertTrue(form.validate_value({'type': 'integer'}, True)[1])

    def test_real_constraints_and_error_paths(self):
        schema = form.parse_schema({'type': 'object', 'required': ['count', 'date', 'items'], 'additionalProperties': False,
            'properties': {'count': {'type': 'integer', 'minimum': 1, 'maximum': 5},
                           'date': {'type': 'string', 'format': 'date'},
                           'items': {'type': 'array', 'items': {'type': 'number'}, 'uniqueItems': True, 'minItems': 1}}})
        result, errors = form.validate_value(schema, {'count': 0, 'date': '2026-02-30', 'items': [1, 1], 'extra': True})
        self.assertEqual({e['rule'] for e in errors}, {'additionalProperties', 'minimum', 'uniqueItems'})
        self.assertEqual(form.validate_value(schema, {'count': 3, 'date': '2026-11-16', 'items': [1, 2]})[1], [])
        self.assertFalse(form.validate_value({'type': 'string', 'format': 'date-time'}, '2026-11-16T12:00:00')[1])
        self.assertEqual(form.validate_value({'type': 'string', 'format': 'time'}, '12:00:00Z')[1], [])
        self.assertFalse(form.validate_value({'type': 'number', 'multipleOf': .1}, .3)[1])
        self.assertFalse(form.validate_value({'type': 'number', 'multipleOf': 1e-100}, 1)[1])
        self.assertTrue(form.validate_value({'type': 'number', 'multipleOf': .1}, .31)[1])

    def test_chinese_validation_explanations_and_human_locations(self):
        cases = [
            ({'type': 'string', 'minLength': 1}, '', '不能为空'),
            ({'type': 'string', 'pattern': r'\S'}, '  ', '非空白字符'),
            ({'type': 'object', 'minProperties': 1}, {}, '添加字段'),
            ({'type': 'array', 'minItems': 2}, [], '至少需要 2 项'),
            ({'type': 'array', 'maxItems': 1}, [1, 2], '最多允许 1 项'),
            ({'type': 'integer'}, 'x', '当前是文字'),
            ({'type': 'number', 'minimum': 3}, 2, '大于或等于 3'),
            ({'type': 'number', 'exclusiveMaximum': 3}, 3, '小于 3'),
            ({'type': 'number', 'multipleOf': 2}, 3, '2 的整数倍'),
            ({'enum': ['甲', '乙']}, '丙', '请选择'),
            ({'const': 2}, 3, '固定值 2'),
            ({'type': 'array', 'uniqueItems': True}, [1, 1], '重复项'),
            ({'type': 'object', 'required': ['甲', '乙']}, {}, '缺少必填字段：甲、乙'),
            ({'additionalProperties': False}, {'甲': 1}, '请移除这些字段'),
            ({'dependentRequired': {'甲': ['乙']}}, {'甲': 1}, '还需填写乙'),
            ({'anyOf': [{'type': 'number'}, {'type': 'boolean'}]}, 'x', '不符合任何可选结构'),
            ({'oneOf': [{'type': 'number'}, {'minimum': 0}]}, 1, '同时符合多个结构'),
            ({'not': {'type': 'number'}}, 1, '当前值必须是数值'),
            ({'type': 'array', 'contains': {'type': 'number'}, 'minContains': 2}, ['x'], '至少 2 项'),
            ({'type': 'array', 'items': False}, [1], '额外条目'),
            (False, 'x', '不允许此处存在任何值'),
        ]
        for schema, value, expected in cases:
            with self.subTest(schema=schema):
                errors = form.validate_value(schema, value)[1]
                self.assertTrue(errors)
                self.assertIn(expected, errors[0]['message'])
                self.assertIn('technical_message', errors[0])
                self.assertNotIn('should', errors[0]['message'])
        schema = {'type': 'array', 'items': {'properties': {'配置名称': {'minLength': 1}}, 'required': ['配置名称']}}
        error = form.validate_value(schema, [{'配置名称': ''}])[1][0]
        self.assertEqual(error['path'], '/0/配置名称')
        self.assertEqual(error['location'], '第 1 项 → 配置名称')
        self.assertEqual(error['field'], '配置名称')
        errors = form.validate_value({'required': ['甲', '乙']}, {})[1]
        self.assertEqual(len(errors), 1)

    def test_annotations_and_nonasserting_keywords(self):
        for schema in [{'type': 'string', 'format': 'unknown'}, {'properties': {'x': {'type': 'integer'}}},
                       {'format': 'date'}, {'minimum': 1}, {'$vocabulary': {'https://example.com/custom': True}}]:
            parsed = form.parse_schema(schema)
            self.assertEqual(form.validate_value(parsed, 'arbitrary string')[1], [])
        form.parse_schema({'type': 'number', 'maximum': 10**100})

    def test_presentation_combinations_conditions_and_dependencies(self):
        schema = {'type': 'object', 'properties': {'kind': {'enum': ['a', 'b']}},
                  'allOf': [{'properties': {'n': {'type': 'number', 'minimum': 2}}},
                            {'properties': {'n': {'maximum': 9}}}],
                  'if': {'properties': {'kind': {'const': 'a'}}, 'required': ['kind']},
                  'then': {'properties': {'a': {'type': 'string'}}, 'required': ['a']},
                  'else': {'properties': {'b': {'type': 'boolean'}}},
                  'dependentSchemas': {'n': {'properties': {'extra': {'type': 'integer'}}}},
                  'dependentRequired': {'n': ['extra']},
                  'patternProperties': {'^tag_': {'type': 'string'}}}
        context = form.context_for(form.parse_schema(schema))
        view = context.presentation(schema, {'kind': 'a', 'n': 3, 'tag_x': 'yes'})
        self.assertEqual(view['properties']['n']['minimum'], 2)
        self.assertEqual(view['properties']['n']['maximum'], 9)
        self.assertEqual(view['properties']['tag_x']['type'], 'string')
        self.assertIn('a', view['required'])
        self.assertIn('extra', view['required'])
        self.assertNotIn('b', view['properties'])
        other = context.presentation(schema, {'kind': 'b'})
        self.assertIn('b', other['properties'])
        self.assertNotIn('a', other['properties'])
        self.assertNotIn('extra', other['properties'])

    def test_reference_scope_anchor_recursion_and_external_resources(self):
        schema = {'$id': 'https://example.test/root', '$defs': {
            'record': {'$id': 'record', '$anchor': 'entry', 'type': 'object',
                       'properties': {'n': {'type': 'integer'}, 'child': {'$ref': '#entry'}}}},
                  '$ref': 'record#entry'}
        context = form.context_for(form.parse_schema(schema))
        view = context.presentation(schema, {'n': 1, 'child': {'n': 2}})
        self.assertEqual(view['properties']['child']['properties']['n']['type'], 'integer')
        self.assertFalse(form.validate_value(schema, {'n': 1, 'child': {'n': 2}})[1])
        self.assertTrue(form.validate_value(schema, {'n': 1, 'child': {'n': 'wrong'}})[1])
        external = {'$ref': 'https://example.test/external', 'maximum': 4}
        response = SimpleNamespace(read=lambda limit: b'{"type":"integer","minimum":2}')
        class Response:
            def __enter__(self): return response
            def __exit__(self, *args): pass
        form.schema_context.cache_clear()
        with patch.object(form, 'urlopen', return_value=Response()) as fetch:
            self.assertFalse(form.validate_value(external, 3)[1])
            self.assertTrue(form.validate_value(external, 1)[1])
            view = form.context_for(external).presentation(external, 3)
            self.assertEqual((view['minimum'], view['maximum']), (2, 4))
            self.assertEqual(fetch.call_count, 1)

    def test_presentation_preserves_validation_for_branches_and_unrendered_rules(self):
        schema = {'type': 'object', 'properties': {'common': {'type': 'integer'}},
                  'oneOf': [{'properties': {'a': {'type': 'string'}}, 'required': ['a']},
                            {'properties': {'b': {'type': 'boolean'}}, 'required': ['b']}],
                  'unevaluatedProperties': False}
        view = form.context_for(schema).presentation(schema, {'common': 1, 'a': 'yes'})
        self.assertIn('common', view['oneOf'][0]['properties'])
        self.assertIn('a', view['oneOf'][0]['properties'])
        self.assertFalse(form.validate_value(schema, {'common': 1, 'a': 'yes'})[1])
        self.assertTrue(form.validate_value(schema, {'common': 1, 'a': 'yes', 'b': True})[1])
        self.assertIs(form.context_for(False).presentation(False, None), False)

    def test_dynamic_reference_and_array_applicators_keep_original_semantics(self):
        schema = {'$id': 'https://example.test/strict', '$dynamicAnchor': 'node',
                  '$defs': {'tree': {'$id': 'tree', '$dynamicAnchor': 'node', 'type': 'object',
                                    'properties': {'data': True, 'children': {'type': 'array', 'items': {'$dynamicRef': '#node'}}}}},
                  '$ref': 'tree', 'unevaluatedProperties': False}
        value = {'data': 'parent', 'children': [{'data': 'child'}]}
        self.assertFalse(form.validate_value(schema, value)[1])
        self.assertTrue(form.validate_value(schema, {'children': [{'unexpected': 1}]})[1])
        view = form.context_for(schema).presentation(schema, value)
        child = view['properties']['children']['prefixItems'][0]
        self.assertIn('data', child['properties'])
        arrays = {'type': 'array', 'prefixItems': [{'const': 'header'}],
                  'contains': {'type': 'integer'}, 'minContains': 1, 'maxContains': 1,
                  'unevaluatedItems': False}
        self.assertFalse(form.validate_value(arrays, ['header', 2])[1])
        self.assertTrue(form.validate_value(arrays, ['header', 2, 'extra'])[1])
        self.assertEqual(form.context_for(arrays).presentation(arrays, ['header', 2])['prefixItems'][0]['const'], 'header')

    def test_unavailable_reference_is_an_explicit_failure_not_valid_or_silently_ignored(self):
        schema = form.parse_schema({'$ref': 'https://example.test/unavailable'})
        form.schema_context.cache_clear()
        with patch.object(form, 'urlopen', side_effect=TimeoutError('unavailable')):
            with self.assertRaisesRegex(ValueError, '校验无法完成'):
                form.validate_value(schema, {})

    def test_draft_202012_refs_combinations_and_unevaluated(self):
        schema = form.parse_schema({'$defs': {'n': {'type': 'integer', 'minimum': 2}}, 'type': 'array',
                                    'prefixItems': [{'$ref': '#/$defs/n'}, {'type': 'string'}], 'items': False})
        self.assertFalse(form.validate_value(schema, [2, 'a'])[1])
        self.assertTrue(form.validate_value(schema, [1, 'a', 3])[1])
        schema = form.parse_schema({'type': 'object', 'allOf': [{'properties': {'a': {'type': 'integer'}}}],
            'if': {'required': ['a']}, 'then': {'required': ['b'], 'properties': {'b': {'const': True}}}, 'unevaluatedProperties': False})
        self.assertFalse(form.validate_value(schema, {'a': 1, 'b': True})[1])
        self.assertTrue(form.validate_value(schema, {'a': 1})[1])
        self.assertTrue(form.validate_value({'oneOf': [{'type': 'number'}, {'type': 'integer'}]}, 1)[1])
        with self.assertRaisesRegex(ValueError, '校验无法完成'):
            form.validate_value({'$ref': '#/$defs/missing'}, {})
        # A $ref in a default is ordinary user data, not a schema reference.
        form.parse_schema({'type': 'object', 'default': {'$ref': 'not-a-schema'}})

    def test_json_values_preserve_types_and_reject_unsafe_data(self):
        for value in [float('nan'), float('inf'), 2**53, 10**500, (1,), {1: 2}]:
            with self.subTest(value=type(value)), self.assertRaises(ValueError):
                form.json_copy(value)
        value = {'__proto__': {'a': 1}, 'constructor': True, 'items': [None, 2]}
        result = form.json_copy(value)
        self.assertEqual(result, value)
        self.assertIsNot(result['items'], value['items'])


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_import_wins_over_confirmed_draft_and_validates_without_wait(self):
        schema = {'type': 'integer', 'minimum': 1}
        state = json.dumps({'schema': schema, 'value': 9, 'confirmed': True})
        with self.assertRaises(ValueError):await self.node.execute(schema,state,values_json='0')
        self.assertEqual((await self.node.execute(schema,state,values_json='2')).result,(2,))
        self.assertFalse(form.PENDING)

    async def test_file_source_sync_preserves_wrapper_and_rejects_external_changes(self):
        schema={'type':'integer','minimum':1}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'source.json'
            path.write_text(json.dumps({'$format':'liuxinyu.template-values/v1','schema':schema,'value':3}),encoding='utf-8')
            source=form.read_values_source(schema,sync_file=str(path))
            form.write_synced_values({'sync_token':source['sync_token'],'value':4})
            self.assertEqual(json.loads(path.read_text())['value'],4)
            self.assertEqual((await self.node.execute(schema,sync_file=str(path))).result,(4,))
            path.write_text('5')
            with self.assertRaises(ValueError):form.write_synced_values({'sync_token':source['sync_token'],'value':6})
            self.assertEqual(path.read_text(),'5')
            with self.assertRaises(ValueError):form.read_values_source(schema,'3',str(path))
            plain=form.read_values_source(schema,sync_file=str(path))
            form.write_synced_values({'sync_token':plain['sync_token'],'value':7})
            self.assertEqual(json.loads(path.read_text()),7)

    async def test_save_values_dialog_write_and_cancel(self):
        class Request:
            content_type = 'application/json'
            async def json(self):
                return {'schema': {'type': 'object'}, 'value': {'name': '中文\n资料'}, 'input_types': {'$/name': 'string'}}
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / '配置.json')
            with patch.object(form, 'system_form_file', return_value=path) as dialog:
                response = await form.save_form_values(Request())
            self.assertEqual(response.status, 200)
            dialog.assert_called_once_with('save-values')
            saved = json.loads(Path(path).read_text(encoding='utf-8'))
            self.assertEqual(saved['value'], {'name': '中文\n资料'})
            self.assertEqual(form.parse_form_values(saved, saved['schema'])['input_types'], {'$/name': 'string'})
            with patch.object(form, 'system_form_file', return_value=None):
                response = await form.save_form_values(Request())
            self.assertEqual(json.loads(response.body), {'cancelled': True})

    async def asyncSetUp(self):
        self.events = []
        self.server = SimpleNamespace(client_id='test-client', send_sync=lambda *args: self.events.append(args))
        self.patch = patch.object(form.PromptServer, 'instance', self.server, create=True)
        self.patch.start()
        self.notification_patch = patch.object(form, 'dispatch_notification')
        self.notification_mock = self.notification_patch.start()
        self.node = type('TestForm', (form.LiuxinyuTemplateForm,), {})
        graph = DynamicPrompt({'11:22': {'class_type': 'LiuxinyuTemplateForm', 'inputs': {}}})
        graph.add_ephemeral_node('expanded', {}, '11:22', '11:22')
        self.node.hidden = SimpleNamespace(unique_id='expanded', dynprompt=graph, extra_pnginfo={'workflow': {'id': 'workflow-test'}})

    async def asyncTearDown(self):
        for record in form.NOTICES.values():
            record['task'].cancel()
        form.NOTICES.clear()
        form.PAGES.clear()
        self.notification_patch.stop()
        self.patch.stop()
        self.assertEqual(form.PENDING, {})

    async def test_native_notification_foreground_suppression_and_single_dispatch(self):
        entry = {'request_id': 'a'*32, 'workflow_id': 'workflow-test', 'node_id': '11:22'}
        form.register_notice(entry, {'id': 'workflow-test'}, 'test-client')
        async def payload():
            return {'client_id': 'test-client', 'workflow_id': 'workflow-test', 'request_id': entry['request_id'], 'foreground': True}
        await form.notice_presence(SimpleNamespace(json=payload))
        record = form.NOTICES[entry['request_id']]
        await form.send_notice(record)
        self.notification_mock.assert_not_called()
        record['foreground'] = False
        await form.send_notice(record)
        await form.send_notice(record)
        self.notification_mock.assert_called_once()
        self.assertIn('comfyui-liuxinyu-form://activate/8188/', self.notification_mock.call_args.args[2])
        await form.close_notice(entry['request_id'])
        self.assertTrue(record['closed'])

    async def test_activation_routes_only_to_connected_matching_workflow(self):
        token = 'a'*32
        form.register_notice({'request_id': token, 'workflow_id': 'workflow-test', 'node_id': '11:22'}, {'id': 'workflow-test'}, 'test-client')
        form.PAGES.update({'wrong': 'other', 'closed': 'workflow-test', 'test-client': 'workflow-test'})
        self.server.sockets = {'wrong': object(), 'test-client': object()}
        def send(event, detail, client):
            self.assertEqual(client, 'test-client')
            future = form.ACTIVATIONS[detail['activation_id']][1]
            future.set_result({'existing': True, 'focused': True})
        self.server.send_sync = send
        result = await form.activate_notice(SimpleNamespace(match_info={'token': token}))
        self.assertTrue(json.loads(result.body)['focused'])
        self.assertFalse(form.ACTIVATIONS)

    async def waiting(self, task):
        for _ in range(30):
            await asyncio.sleep(0.01)
            if form.PENDING:
                return next(iter(form.PENDING))
            if task.done():
                task.result()
        self.fail('No pending form')

    async def test_wait_validate_submit_and_single_use_token(self):
        schema = {'type': 'array', 'items': {'type': 'integer'}, 'minItems': 1}
        draft = json.dumps({'schema': schema, 'value': [1, 2]})
        task = asyncio.create_task(self.node.execute(schema, draft))
        token = await self.waiting(task)
        self.assertFalse(task.done(), 'Saved draft is not approval')
        entry = form.PENDING[token]
        self.assertEqual(entry['node_id'], '11:22')
        self.assertEqual(entry['workflow_id'], 'workflow-test')
        self.assertEqual(entry['value'], [1, 2])
        self.assertTrue(form.submit(token, ['wrong']))
        self.assertFalse(entry['done'])
        self.assertEqual(form.submit(token, [3, 4]), [])
        with self.assertRaises(KeyError):
            form.submit(token, [5])
        result = await asyncio.wait_for(task, 1)
        self.assertEqual(result.result, ([3, 4],))
        with self.assertRaises(KeyError):
            form.submit(token, [5])
        self.assertEqual(self.events[-1][0], 'liuxinyu.template_form_done')

    async def test_cancel_and_task_cancellation_cleanup(self):
        task = asyncio.create_task(self.node.execute({'type': 'object'}))
        token = await self.waiting(task)
        form.submit(token, cancel=True)
        with self.assertRaises(form.InterruptProcessingException):
            await task
        task = asyncio.create_task(self.node.execute({'type': 'string'}))
        await self.waiting(task)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_confirmed_reuse_revalidates_and_structure_changes_wait(self):
        schema = {'type': 'object', 'properties': {'n': {'type': 'integer', 'minimum': 1}}}
        state = json.dumps({'schema': schema, 'value': {'n': 3}, 'confirmed': True})
        relaxed = {'description': 'new help', 'type': 'object', 'properties': {'n': {'type': 'integer', 'minimum': 0}}}
        result = await asyncio.wait_for(self.node.execute(relaxed, state), 1)
        self.assertEqual(result.result, ({'n': 3},))
        self.assertEqual(self.events[-1][0], 'liuxinyu.template_form_reused')
        self.assertIn('schema', self.events[-1][1])
        self.assertIn('value', self.events[-1][1])
        for changed in [
            {'type': 'object', 'properties': {'n': {'type': 'integer', 'minimum': 4}}},
            {'type': 'object', 'properties': {'n': {'type': 'integer'}, 'optional': {'type': 'string'}}},
            {'type': 'object', 'properties': {'n': {'type': 'number', 'minimum': 1}}},
        ]:
            task = asyncio.create_task(self.node.execute(changed, state))
            token = await self.waiting(task)
            self.assertFalse(task.done())
            self.assertEqual(form.PENDING[token]['value'], {'n': 3})
            form.submit(token, cancel=True)
            with self.assertRaises(form.InterruptProcessingException):
                await task
        # Constraint names used as user field names must not be stripped.
        self.assertNotEqual(form.schema_structure({'properties': {'minimum': {'type': 'number'}}}),
                            form.schema_structure({'properties': {}}))

    async def test_loop_reuses_only_same_prompt_node_and_snapshot(self):
        schema = {'type': 'integer'}
        with CurrentNodeContext('reuse-prompt', 'expanded'):
            task = asyncio.create_task(self.node.execute(schema))
            token = await self.waiting(task)
            form.submit(token, 7)
            await task
            self.assertEqual((await self.node.execute(schema)).result, (7,))
        for prompt_id, draft in [('another-prompt', '{}'), ('reuse-prompt', json.dumps({'schema': schema, 'value': 8, 'confirmed': False}))]:
            with CurrentNodeContext(prompt_id, 'expanded'):
                task = asyncio.create_task(self.node.execute(schema, draft))
                token = await self.waiting(task)
                form.submit(token, cancel=True)
                with self.assertRaises(form.InterruptProcessingException):
                    await task

    async def test_each_execution_item_has_its_own_confirmation(self):
        tasks = [asyncio.create_task(self.node.execute({'type': kind})) for kind in ['string', 'integer']]
        for _ in range(30):
            if len(form.PENDING) == 2:
                break
            await asyncio.sleep(.01)
        self.assertEqual(len(form.PENDING), 2)
        for token, entry in list(form.PENDING.items()):
            form.submit(token, 'text' if entry['schema']['type'] == 'string' else 4)
        self.assertEqual([result.result[0] for result in await asyncio.gather(*tasks)], ['text', 4])

    async def test_native_executor_normalization_and_list_semantics(self):
        # Use the real V3 EXECUTE_NORMALIZED wrapper, including locked hidden context.
        original = self.node.hidden
        task = asyncio.create_task(execution._async_map_node_over_list(
            'form-test', 'expanded', self.node, {'schema': ['{"type":"array","items":{"type":"integer"}}'], 'form_state': ['{}']},
            self.node.FUNCTION, v3_data={'hidden_inputs': {
                io.Hidden.unique_id: original.unique_id, io.Hidden.dynprompt: original.dynprompt,
                io.Hidden.extra_pnginfo: original.extra_pnginfo,
            }}))
        token = await self.waiting(task)
        form.submit(token, [1, 2])
        results = await task
        result = await results[0] if isinstance(results[0], asyncio.Task) else results[0]
        self.assertEqual(result.result, ([1, 2],))


if __name__ == '__main__':
    unittest.main()
