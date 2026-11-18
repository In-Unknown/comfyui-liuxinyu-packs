"""Deterministic Chinese explanations of JSON Schema Draft 2020-12."""

from .compiler import Description, DescriptionError, Rule, describe, describe_schema
from .messages import validation_message as explain_error

__all__ = ["Description", "DescriptionError", "Rule", "describe", "describe_schema", "explain_error"]
