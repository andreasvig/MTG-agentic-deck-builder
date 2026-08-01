"""Rendering Pydantic models as tool schemas a model provider will actually accept.

Both agents advertise tools, so this lives here rather than beside either of them:
the rules encoded below were learned from provider rejections, and a second copy
would drift out of agreement with the first.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


def provider_tool_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Render a model's JSON schema for advertisement to a model provider.

    Pydantic describes a `Decimal` field as "a number, or a numeric string", and
    that string alternative carries a regex with a negative lookahead. OpenAI's
    schema validator rejects lookarounds outright, so the whole tool call fails.
    Dropping the string alternative is safe in both directions: it only narrows
    what the tool advertises, and runtime validation still accepts either form.
    """

    def prune(node: Any) -> Any:
        if isinstance(node, dict):
            alternatives = node.get("anyOf")
            if isinstance(alternatives, list):
                kept = [
                    alternative
                    for alternative in alternatives
                    if not _has_unsupported_pattern(alternative)
                ]
                # Never prune away every branch; an empty anyOf is invalid schema.
                node = {**node, "anyOf": kept or alternatives}
            return {key: prune(value) for key, value in node.items()}
        if isinstance(node, list):
            return [prune(item) for item in node]
        return node

    return prune(model.model_json_schema())


def _has_unsupported_pattern(schema: Any) -> bool:
    """Report whether a subschema constrains strings with an unsupported regex."""

    if not isinstance(schema, dict):
        return False
    pattern = schema.get("pattern")
    return isinstance(pattern, str) and ("(?!" in pattern or "(?=" in pattern)
