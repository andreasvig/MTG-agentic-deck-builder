"""Benchmark candidate rerankers through the complete layered search pipeline."""

import argparse
import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from statistics import median
from time import perf_counter
from typing import Any

import httpx2

from mtg_deck_builder.config import Settings
from mtg_deck_builder.domain import CardSearchQuery
from mtg_deck_builder.providers import ScryfallCardSearchProvider
from mtg_deck_builder.search import (
    FastEmbedCardRanker,
    HybridCardSearchProvider,
    OpenRouterCardReranker,
)
from mtg_deck_builder.search_debug import JsonlSearchDebugLogger

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_QUERY = "things which let me untap my elves"


@dataclass(frozen=True)
class BenchmarkTarget:
    label: str
    model: str
    provider: str | None
    reasoning_effort: str
    max_tokens: int


TARGETS = [
    BenchmarkTarget("Mercury 2", "inception/mercury-2", None, "none", 900),
    BenchmarkTarget(
        "Gemma 4 31B on Cerebras",
        "google/gemma-4-31b-it",
        "Cerebras",
        "none",
        900,
    ),
    BenchmarkTarget(
        "Gemini 3.5 Flash Lite",
        "google/gemini-3.5-flash-lite",
        None,
        "minimal",
        900,
    ),
    BenchmarkTarget(
        "GPT-OSS-120B on Cerebras",
        "openai/gpt-oss-120b",
        "Cerebras",
        "low",
        2_200,
    ),
]


async def benchmark(query: str, runs: int) -> dict[str, Any]:
    settings = Settings(_env_file=REPOSITORY_ROOT / ".env")
    if settings.openrouter_api_key is None:
        raise RuntimeError("OPENROUTER_API_KEY must be set in the repository .env")

    output_directory = REPOSITORY_ROOT / "local-data"
    trace_path = output_directory / "search-reranker-benchmark.jsonl"
    result_path = output_directory / "search-reranker-benchmark.json"
    output_directory.mkdir(parents=True, exist_ok=True)
    trace_path.unlink(missing_ok=True)

    semantic_ranker = FastEmbedCardRanker(settings.embedding_model)
    measurements: list[dict[str, Any]] = []
    async with (
        httpx2.AsyncClient(
            base_url=settings.scryfall_base_url,
            headers={
                "Accept": "application/json;q=0.9,*/*;q=0.8",
                "User-Agent": settings.scryfall_user_agent,
            },
            timeout=httpx2.Timeout(settings.scryfall_timeout_seconds),
        ) as scryfall_client,
        httpx2.AsyncClient(
            base_url=settings.openrouter_base_url,
            headers={
                "Accept": "application/json",
                "Authorization": (
                    f"Bearer {settings.openrouter_api_key.get_secret_value()}"
                ),
                "HTTP-Referer": settings.frontend_origin,
                "X-Title": "MTG Agentic Deck Builder Benchmark",
            },
            timeout=httpx2.Timeout(60),
        ) as openrouter_client,
    ):
        scryfall = ScryfallCardSearchProvider(scryfall_client)
        warmup = HybridCardSearchProvider(
            scryfall,
            semantic_ranker=semantic_ranker,
        )
        await warmup.search(CardSearchQuery(q=query))

        for run_number in range(1, runs + 1):
            for target in TARGETS:
                provider = HybridCardSearchProvider(
                    scryfall,
                    semantic_ranker=semantic_ranker,
                    llm_ranker=OpenRouterCardReranker(
                        openrouter_client,
                        model=target.model,
                        provider=target.provider,
                        reasoning_effort=target.reasoning_effort,
                        max_tokens=target.max_tokens,
                    ),
                    debug_logger=JsonlSearchDebugLogger(trace_path),
                    debug_default_enabled=False,
                )
                started = perf_counter()
                result = await provider.search(
                    CardSearchQuery(q=query, debug=True)
                )
                wall_duration_ms = round((perf_counter() - started) * 1_000, 3)
                if result.debug is None:
                    raise RuntimeError("Benchmark search did not return a debug trace")
                llm_stage = next(
                    stage
                    for stage in result.debug.stages
                    if stage.name == "OpenRouter ranking"
                )
                measurements.append(
                    {
                        "run": run_number,
                        "label": target.label,
                        "model": target.model,
                        "provider": target.provider,
                        "reasoning_effort": target.reasoning_effort,
                        "max_tokens": target.max_tokens,
                        "success": llm_stage.status == "ok",
                        "wall_duration_ms": wall_duration_ms,
                        "pipeline_duration_ms": result.debug.total_duration_ms,
                        "llm_duration_ms": llm_stage.duration_ms,
                        "trace_id": str(result.debug.trace_id),
                        "top_cards": [card.name for card in result.cards[:5]],
                        "warnings": result.warnings,
                    }
                )
                print(
                    f"{target.label} run {run_number}: "
                    f"{llm_stage.status}, {llm_stage.duration_ms:.1f} ms LLM, "
                    f"{wall_duration_ms:.1f} ms end-to-end",
                    flush=True,
                )
                await asyncio.sleep(0.25)

    summaries = []
    for target in TARGETS:
        target_runs = [
            item for item in measurements if item["model"] == target.model
        ]
        successful_runs = [item for item in target_runs if item["success"]]
        summaries.append(
            {
                "label": target.label,
                "model": target.model,
                "provider": target.provider,
                "reasoning_effort": target.reasoning_effort,
                "max_tokens": target.max_tokens,
                "successful_runs": len(successful_runs),
                "total_runs": len(target_runs),
                "median_llm_duration_ms": (
                    round(
                        median(
                            item["llm_duration_ms"]
                            for item in successful_runs
                        ),
                        3,
                    )
                    if successful_runs
                    else None
                ),
                "median_pipeline_duration_ms": (
                    round(
                        median(
                            item["pipeline_duration_ms"]
                            for item in successful_runs
                        ),
                        3,
                    )
                    if successful_runs
                    else None
                ),
                "median_wall_duration_ms": (
                    round(
                        median(
                            item["wall_duration_ms"]
                            for item in successful_runs
                        ),
                        3,
                    )
                    if successful_runs
                    else None
                ),
                "top_cards_by_run": [
                    item["top_cards"] for item in target_runs
                ],
                "warnings": [
                    warning
                    for item in target_runs
                    for warning in item["warnings"]
                ],
            }
        )

    report = {
        "created_at": datetime.now(UTC).isoformat(),
        "query": query,
        "runs_per_model": runs,
        "trace_path": str(trace_path.relative_to(REPOSITORY_ROOT)),
        "summaries": summaries,
        "measurements": measurements,
    }
    result_path.write_text(
        json.dumps(report, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", default=DEFAULT_QUERY)
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be at least 1")
    return args


if __name__ == "__main__":
    arguments = parse_args()
    asyncio.run(benchmark(arguments.query, arguments.runs))
