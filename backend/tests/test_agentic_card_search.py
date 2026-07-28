import asyncio
import json
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid5

import pytest

from mtg_deck_builder.agentic_card_search import (
    AgenticCardSearchService,
    AgenticCardSearchUnavailable,
    ExecutedSearchTool,
    LocalCardSearchTool,
    _normalize_tool_arguments,
)
from mtg_deck_builder.agentic_search_debug import JsonlAgentSearchTraceLogger
from mtg_deck_builder.card_catalog import CatalogEntry, card_title_aliases
from mtg_deck_builder.config import AgenticSearchSettings
from mtg_deck_builder.domain import (
    AgenticCardSearchRequest,
    AgentSearchCandidate,
    CardPrices,
    CardSearchFilters,
    CardSearchPage,
    CardSearchResult,
    LocalCardSearchRequest,
    ManaSearch,
)
from mtg_deck_builder.providers.openrouter import OpenRouterError

_UUID_NAMESPACE = UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f")


def make_card(
    name: str,
    *,
    mana_cost: str,
    mana_value: float,
    type_line: str = "Artifact Creature — Construct",
    oracle_text: str = "Trample",
    colors: list[str] | None = None,
    power: str | None = None,
    toughness: str | None = None,
) -> CardSearchResult:
    identity = colors or []
    slug = name.casefold().replace(" ", "-")
    return CardSearchResult(
        oracle_id=uuid5(_UUID_NAMESPACE, f"oracle:{name}"),
        scryfall_id=uuid5(_UUID_NAMESPACE, f"printing:{name}"),
        name=name,
        layout="normal",
        mana_cost=mana_cost,
        mana_value=mana_value,
        type_line=type_line,
        oracle_text=oracle_text,
        power=power,
        toughness=toughness,
        colors=identity,
        color_identity=identity,
        image_uris=None,
        card_faces=[],
        set_code="tst",
        set_name="Test",
        collector_number="1",
        rarity="rare",
        prices=CardPrices(eur=Decimal("0.25")),
        legalities={"commander": "legal"},
        finishes=["nonfoil"],
        scryfall_url=f"https://scryfall.com/card/tst/1/{slug}",
    )


HANGARBACK = make_card(
    "Hangarback Walker",
    mana_cost="{X}{X}",
    mana_value=0,
    oracle_text=(
        "This creature enters with X +1/+1 counters on it.\n"
        "{1}, {T}: Put a +1/+1 counter on this creature."
    ),
)
STONECOIL = make_card(
    "Stonecoil Serpent",
    mana_cost="{X}",
    mana_value=0,
)
GHALTA = make_card(
    "Ghalta, Primal Hunger",
    mana_cost="{10}{G}{G}",
    mana_value=12,
    type_line="Legendary Creature — Elder Dinosaur",
    oracle_text=(
        "This spell costs {X} less to cast, where X is the total power "
        "of creatures you control.\nTrample"
    ),
    colors=["G"],
    power="12",
    toughness="12",
)
GIGANTOSAURUS = make_card(
    "Gigantosaurus",
    mana_cost="{G}{G}{G}{G}{G}",
    mana_value=5,
    type_line="Creature — Dinosaur",
    colors=["G"],
    power="10",
    toughness="10",
)


class StubCatalog:
    path = Path("test-cards.sqlite3")

    def __init__(self, cards: list[CardSearchResult]) -> None:
        self._entries = tuple(
            CatalogEntry(card=card, aliases=card_title_aliases(card)) for card in cards
        )

    async def entries(self) -> tuple[CatalogEntry, ...]:
        return self._entries


def test_local_tool_treats_duplicate_mana_symbols_as_a_multiset() -> None:
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([STONECOIL, HANGARBACK]),
        default_max_results=10,
        hard_max_results=60,
        semantic_enabled=False,
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(mana=ManaSearch(must_contain_all=["{X}", "{X}"])),
            immutable_filters=CardSearchFilters(),
        )
    )

    assert [candidate.card.name for candidate in result.candidates] == ["Hangarback Walker"]


def test_local_tool_filters_numeric_power_and_toughness() -> None:
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([HANGARBACK, GHALTA, GIGANTOSAURUS]),
        default_max_results=10,
        hard_max_results=60,
        semantic_enabled=False,
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest.model_validate(
                {
                    "power": {"minimum": 11},
                    "toughness": {"minimum": 11},
                }
            ),
            immutable_filters=CardSearchFilters(),
        )
    )

    assert [candidate.card.name for candidate in result.candidates] == ["Ghalta, Primal Hunger"]


def test_provider_shorthand_is_normalized_before_strict_validation() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {
            "name": "Ghalta",
            "types": "Creature",
            "oracle_text": "untap",
            "colors": "green",
            "power": "5",
        },
    )

    assert normalized == {
        "name": {"query": "Ghalta"},
        "types": {"must_contain_all": ["Creature"]},
        "oracle_text": {"must_contain_any": ["untap"]},
        "colors": {"identity": ["G"]},
        "power": {"minimum": 5.0},
    }
    assert changes == [
        "name string -> name.query",
        "types string -> types.must_contain_all",
        "oracle_text string -> oracle_text.must_contain_any",
        "colors string -> colors.identity",
        "power numeric string -> power.minimum",
    ]


class StubFuzzyProvider:
    async def search(self, _query: object) -> CardSearchPage:
        return CardSearchPage(
            query="green big creature",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
            strategy="fuzzy",
            interpretation=("Confident title matches shown while agentic search continues"),
            agentic_required=True,
        )


class GhaltaPreviewProvider:
    async def search(self, _query: object) -> CardSearchPage:
        return CardSearchPage(
            query="galtha",
            page=1,
            total_results=1,
            has_more=False,
            cards=[GHALTA],
            strategy="fuzzy",
            interpretation=("Confident title matches shown while agentic search continues"),
            agentic_required=True,
        )


class StubTool:
    def __init__(self, candidates: list[CardSearchResult]) -> None:
        self.calls = 0
        self._candidates = candidates

    async def search(
        self,
        request: object,
        *,
        immutable_filters: CardSearchFilters,
    ) -> ExecutedSearchTool:
        self.calls += 1
        candidates = tuple(
            AgentSearchCandidate(
                card=card,
                exact_match_evidence=["stub query matched"],
                filter_decisions={"immutable_ui_filters": True},
            )
            for card in self._candidates
        )
        return ExecutedSearchTool(
            name="search_local_cards",
            arguments={
                "types": {"must_contain_all": ["Creature"]},
                "colors": {"identity": ["G"]},
                "power": {"minimum": 4},
            },
            candidates=candidates,
            payload={
                "compiled_query": {
                    "engine": "local_sqlite_catalog",
                    "result_limit": 24,
                },
                "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
            },
        )


class StubModelClient:
    def __init__(
        self,
        cards: list[CardSearchResult],
        *,
        ranked_ids: list[int] | None = None,
    ) -> None:
        self.payloads: list[dict[str, object]] = []
        final_ids = ranked_ids if ranked_ids is not None else list(range(1, len(cards) + 1))
        self._responses = [
            {
                "id": "initial",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "reasoning": "The query asks for large green creatures.",
                            "reasoning_details": [
                                {
                                    "type": "reasoning.summary",
                                    "summary": "Use local structured power filtering.",
                                }
                            ],
                            "tool_calls": [
                                {
                                    "id": "tool-call-1",
                                    "type": "function",
                                    "function": {
                                        "name": "search_local_cards",
                                        "arguments": json.dumps(
                                            {
                                                "types": {"must_contain_all": ["Creature"]},
                                                "colors": {
                                                    "identity": ["G"],
                                                    "mode": "subset",
                                                },
                                                "power": {"minimum": 4},
                                                "max_results": 24,
                                            }
                                        ),
                                    },
                                }
                            ],
                        }
                    }
                ],
            },
            {
                "id": "final",
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "interpretation": (
                                        "Large mono-green creatures, strongest matches first."
                                    ),
                                    "ranked_ids": final_ids,
                                }
                            ),
                            "reasoning": "Ranked by fit.",
                        }
                    }
                ],
            },
        ]

    async def chat_completion(
        self,
        payload: dict[str, object],
    ) -> dict[str, object]:
        self.payloads.append(payload)
        return self._responses.pop(0)


class FailingModelClient:
    async def chat_completion(
        self,
        _payload: dict[str, object],
    ) -> dict[str, object]:
        raise OpenRouterError(
            "OpenRouter returned HTTP 429",
            status_code=429,
            response_body={"error": {"message": "Rate limit exceeded"}},
        )


def test_agent_failure_returns_the_partial_sanitized_debug_trace(
    tmp_path: Path,
) -> None:
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=StubTool([GHALTA]),  # type: ignore[arg-type]
        model_client=FailingModelClient(),  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=6,
        trace_logger=JsonlAgentSearchTraceLogger(trace_path),
        trace_log_path=str(trace_path),
        debug_default_enabled=False,
    )

    with pytest.raises(AgenticCardSearchUnavailable) as raised:
        asyncio.run(
            service.search(
                AgenticCardSearchRequest(
                    q="green big creature",
                    debug=True,
                )
            )
        )

    debug = raised.value.debug
    assert debug is not None
    assert [stage.status for stage in debug.stages] == [
        "ok",
        "ok",
        "error",
        "skipped",
        "skipped",
        "skipped",
        "skipped",
    ]
    assert debug.trace["decision"]["failed_stage"] == "thinking"
    failed_details = debug.trace["stages"][2]["details"]
    assert failed_details["error_type"] == "OpenRouterError"
    assert failed_details["status_code"] == 429
    assert failed_details["provider_response"] == {
        "error": {"message": "Rate limit exceeded"}
    }
    assert debug.trace["result"]["status"] == "error"
    assert debug.log_written is True
    assert '"status":"error"' in trace_path.read_text(encoding="utf-8")


def test_unconfigured_agent_still_returns_system_and_user_trace_steps(
    tmp_path: Path,
) -> None:
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=StubTool([GHALTA]),  # type: ignore[arg-type]
        model_client=None,
        settings=AgenticSearchSettings(enabled=True),
        page_size=6,
        trace_logger=JsonlAgentSearchTraceLogger(trace_path),
        trace_log_path=str(trace_path),
        debug_default_enabled=False,
    )

    with pytest.raises(AgenticCardSearchUnavailable) as raised:
        asyncio.run(
            service.search(
                AgenticCardSearchRequest(
                    q="green big creature",
                    debug=True,
                )
            )
        )

    debug = raised.value.debug
    assert debug is not None
    assert [stage.status for stage in debug.stages[:3]] == ["ok", "ok", "error"]
    assert debug.trace["stages"][2]["details"]["error_type"] == (
        "CardSearchUnavailable"
    )
    assert "Magic: The Gathering card-search agent" in (
        debug.trace["stages"][0]["details"]["content"]
    )
    assert '"green big creature"' in (
        debug.trace["stages"][1]["details"]["content"]
    )


def test_agent_runs_one_tool_then_reuses_the_ranked_session(
    tmp_path: Path,
) -> None:
    cards = [GHALTA, GIGANTOSAURUS]
    model = StubModelClient(cards)
    local_tool = StubTool(cards)
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=local_tool,  # type: ignore[arg-type]
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=1,
        trace_logger=JsonlAgentSearchTraceLogger(trace_path),
        trace_log_path=str(trace_path),
        debug_default_enabled=False,
    )

    first = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="green big creature",
                debug=True,
            )
        )
    )
    assert first.strategy == "agentic"
    assert first.reranked is True
    assert first.cards == [GHALTA]
    assert first.has_more is True
    assert first.search_session_id is not None
    assert local_tool.calls == 1
    assert len(model.payloads) == 2
    assert model.payloads[0]["tool_choice"] == "required"
    assert len(model.payloads[0]["tools"]) == 1
    assert model.payloads[0]["tools"][0]["function"]["name"] == "search_local_cards"
    assert "search_scryfall" not in json.dumps(model.payloads[0])
    assert "tool_choice" not in model.payloads[1]
    assert "tools" not in model.payloads[1]
    initial_messages = model.payloads[0]["messages"]
    assert isinstance(initial_messages, list)
    initial_user_message = initial_messages[1]["content"]
    assert isinstance(initial_user_message, str)
    assert '"green big creature"' in initial_user_message
    assert "image_uris" not in initial_user_message
    final_messages = model.payloads[1]["messages"]
    assert isinstance(final_messages, list)
    tool_message = final_messages[-1]["content"]
    assert isinstance(tool_message, str)
    assert "ID 1" in tool_message
    assert str(GHALTA.scryfall_id) not in tool_message
    assert first.debug is not None
    assert [stage.name for stage in first.debug.stages] == [
        "system_prompt",
        "user_input_prompt",
        "thinking",
        "tool_call",
        "tool_response",
        "thinking",
        "output_response",
    ]
    presentation_stages = first.debug.trace["stages"]
    assert (
        "You are a Magic: The Gathering card-search agent"
        in presentation_stages[0]["details"]["content"]
    )
    assert '"green big creature"' in presentation_stages[1]["details"]["content"]
    assert presentation_stages[2]["details"]["reasoning"].startswith("The query asks")
    tool_result_trace = first.debug.trace["stages"][4]["details"]
    assert tool_result_trace["raw_tool_result"]["candidates"]
    assert tool_result_trace["message_to_agent"].startswith("The search tool has finished.")
    assert tool_result_trace["numbered_candidates"][0]["id"] == 1
    assert presentation_stages[5]["details"]["reasoning"] == "Ranked by fit."
    assert presentation_stages[6]["details"]["ranked_ids"] == [1, 2]
    assert '"schema_version":2' in trace_path.read_text(encoding="utf-8")

    second = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="green big creature",
                page=2,
                search_session_id=first.search_session_id,
            )
        )
    )
    assert second.cards == [GIGANTOSAURUS]
    assert second.has_more is False
    assert local_tool.calls == 1
    assert len(model.payloads) == 2


def test_agentic_results_keep_short_title_alias_confidence(
    tmp_path: Path,
) -> None:
    model = StubModelClient([GHALTA])
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=GhaltaPreviewProvider(),  # type: ignore[arg-type]
        local_tool=StubTool([GHALTA, GIGANTOSAURUS]),  # type: ignore[arg-type]
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=12,
        trace_logger=JsonlAgentSearchTraceLogger(trace_path),
        trace_log_path=str(trace_path),
        debug_default_enabled=False,
    )

    result = asyncio.run(service.search(AgenticCardSearchRequest(q="galtha")))

    assert result.cards == [GHALTA]
    assert result.name_match_scores[GHALTA.scryfall_id] > 0.8
    assert result.title_confidence_scores[GHALTA.scryfall_id] > 0.8
    initial_user_message = model.payloads[0]["messages"][1]["content"]
    assert "ID 1 [ALREADY SHOWN]" in initial_user_message
    assert "Power/Toughness: 12/12" in initial_user_message
    assert "EUR price estimate: €0.25" in initial_user_message
    assert "This spell costs {X} less to cast" in initial_user_message
    assert "already valid final choices" in initial_user_message
    assert "non-overlapping IDs" in initial_user_message
    assert "image_uris" not in initial_user_message
    tool_message = model.payloads[1]["messages"][-1]["content"]
    assert "ID 1 [ALREADY SHOWN]" in tool_message
    assert "ID 2\nName: Gigantosaurus" in tool_message
    assert tool_message.count("Name: Ghalta, Primal Hunger") == 1
    assert str(GHALTA.scryfall_id) not in tool_message


def test_agent_can_omit_irrelevant_candidates(
    tmp_path: Path,
) -> None:
    cards = [GHALTA, GIGANTOSAURUS]
    model = StubModelClient(cards, ranked_ids=[1])
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=StubTool(cards),  # type: ignore[arg-type]
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=12,
        trace_logger=JsonlAgentSearchTraceLogger(trace_path),
        trace_log_path=str(trace_path),
        debug_default_enabled=False,
    )

    result = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="green big creature",
                debug=True,
            )
        )
    )

    assert result.cards == [GHALTA]
    assert result.total_results == 1
    assert result.debug is not None
    output_response = result.debug.trace["stages"][6]["details"]
    assert output_response["ranked_ids"] == [1]
    assert output_response["ranked_cards"] == [{"rank": 1, "name": "Ghalta, Primal Hunger"}]
