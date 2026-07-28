import asyncio
import json
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid5

from mtg_deck_builder.agentic_card_search import (
    AgenticCardSearchService,
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

_UUID_NAMESPACE = UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f")


def make_card(
    name: str,
    *,
    mana_cost: str,
    mana_value: float,
    type_line: str = "Artifact Creature — Construct",
    oracle_text: str = "Trample",
    colors: list[str] | None = None,
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
    colors=["G"],
)
GIGANTOSAURUS = make_card(
    "Gigantosaurus",
    mana_cost="{G}{G}{G}{G}{G}",
    mana_value=5,
    type_line="Creature — Dinosaur",
    colors=["G"],
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


def test_provider_shorthand_is_normalized_before_strict_validation() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {
            "name": "Ghalta",
            "types": "Creature",
            "colors": "green",
        },
    )

    assert normalized == {
        "name": {"query": "Ghalta"},
        "types": {"must_contain_all": ["Creature"]},
        "colors": {"identity": ["G"]},
    }
    assert changes == [
        "name string -> name.query",
        "types string -> types.must_contain_all",
        "colors string -> colors.identity",
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
            name="search_scryfall",
            arguments={"query": "id:g t:creature pow>=4"},
            candidates=candidates,
            payload={
                "compiled_query": "(id:g t:creature pow>=4) game:paper",
                "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
            },
        )


class StubModelClient:
    def __init__(self, cards: list[CardSearchResult]) -> None:
        self.payloads: list[dict[str, object]] = []
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
                                    "summary": "Use Scryfall power filtering.",
                                }
                            ],
                            "tool_calls": [
                                {
                                    "id": "tool-call-1",
                                    "type": "function",
                                    "function": {
                                        "name": "search_scryfall",
                                        "arguments": json.dumps(
                                            {
                                                "query": ("id:g t:creature pow>=4"),
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
                                    "ranked_ids": [str(card.scryfall_id) for card in cards],
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


def test_agent_runs_one_tool_then_reuses_the_ranked_session(
    tmp_path: Path,
) -> None:
    cards = [GHALTA, GIGANTOSAURUS]
    model = StubModelClient(cards)
    scryfall_tool = StubTool(cards)
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=StubTool([]),  # type: ignore[arg-type]
        scryfall_tool=scryfall_tool,  # type: ignore[arg-type]
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
    assert scryfall_tool.calls == 1
    assert len(model.payloads) == 2
    assert model.payloads[0]["tool_choice"] == "required"
    assert model.payloads[1]["tool_choice"] == "none"
    assert first.debug is not None
    assert [stage.name for stage in first.debug.stages] == [
        "request_context",
        "initial_model_request",
        "initial_model_response",
        "tool_call",
        "tool_result",
        "final_model_request",
        "final_model_response",
        "validation",
    ]
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
    assert scryfall_tool.calls == 1
    assert len(model.payloads) == 2


def test_agentic_results_keep_short_title_alias_confidence(
    tmp_path: Path,
) -> None:
    model = StubModelClient([GHALTA])
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=GhaltaPreviewProvider(),  # type: ignore[arg-type]
        local_tool=StubTool([]),  # type: ignore[arg-type]
        scryfall_tool=StubTool([GHALTA]),  # type: ignore[arg-type]
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
