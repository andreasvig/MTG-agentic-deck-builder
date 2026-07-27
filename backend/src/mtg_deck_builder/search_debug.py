"""Structured, append-only diagnostics for layered card search."""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter
from typing import Any
from uuid import uuid4

from mtg_deck_builder.domain import (
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
    SearchDebugStage,
    SearchDebugSummary,
)


class SearchDebugTrace:
    """Collect one search's decisions, timings, and rank changes."""

    def __init__(
        self,
        query: CardSearchQuery,
        *,
        log_path: Path,
        result_limit: int,
        configuration: dict[str, Any],
    ) -> None:
        self._started_at = datetime.now(UTC)
        self._started_perf = perf_counter()
        self._log_path = log_path
        self._result_limit = result_limit
        self._stages: list[dict[str, Any]] = []
        self._record: dict[str, Any] = {
            "schema_version": 1,
            "trace_id": str(uuid4()),
            "started_at": self._started_at.isoformat(),
            "request": {
                "query": query.q,
                "page": query.page,
                "debug": query.debug,
                "filters": query.filters.model_dump(mode="json"),
            },
            "configuration": configuration,
            "decision": {},
            "stages": self._stages,
        }

    @property
    def record(self) -> dict[str, Any]:
        return self._record

    def set_decision(self, **values: Any) -> None:
        self._record["decision"].update(values)

    def add_stage(
        self,
        name: str,
        *,
        status: str,
        duration_ms: float,
        input_cards: list[CardSearchResult] | None = None,
        output_cards: list[CardSearchResult] | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        stage: dict[str, Any] = {
            "name": name,
            "status": status,
            "duration_ms": _round_ms(duration_ms),
        }
        if input_cards is not None:
            stage["input"] = self._card_snapshot(input_cards)
        if output_cards is not None:
            stage["output"] = self._card_snapshot(output_cards)
        if input_cards is not None and output_cards is not None:
            stage["rank_changes"] = self._rank_changes(
                input_cards,
                output_cards,
            )
        if details:
            stage["details"] = details
        self._stages.append(stage)

    def finish(self, page: CardSearchPage) -> None:
        total_duration_ms = _elapsed_ms(self._started_perf)
        self._record.update(
            {
                "completed_at": datetime.now(UTC).isoformat(),
                "total_duration_ms": _round_ms(total_duration_ms),
                "result": {
                    "status": "ok",
                    "strategy": page.strategy,
                    "interpretation": page.interpretation,
                    "total_results": page.total_results,
                    "has_more": page.has_more,
                    "returned": self._card_snapshot(page.cards),
                    "name_match_scores": {
                        str(scryfall_id): score
                        for scryfall_id, score in page.name_match_scores.items()
                    },
                    "warnings": page.warnings,
                },
            }
        )

    def finish_error(self, error: BaseException) -> None:
        total_duration_ms = _elapsed_ms(self._started_perf)
        self._record.update(
            {
                "completed_at": datetime.now(UTC).isoformat(),
                "total_duration_ms": _round_ms(total_duration_ms),
                "result": {
                    "status": "cancelled" if isinstance(error, asyncio.CancelledError) else "error",
                    "error_type": type(error).__name__,
                },
            }
        )

    def summary(self, *, log_written: bool) -> SearchDebugSummary:
        return SearchDebugSummary(
            trace_id=self._record["trace_id"],
            log_path=str(self._log_path),
            log_written=log_written,
            total_duration_ms=self._record["total_duration_ms"],
            stages=[
                SearchDebugStage(
                    name=stage["name"],
                    status=stage["status"],
                    duration_ms=stage["duration_ms"],
                    input_count=stage.get("input", {}).get("count"),
                    output_count=stage.get("output", {}).get("count"),
                )
                for stage in self._stages
            ],
            trace=self._record,
        )

    def _card_snapshot(self, cards: list[CardSearchResult]) -> dict[str, Any]:
        return {
            "count": len(cards),
            "top": [
                {
                    "rank": rank,
                    "scryfall_id": str(card.scryfall_id),
                    "name": card.name,
                }
                for rank, card in enumerate(
                    cards[: self._result_limit],
                    start=1,
                )
            ],
        }

    def _rank_changes(
        self,
        input_cards: list[CardSearchResult],
        output_cards: list[CardSearchResult],
    ) -> list[dict[str, Any]]:
        before_ranks = {card.scryfall_id: rank for rank, card in enumerate(input_cards, start=1)}
        return [
            {
                "scryfall_id": str(card.scryfall_id),
                "name": card.name,
                "before_rank": before_ranks.get(card.scryfall_id),
                "after_rank": after_rank,
                "delta": (
                    before_ranks[card.scryfall_id] - after_rank
                    if card.scryfall_id in before_ranks
                    else None
                ),
            }
            for after_rank, card in enumerate(
                output_cards[: self._result_limit],
                start=1,
            )
        ]


class JsonlSearchDebugLogger:
    """Serialize complete traces as one valid JSON object per line."""

    def __init__(self, path: Path, *, result_limit: int = 25) -> None:
        self.path = path
        self.result_limit = result_limit
        self._write_lock = asyncio.Lock()

    def new_trace(
        self,
        query: CardSearchQuery,
        *,
        configuration: dict[str, Any],
    ) -> SearchDebugTrace:
        return SearchDebugTrace(
            query,
            log_path=self.path,
            result_limit=self.result_limit,
            configuration=configuration,
        )

    async def write(self, trace: SearchDebugTrace) -> None:
        serialized = json.dumps(
            trace.record,
            ensure_ascii=True,
            separators=(",", ":"),
        )
        async with self._write_lock:
            await asyncio.to_thread(self._append_line, serialized)

    def _append_line(self, serialized: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.write("\n")


def stage_started() -> float:
    return perf_counter()


def stage_elapsed_ms(started_at: float) -> float:
    return _elapsed_ms(started_at)


def _elapsed_ms(started_at: float) -> float:
    return (perf_counter() - started_at) * 1_000


def _round_ms(value: float) -> float:
    return round(max(value, 0), 3)
