"""Conservative finite-domain deductions shared by descriptions and errors."""

from jsonschema import Draft202012Validator

_MISSING = object()

def forbidden_enum_fields(condition, schema, value=_MISSING, path=()):
    """Recognize a required-field conjunction; never guess through other rules."""
    if not isinstance(condition, dict) or not isinstance(schema, dict):
        return None
    annotations = {"title", "description", "default", "examples", "$comment", "x-error-message"}
    keys = set(condition) - annotations
    if keys in ({"enum"}, {"const"}):
        choices = schema.get("enum", [schema["const"]] if "const" in schema else None)
        if choices is None:
            return None
        try:
            blocked = Draft202012Validator(condition)
            allowed = Draft202012Validator(schema)
            alternatives = [item for item in choices if not blocked.is_valid(item) and allowed.is_valid(item)]
        except Exception:
            return None  # References require the owning SchemaContext, not a guessed scope.
        return [(path, value, alternatives)]
    props = condition.get("properties")
    if not keys <= {"type", "properties", "required"} or not props or condition.get("type") != "object":
        return None
    if schema.get("type") != "object" or value is not _MISSING and not isinstance(value, dict):
        return None
    if set(condition.get("required", [])) != set(props) or not set(props) <= set(schema.get("required", [])):
        return None
    fields = []
    for name, child in props.items():
        if value is not _MISSING and name not in value:
            return None
        result = forbidden_enum_fields(child, schema.get("properties", {}).get(name), value[name] if value is not _MISSING else _MISSING, [*path, name])
        if result is None:
            return None
        fields.extend(result)
    return fields
