"""Complete, secret-redacted debug traces for agentic card search."""

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import UUID, uuid4

from mtg_deck_builder.domain.agentic_search import (
    COMPLETED_AGENT_TRACE_STAGES,
    AgentSearchTraceRecord,
    AgentTraceStage,
    AgentTraceStageName,
    AgentTraceStatus,
)

_REDACTED = "[REDACTED]"
_SENSITIVE_KEYS = {
    "api-key",
    "apikey",
    "authorization",
    "bearer-token",
    "client-secret",
    "cookie",
    "openrouter-api-key",
    "password",
    "proxy-authorization",
    "refresh-token",
    "secret",
    "set-cookie",
    "x-api-key",
}


class AgentSearchTraceBuilder:
    """Collect every observable stage of one bounded agent run."""

    def __init__(self, request_context: dict[str, Any]) -> None:
        self._trace_id = uuid4()
        self._started_at = datetime.now(UTC)
        self._started_perf = perf_counter()
        self._stages: list[AgentTraceStage] = []
        self.add_stage("request_context", request_context)

    @property
    def trace_id(self) -> UUID:
        return self._trace_id

    @property
    def stages(self) -> tuple[AgentTraceStage, ...]:
        return tuple(self._stages)

    def add_stage(
        self,
        name: AgentTraceStageName,
        payload: dict[str, Any],
        *,
        duration_ms: float | None = None,
    ) -> None:
        """Append one complete raw payload in the required execution order."""

        if len(self._stages) >= len(COMPLETED_AGENT_TRACE_STAGES):
            raise ValueError("agent trace already contains every observable stage")
        expected = COMPLETED_AGENT_TRACE_STAGES[len(self._stages)]
        if name != expected:
            raise ValueError(f"expected agent trace stage {expected!r}, received {name!r}")
        self._stages.append(
            AgentTraceStage(
                name=name,
                recorded_at=datetime.now(UTC),
                duration_ms=duration_ms,
                payload=redact_sensitive_data(payload),
            )
        )

    def finish(
        self,
        *,
        status: AgentTraceStatus = "ok",
        error: dict[str, Any] | None = None,
    ) -> AgentSearchTraceRecord:
        """Validate and return a complete persisted/inline trace record."""

        return AgentSearchTraceRecord(
            trace_id=self._trace_id,
            started_at=self._started_at,
            completed_at=datetime.now(UTC),
            status=status,
            stages=self._stages,
            error=redact_sensitive_data(error) if error is not None else None,
        )

    def elapsed_ms(self) -> float:
        """Return elapsed wall-clock time for caller-owned timing evidence."""

        return round(max((perf_counter() - self._started_perf) * 1_000, 0), 3)


class JsonlAgentSearchTraceLogger:
    """Append complete versioned agent traces as JSONL without truncation."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._write_lock = asyncio.Lock()

    async def write(self, trace: AgentSearchTraceRecord) -> None:
        serialized = trace.model_dump_json()
        async with self._write_lock:
            await asyncio.to_thread(self._append_line, serialized)

    def _append_line(self, serialized: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.write("\n")


def redact_sensitive_data(value: Any) -> Any:
    """Recursively redact credentials while preserving observable payloads."""

    if isinstance(value, dict):
        redacted: dict[Any, Any] = {}
        for key, nested in value.items():
            normalized_key = str(key).strip().casefold().replace("_", "-")
            redacted[key] = (
                _REDACTED if normalized_key in _SENSITIVE_KEYS else redact_sensitive_data(nested)
            )
        return redacted
    if isinstance(value, list):
        return [redact_sensitive_data(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_sensitive_data(item) for item in value)
    return value
