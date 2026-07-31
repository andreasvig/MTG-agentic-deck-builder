import asyncio
import json
from pathlib import Path
from uuid import UUID

import pytest
from pydantic import TypeAdapter, ValidationError

from mtg_deck_builder.agentic_search import (
    AgentSearchContractError,
    resolve_local_tool_limit,
    validate_final_ranking,
)
from mtg_deck_builder.agentic_search_debug import (
    AgentSearchTraceBuilder,
    JsonlAgentSearchTraceLogger,
)
from mtg_deck_builder.domain import (
    AgentRankedSearchOutput,
    AgentSearchToolCall,
    CardSearchFilters,
    LocalCardSearchRequest,
    ManaSearch,
)

FIRST_ID = UUID("d5d41bfc-6f17-42b5-b82e-3d99dbd608bd")
SECOND_ID = UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f")


def test_local_tool_fields_are_optional_and_duplicate_symbols_are_preserved() -> None:
    empty_request = LocalCardSearchRequest()
    symbols_only = LocalCardSearchRequest(
        mana=ManaSearch(
            value_maximum=4,
            must_contain_all=["{X}", "{X}"],
        ),
    )

    assert empty_request.model_dump(exclude_none=True, exclude_defaults=True) == {}
    assert empty_request.has_agent_criteria() is False
    assert symbols_only.has_agent_criteria() is True
    assert symbols_only.mana is not None
    assert symbols_only.mana.must_contain_all == ["{X}", "{X}"]


def test_local_tool_rejects_removed_oracle_text_filter() -> None:
    with pytest.raises(ValidationError):
        LocalCardSearchRequest.model_validate(
            {"oracle_text": {"must_contain_any": ["draw a card"]}}
        )


@pytest.mark.parametrize("field", ["format", "legality"])
def test_local_tool_rejects_runtime_owned_legality_fields(field: str) -> None:
    with pytest.raises(ValidationError):
        LocalCardSearchRequest.model_validate({field: "commander"})


def test_tool_call_contract_allows_only_the_typed_local_search_tool() -> None:
    adapter = TypeAdapter(AgentSearchToolCall)

    local = adapter.validate_python(
        {
            "name": "search_local_cards",
            "arguments": {"semantic_sort": "creates artifact creature tokens"},
        }
    )

    assert local.name == "search_local_cards"
    properties = LocalCardSearchRequest.model_json_schema()["properties"]
    assert "format" not in properties
    assert "legality" not in properties
    with pytest.raises(ValidationError):
        adapter.validate_python(
            {
                "name": "search_scryfall",
                "arguments": {"query": 'o:"untap" t:creature game:paper'},
            }
        )
    with pytest.raises(ValidationError):
        adapter.validate_python(
            {
                "name": "search_local_cards",
                "arguments": {"query": "raw SQL is not a local-tool field"},
            }
        )


def test_max_results_alone_does_not_make_an_empty_tool_request_meaningful() -> None:
    request = LocalCardSearchRequest(max_results=24)

    assert request.has_agent_criteria() is False
    assert LocalCardSearchRequest(
        semantic_sort="cards that create artifact creature tokens"
    ).has_agent_criteria()


@pytest.mark.parametrize(
    "payload",
    [
        {"mana": {"value_minimum": 5, "value_maximum": 2}},
        {"power": {"minimum": 5, "maximum": 2}},
        {"price_eur": {"minimum": "5", "maximum": "2"}},
        {"max_results": 61},
        {"unknown": "field"},
    ],
)
def test_local_tool_rejects_invalid_ranges_limits_and_unknown_fields(
    payload: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        LocalCardSearchRequest.model_validate(payload)


def test_final_agent_output_requires_unique_candidate_ids() -> None:
    valid = AgentRankedSearchOutput(
        interpretation="Artifact creatures that scale with counters",
        ranked_ids=[1, 2],
    )

    assert valid.ranked_ids == [1, 2]
    with pytest.raises(ValidationError):
        AgentRankedSearchOutput(
            interpretation="Duplicate result",
            ranked_ids=[1, 1],
        )


def test_local_tool_limit_requires_criteria_or_immutable_filters() -> None:
    with pytest.raises(AgentSearchContractError, match="requires agent criteria"):
        resolve_local_tool_limit(
            LocalCardSearchRequest(),
            immutable_filters=CardSearchFilters(),
            default_max_results=24,
            hard_max_results=60,
        )

    assert (
        resolve_local_tool_limit(
            LocalCardSearchRequest(),
            immutable_filters=CardSearchFilters(colors=["G"]),
            default_max_results=24,
            hard_max_results=60,
        )
        == 24
    )
    with pytest.raises(AgentSearchContractError, match="hard maximum"):
        resolve_local_tool_limit(
            LocalCardSearchRequest(
                name_sort="walker",
                sort_by="name_similarity",
                max_results=30,
            ),
            immutable_filters=CardSearchFilters(),
            default_max_results=12,
            hard_max_results=24,
        )


def test_final_ranking_accepts_a_relevant_subset_without_inventing_ids() -> None:
    output = AgentRankedSearchOutput(
        interpretation="Only the strongest candidate is relevant",
        ranked_ids=[2],
    )

    ranked = validate_final_ranking(
        output,
        candidate_ids=[1, 2],
        max_candidate_count=60,
    )

    assert ranked == (2,)
    assert (
        validate_final_ranking(
            AgentRankedSearchOutput(
                interpretation="No candidates are relevant",
                ranked_ids=[],
            ),
            candidate_ids=[1, 2],
            max_candidate_count=60,
        )
        == ()
    )
    with pytest.raises(AgentSearchContractError, match="outside"):
        validate_final_ranking(
            AgentRankedSearchOutput(
                interpretation="Invented",
                ranked_ids=[1, 3],
            ),
            candidate_ids=[1, 2],
            max_candidate_count=60,
        )


def test_successful_agent_trace_requires_every_observable_stage() -> None:
    trace = AgentSearchTraceBuilder({"query": "x spells"})

    with pytest.raises(ValidationError):
        trace.finish()
    with pytest.raises(ValueError, match="initial_model_request"):
        trace.add_stage("tool_call", {"name": "search_local_cards"})


def test_agent_trace_persists_complete_raw_json_and_redacts_only_secrets(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / "agent-search.jsonl"
    trace = AgentSearchTraceBuilder(
        {
            "query": "artifact creatures with two X symbols",
            "headers": {
                "Authorization": "Bearer secret-provider-token",
                "Accept": "application/json",
            },
            "preview_candidates": [{"name": "Hangarback Walker", "score": 0.51}],
        }
    )
    trace.add_stage(
        "initial_model_request",
        {
            "model": "google/gemini-3.5-flash-lite",
            "messages": [{"role": "system", "content": "Use canonical {X} symbols."}],
            "api_key": "secret-key",
        },
    )
    trace.add_stage(
        "initial_model_response",
        {
            "raw_response": {
                "reasoning": {"summary": "The request needs mana-symbol filtering."},
                "usage": {"input_tokens": 100, "output_tokens": 25},
                "tool_calls": [{"name": "search_local_cards"}],
            }
        },
    )
    trace.add_stage(
        "tool_call",
        {
            "name": "search_local_cards",
            "arguments": {
                "mana": {"must_contain_all": ["{X}", "{X}"]},
                "max_results": 60,
            },
            "compiled_query": {
                "operation": "local_catalog_filter",
                "mana_symbol_counts": {"{X}": 2},
            },
        },
    )
    trace.add_stage(
        "tool_result",
        {
            "candidates": [
                {
                    "scryfall_id": str(FIRST_ID),
                    "name": f"Candidate {index}",
                    "semantic_score": round(index / 60, 6),
                }
                for index in range(60)
            ]
        },
    )
    trace.add_stage(
        "final_model_request",
        {"messages": [{"role": "tool", "content": "All 60 complete candidates are attached."}]},
    )
    trace.add_stage(
        "final_model_response",
        {
            "raw_response": {
                "reasoning": {"summary": "Hangarback Walker is the strongest match."},
                "output": {
                    "interpretation": "Double-X artifact creatures",
                    "ranked_ids": [str(FIRST_ID)],
                },
            }
        },
    )
    trace.add_stage(
        "validation",
        {
            "tool_call_count": 1,
            "candidate_membership_valid": True,
            "deduplicated_ids": [str(FIRST_ID)],
            "first_page_ids": [str(FIRST_ID)],
            "timing_ms": {"total": trace.elapsed_ms()},
            "retries": [],
            "errors": [],
        },
    )
    record = trace.finish()

    asyncio.run(JsonlAgentSearchTraceLogger(log_path).write(record))

    persisted = json.loads(log_path.read_text(encoding="utf-8"))
    assert persisted["schema_version"] == 2
    assert len(persisted["stages"]) == 8
    assert persisted["stages"][0]["payload"]["headers"]["Authorization"] == "[REDACTED]"
    assert persisted["stages"][0]["payload"]["headers"]["Accept"] == "application/json"
    assert persisted["stages"][1]["payload"]["api_key"] == "[REDACTED]"
    initial_response = persisted["stages"][2]["payload"]["raw_response"]
    assert initial_response["reasoning"]["summary"].startswith("The request")
    assert initial_response["usage"]["input_tokens"] == 100
    tool_result = persisted["stages"][4]["payload"]["candidates"]
    assert len(tool_result) == 60
    assert tool_result[-1]["name"] == "Candidate 59"
