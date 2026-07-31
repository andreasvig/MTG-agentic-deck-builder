import asyncio
import json
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid5

import pytest
from pydantic import ValidationError

from mtg_deck_builder.agentic_card_search import (
    AgenticCardSearchService,
    AgenticCardSearchUnavailable,
    ExecutedSearchTool,
    LocalCardSearchTool,
    _normalize_tool_arguments,
    _render_filter_lines,
)
from mtg_deck_builder.agentic_search_debug import JsonlAgentSearchTraceLogger
from mtg_deck_builder.card_catalog import CatalogEntry, card_title_aliases
from mtg_deck_builder.config import AgenticSearchSettings, Settings, WeightedSortWeights
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
from mtg_deck_builder.edhrec_catalog import (
    EdhrecAssociation,
    EdhrecCommanderContext,
    EdhrecCommanderRanking,
)
from mtg_deck_builder.providers.edhrec import EdhrecDeckTheme
from mtg_deck_builder.providers.openrouter import OpenRouterError
from mtg_deck_builder.semantic_index import SemanticScoreResult

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
KALONIAN_TWINGROVE = make_card(
    "Kalonian Twingrove",
    mana_cost="{5}{G}",
    mana_value=6,
    type_line="Creature — Treefolk Warrior",
    colors=["G"],
    power="6",
    toughness="6",
)


class StubCatalog:
    path = Path("test-cards.sqlite3")

    def __init__(self, cards: list[CardSearchResult]) -> None:
        self._entries = tuple(
            CatalogEntry(card=card, aliases=card_title_aliases(card)) for card in cards
        )

    async def entries(self) -> tuple[CatalogEntry, ...]:
        return self._entries


class StubSemanticIndex:
    def __init__(self, scores: dict[UUID, float]) -> None:
        self.scores = scores
        self.queries: list[str] = []

    async def score(
        self,
        query: str,
        oracle_ids: list[UUID],
    ) -> SemanticScoreResult:
        self.queries.append(query)
        return SemanticScoreResult(
            scores={oracle_id: self.scores[oracle_id] for oracle_id in oracle_ids},
            model="test-semantic-model",
            dimensions=3,
        )


class StubTaggerCatalog:
    def oracle_ids_for_tags(self, tag_ids: list[str]) -> frozenset[UUID]:
        assert tag_ids == ["tag-dinosaur"]
        return frozenset({GHALTA.oracle_id})


def test_local_tool_treats_duplicate_mana_symbols_as_a_multiset() -> None:
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([STONECOIL, HANGARBACK]),
        default_max_results=10,
        hard_max_results=60,
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


def test_local_tool_keeps_interface_tag_filters_immutable() -> None:
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GHALTA, GIGANTOSAURUS]),
        default_max_results=10,
        hard_max_results=60,
        tagger_catalog=StubTaggerCatalog(),  # type: ignore[arg-type]
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(
                types={"must_contain_all": ["Creature"]},  # type: ignore[arg-type]
            ),
            immutable_filters=CardSearchFilters(
                tags=[{"id": "tag-dinosaur", "name": "dinosaur"}],
            ),
        ),
    )

    assert [candidate.card.name for candidate in result.candidates] == [
        "Ghalta, Primal Hunger",
    ]
    assert result.payload["compiled_query"]["immutable_filters"]["tags"] == [
        {"id": "tag-dinosaur", "name": "dinosaur"},
    ]


def test_agent_prompt_explains_immutable_commander_and_tag_filters() -> None:
    lines = _render_filter_lines(
        CardSearchFilters(
            include_non_commander_legal=False,
            include_outside_commander_color_identity=False,
            commander_color_identity=["G"],
            tags=[{"id": "tag-dinosaur", "name": "dinosaur"}],
            card_types=["Creature"],
            subtypes=["Dinosaur"],
        )
    )

    assert "- Commander legality: legal cards only" in lines
    assert "- Deck commander identity: G; cards must stay within it" in lines
    assert (
        "- Required card tags (immutable; the tool cannot remove or change these): dinosaur"
    ) in lines
    assert ("- Required card types (immutable; every value must match): Creature") in lines
    assert ("- Required card subtypes (immutable; every value must match): Dinosaur") in lines


def test_local_tool_excludes_previously_considered_oracle_cards() -> None:
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GHALTA, GIGANTOSAURUS]),
        default_max_results=10,
        hard_max_results=60,
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(power={"minimum": 4}),  # type: ignore[arg-type]
            immutable_filters=CardSearchFilters(),
            excluded_oracle_ids=frozenset({GHALTA.oracle_id}),
        )
    )

    assert [candidate.card.name for candidate in result.candidates] == ["Gigantosaurus"]
    assert result.payload["compiled_query"]["excluded_oracle_card_count"] == 1


def test_local_tool_filters_first_then_semantically_sorts_without_a_cutoff() -> None:
    semantic_index = StubSemanticIndex(
        {
            GHALTA.oracle_id: 0.71,
            GIGANTOSAURUS.oracle_id: 0.93,
            HANGARBACK.oracle_id: 0.99,
        }
    )
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([HANGARBACK, GHALTA, GIGANTOSAURUS]),
        default_max_results=10,
        hard_max_results=60,
        semantic_index=semantic_index,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(
                semantic_sort="large green creature threats",
                colors={"identity": ["G"]},  # type: ignore[arg-type]
                types={"must_contain_all": ["Creature"]},  # type: ignore[arg-type]
            ),
            immutable_filters=CardSearchFilters(),
        )
    )

    assert [candidate.card.name for candidate in result.candidates] == [
        "Gigantosaurus",
        "Ghalta, Primal Hunger",
    ]
    assert [candidate.semantic_score for candidate in result.candidates] == [
        0.93,
        0.71,
    ]
    assert result.payload["total_candidates"] == 2
    assert semantic_index.queries == ["large green creature threats"]
    assert result.payload["compiled_query"]["semantic_sort"] == {
        "mode": "cosine",
        "model": "test-semantic-model",
        "dimensions": 3,
        "query": "large green creature threats",
        "score_scale": "normalized_cosine_0_to_1",
        "minimum_score": None,
        "scored_candidates": 2,
    }


def test_local_tool_can_sort_by_edhrec_synergy_and_returns_all_ranking_evidence() -> None:
    semantic_index = StubSemanticIndex(
        {
            GHALTA.oracle_id: 0.95,
            GIGANTOSAURUS.oracle_id: 0.70,
            KALONIAN_TWINGROVE.oracle_id: 0.80,
        }
    )
    ranking = EdhrecCommanderRanking(
        associations={
            GHALTA.oracle_id: EdhrecAssociation(
                oracle_id=GHALTA.oracle_id,
                num_decks=800,
                potential_decks=1_000,
                synergy=0.10,
            ),
            GIGANTOSAURUS.oracle_id: EdhrecAssociation(
                oracle_id=GIGANTOSAURUS.oracle_id,
                num_decks=300,
                potential_decks=1_000,
                synergy=0.60,
            ),
        },
        source="cache",
    )
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GHALTA, GIGANTOSAURUS, KALONIAN_TWINGROVE]),
        default_max_results=10,
        hard_max_results=60,
        semantic_index=semantic_index,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(
                semantic_sort="large green creature threats",
                sort_by="edhrec_synergy",
            ),
            immutable_filters=CardSearchFilters(),
            edhrec_ranking=ranking,
        )
    )

    assert [candidate.card.name for candidate in result.candidates] == [
        "Gigantosaurus",
        "Ghalta, Primal Hunger",
        "Kalonian Twingrove",
    ]
    assert result.candidates[0].edhrec_inclusion == 0.3
    assert result.candidates[0].edhrec_synergy == 0.6
    assert result.candidates[0].edhrec_num_decks == 300
    assert result.candidates[0].semantic_score == 0.7
    assert result.candidates[2].edhrec_inclusion is None
    assert result.payload["compiled_query"]["primary_sort"] == "edhrec_synergy"
    assert result.payload["compiled_query"]["edhrec"]["minimum_synergy"] is None


def test_agent_tool_schema_exposes_only_the_supported_search_fields() -> None:
    # Printing-level conditions were removed on purpose: the agent searches
    # gameplay identity, and the interface owns printing choices.
    assert set(LocalCardSearchRequest.model_json_schema()["properties"]) == {
        "semantic_sort",
        "sort_by",
        "name_sort",
        "mana",
        "types",
        "colors",
        "power",
        "toughness",
        "price_eur",
        "max_results",
    }
    for removed in ({"sets": ["LCI"]}, {"rarities": ["rare"]}):
        with pytest.raises(ValidationError):
            LocalCardSearchRequest.model_validate(removed)


def _green_commander_ranking() -> EdhrecCommanderRanking:
    return EdhrecCommanderRanking(
        associations={
            GIGANTOSAURUS.oracle_id: EdhrecAssociation(
                oracle_id=GIGANTOSAURUS.oracle_id,
                num_decks=800,
                potential_decks=1_000,
                synergy=0.10,
            ),
            KALONIAN_TWINGROVE.oracle_id: EdhrecAssociation(
                oracle_id=KALONIAN_TWINGROVE.oracle_id,
                num_decks=300,
                potential_decks=1_000,
                synergy=0.20,
            ),
        },
        source="cache",
    )


def test_weighted_sort_is_the_default_and_blends_semantic_with_edhrec_inclusion() -> None:
    # Semantic alone would order Ghalta, Kalonian Twingrove, Gigantosaurus.
    semantic_index = StubSemanticIndex(
        {
            GHALTA.oracle_id: 0.95,
            KALONIAN_TWINGROVE.oracle_id: 0.80,
            GIGANTOSAURUS.oracle_id: 0.70,
        }
    )
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GHALTA, GIGANTOSAURUS, KALONIAN_TWINGROVE]),
        default_max_results=10,
        hard_max_results=60,
        weighted_weights=WeightedSortWeights(semantic=0.5, edhrec_inclusion=0.5),
        semantic_index=semantic_index,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(semantic_sort="large green creature threats"),
            immutable_filters=CardSearchFilters(),
            edhrec_ranking=_green_commander_ranking(),
        )
    )

    # 0.5*0.70 + 0.5*0.80 beats 0.5*0.80 + 0.5*0.30 beats 0.5*0.95 + 0.5*0.
    assert [candidate.card.name for candidate in result.candidates] == [
        "Gigantosaurus",
        "Kalonian Twingrove",
        "Ghalta, Primal Hunger",
    ]
    assert result.payload["compiled_query"]["primary_sort"] == "weighted"
    assert result.payload["compiled_query"]["weighted_sort"]["applied_weights"] == {
        "semantic": 0.5,
        "edhrec_inclusion": 0.5,
    }
    assert "weighted sort score 0.750" in result.candidates[0].exact_match_evidence


def test_weighted_sort_orders_like_semantic_without_commander_evidence() -> None:
    semantic_index = StubSemanticIndex(
        {
            GHALTA.oracle_id: 0.95,
            KALONIAN_TWINGROVE.oracle_id: 0.80,
            GIGANTOSAURUS.oracle_id: 0.70,
        }
    )
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GHALTA, GIGANTOSAURUS, KALONIAN_TWINGROVE]),
        default_max_results=10,
        hard_max_results=60,
        semantic_index=semantic_index,  # type: ignore[arg-type]
    )

    # Unlike the two EDHREC orderings, weighted must never reject a run without
    # commander evidence: it is the default the agent gets when it says nothing.
    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(
                semantic_sort="large green creature threats",
                sort_by="weighted",
            ),
            immutable_filters=CardSearchFilters(),
        )
    )

    assert [candidate.card.name for candidate in result.candidates] == [
        "Ghalta, Primal Hunger",
        "Kalonian Twingrove",
        "Gigantosaurus",
    ]
    assert result.payload["compiled_query"]["weighted_sort"]["applied_weights"] == {
        "semantic": 1.0,
    }


def test_weighted_sort_uses_edhrec_alone_when_no_semantic_sort_was_requested() -> None:
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GHALTA, GIGANTOSAURUS, KALONIAN_TWINGROVE]),
        default_max_results=10,
        hard_max_results=60,
    )

    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(types={"must_contain_all": ["Creature"]}),  # type: ignore[arg-type]
            immutable_filters=CardSearchFilters(),
            edhrec_ranking=_green_commander_ranking(),
        )
    )

    assert [candidate.card.name for candidate in result.candidates] == [
        "Gigantosaurus",
        "Kalonian Twingrove",
        "Ghalta, Primal Hunger",
    ]
    assert result.payload["compiled_query"]["weighted_sort"]["applied_weights"] == {
        "edhrec_inclusion": 1.0,
    }


def test_name_similarity_orders_a_misspelled_name_without_removing_anything() -> None:
    tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GIGANTOSAURUS, KALONIAN_TWINGROVE, GHALTA]),
        default_max_results=10,
        hard_max_results=60,
    )

    # "Kalonain Twingrve" matches no card title as a substring, which is exactly
    # the case the old hard filter turned into an empty page. The target also
    # sorts last alphabetically, so passing this proves the ordering is by name
    # similarity rather than by the name tie-breaker.
    result = asyncio.run(
        tool.search(
            LocalCardSearchRequest(name_sort="Kalonain Twingrve", sort_by="name_similarity"),
            immutable_filters=CardSearchFilters(),
        )
    )

    assert result.candidates[0].card.name == "Kalonian Twingrove"
    assert result.payload["total_candidates"] == 3
    assert result.payload["compiled_query"]["primary_sort"] == "name_similarity"
    assert any(
        "name similarity" in evidence
        for evidence in result.candidates[0].exact_match_evidence
    )


def test_name_sort_and_name_similarity_require_each_other() -> None:
    with pytest.raises(ValidationError, match="name_similarity sorting requires name_sort"):
        LocalCardSearchRequest(sort_by="name_similarity")
    with pytest.raises(ValidationError, match="name_sort requires sort_by name_similarity"):
        LocalCardSearchRequest(name_sort="Ghalta")
    with pytest.raises(ValidationError, match="name_sort requires sort_by name_similarity"):
        LocalCardSearchRequest(name_sort="Ghalta", sort_by="weighted")


def test_provider_shorthand_is_normalized_before_strict_validation() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {
            "name": "Ghalta",
            "types": "Creature",
            "colors": "green",
            "power": "5",
        },
    )

    assert normalized == {
        "name_sort": "Ghalta",
        "sort_by": "name_similarity",
        "types": {"must_contain_all": ["Creature"]},
        "colors": {"identity": ["G"]},
        "power": {"minimum": 5.0},
    }
    assert changes == [
        "name string -> name_sort with name_similarity ordering",
        "types string -> types.must_contain_all",
        "colors string -> colors.identity",
        "power numeric string -> power.minimum",
    ]


def test_agent_prompt_teaches_functional_versus_printed_type_vocabulary() -> None:
    prompt = Settings().search.agentic.system_prompt

    assert "# Task" in prompt
    assert "# Inputs" in prompt
    assert "# Output" in prompt
    assert "# Tools" in prompt
    assert "# Guidelines" in prompt
    assert "## How Commander players describe cards" in prompt
    # Deliberately no assertion on a `## You own your filters` heading. It carried
    # no body, so pinning it asserted nothing about what the prompt teaches while
    # blocking any tidy-up of the section list. Pin taught content, not headings.
    # Functional categories the model must leave semantic.
    for category in ("removal", "ramp", "board wipe", "tutors"):
        assert category in prompt
    # Definitional terms that do justify a printed-type filter.
    assert "mana rock" in prompt
    assert "elves are Elf" in prompt
    # The superseded lexical rule must not reappear.
    assert "only when the user's typed request names the color" not in prompt


def test_comma_joined_alternative_types_are_not_treated_as_one_literal() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {
            "types": "Instant, Sorcery, Enchantment, Artifact, Creature",
            "semantic_sort": "powerful late-game card draw",
        },
    )

    assert normalized["types"] == {
        "must_contain_any": [
            "Instant",
            "Sorcery",
            "Enchantment",
            "Artifact",
            "Creature",
        ]
    }
    assert changes == ["comma-separated types string -> types.must_contain_any"]
    LocalCardSearchRequest.model_validate(normalized)


def test_comma_joined_types_inside_required_list_are_repaired() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {"types": {"must_contain_all": ["Instant, Sorcery, Enchantment, Artifact, Creature"]}},
    )

    assert normalized["types"] == {
        "must_contain_all": [],
        "must_contain_any": [
            "Instant",
            "Sorcery",
            "Enchantment",
            "Artifact",
            "Creature",
        ],
    }
    assert changes == ["repaired non-literal or comma-joined type conditions"]
    LocalCardSearchRequest.model_validate(normalized)


def test_real_multi_type_requirement_remains_an_intersection() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {"types": {"must_contain_all": ["Artifact, Creature"]}},
    )

    assert normalized["types"] == {
        "must_contain_all": ["Artifact", "Creature"],
    }
    assert changes == ["repaired non-literal or comma-joined type conditions"]


def test_abstract_permanent_type_is_expanded_to_printed_type_alternatives() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {"types": "Permanent"},
    )

    assert normalized["types"] == {
        "must_contain_any": [
            "Artifact",
            "Battle",
            "Creature",
            "Enchantment",
            "Land",
            "Planeswalker",
        ]
    }
    assert changes == ["abstract type Permanent -> types.must_contain_any"]
    LocalCardSearchRequest.model_validate(normalized)


def test_json_encoded_nested_provider_object_is_decoded() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {
            "semantic_sort": "powerful late-game card draw",
            "colors": '{"identity":["B","G","U","W"],"mode":"subset"}',
        },
    )

    assert normalized == {
        "semantic_sort": "powerful late-game card draw",
        "colors": {
            "identity": ["B", "G", "U", "W"],
            "mode": "subset",
        },
    }
    assert changes == ["decoded JSON object string for colors"]
    LocalCardSearchRequest.model_validate(normalized)


def test_runtime_owned_legality_is_removed_and_compact_color_is_normalized() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {
            "colors": "WUBG",
            "legality": "Legal",
            "format": "Commander",
            "semantic_sort": "cards that care about Forests",
        },
    )

    assert normalized == {
        "colors": {"identity": ["W", "U", "B", "G"]},
        "semantic_sort": "cards that care about Forests",
    }
    assert changes == [
        "removed runtime-owned format filter",
        "removed runtime-owned legality filter",
        "colors string -> colors.identity",
    ]
    request = LocalCardSearchRequest.model_validate(normalized)
    assert request.colors is not None


def test_empty_provider_placeholders_are_omitted_before_validation() -> None:
    normalized, changes = _normalize_tool_arguments(
        "search_local_cards",
        {
            "colors": "...",
            "types": "…",
            "semantic_sort": "cards that care about Forests",
        },
    )

    assert normalized == {"semantic_sort": "cards that care about Forests"}
    assert changes == ["omitted placeholder colors", "omitted placeholder types"]
    assert LocalCardSearchRequest.model_validate(normalized).semantic_sort is not None


def test_nested_compact_and_colorless_identity_is_normalized() -> None:
    normalized, _ = _normalize_tool_arguments(
        "search_local_cards",
        {
            "colors": {
                "identity": ["W/U", "colorless"],
                "mode": "subset",
            },
        },
    )

    assert normalized == {
        "colors": {
            "identity": ["W", "U"],
            "mode": "subset",
            "include_colorless": True,
        },
    }


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
        self.exclusions: list[frozenset[UUID]] = []
        self.requests: list[LocalCardSearchRequest] = []

    async def search(
        self,
        request: object,
        *,
        immutable_filters: CardSearchFilters,
        excluded_oracle_ids: frozenset[UUID] = frozenset(),
    ) -> ExecutedSearchTool:
        self.calls += 1
        self.exclusions.append(excluded_oracle_ids)
        assert isinstance(request, LocalCardSearchRequest)
        self.requests.append(request)
        candidates = tuple(
            AgentSearchCandidate(
                card=card,
                semantic_score=max(0.0, 0.9 - index * 0.01),
                exact_match_evidence=["stub query matched"],
                filter_decisions={"immutable_ui_filters": True},
            )
            for index, card in enumerate(self._candidates)
            if card.oracle_id not in excluded_oracle_ids
        )
        return ExecutedSearchTool(
            name="search_local_cards",
            arguments=request.model_dump(mode="json", exclude_none=True),
            candidates=candidates,
            payload={
                "compiled_query": {
                    "engine": "local_sqlite_catalog",
                    "result_limit": 24,
                },
                "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
            },
        )

    async def cards_by_oracle_ids(
        self,
        oracle_ids: list[UUID],
    ) -> tuple[CardSearchResult, ...]:
        cards = {card.oracle_id: card for card in self._candidates}
        return tuple(cards[oracle_id] for oracle_id in oracle_ids)


class StubEdhrecCommanderService:
    def __init__(
        self,
        context: EdhrecCommanderContext,
        ranking: EdhrecCommanderRanking,
    ) -> None:
        self.context = context
        self.ranking = ranking
        self.ranking_calls: list[tuple[UUID, str | None]] = []

    async def context_for(self, _commander_oracle_id: UUID) -> EdhrecCommanderContext:
        return self.context

    async def ranking_for(
        self,
        commander_oracle_id: UUID,
        theme_slug: str | None = None,
    ) -> EdhrecCommanderRanking:
        self.ranking_calls.append((commander_oracle_id, theme_slug))
        return self.ranking


class RoundStubTool(StubTool):
    def __init__(self, rounds: list[list[CardSearchResult]]) -> None:
        super().__init__([card for round_cards in rounds for card in round_cards])
        self._rounds = rounds

    async def search(
        self,
        request: object,
        *,
        immutable_filters: CardSearchFilters,
        excluded_oracle_ids: frozenset[UUID] = frozenset(),
    ) -> ExecutedSearchTool:
        round_cards = self._rounds[self.calls]
        self.calls += 1
        self.exclusions.append(excluded_oracle_ids)
        assert isinstance(request, LocalCardSearchRequest)
        self.requests.append(request)
        candidates = tuple(
            AgentSearchCandidate(
                card=card,
                semantic_score=max(0.0, 0.9 - index * 0.01),
                exact_match_evidence=["stub query matched"],
                filter_decisions={"immutable_ui_filters": True},
            )
            for index, card in enumerate(round_cards)
            if card.oracle_id not in excluded_oracle_ids
        )
        return ExecutedSearchTool(
            name="search_local_cards",
            arguments=request.model_dump(mode="json", exclude_none=True),
            candidates=candidates,
            payload={
                "compiled_query": {
                    "engine": "local_sqlite_catalog",
                    "result_limit": 24,
                },
                "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
            },
        )


class SequentialModelClient:
    def __init__(self, ranked_ids_by_round: list[list[int]]) -> None:
        self.payloads: list[dict[str, object]] = []
        self._ranked_ids_by_round = ranked_ids_by_round

    async def chat_completion(
        self,
        payload: dict[str, object],
    ) -> dict[str, object]:
        call_index = len(self.payloads)
        self.payloads.append(payload)
        round_index = call_index // 2
        if call_index % 2 == 0:
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": f"tool-call-{round_index + 1}",
                                    "type": "function",
                                    "function": {
                                        "name": "search_local_cards",
                                        "arguments": json.dumps({"power": {"minimum": 4}}),
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        return {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": json.dumps(
                            {
                                "interpretation": (
                                    f"Additional large creatures, round {round_index + 1}."
                                ),
                                "ranked_ids": self._ranked_ids_by_round[round_index],
                            }
                        ),
                    }
                }
            ]
        }


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


class VernacularModelClient(StubModelClient):
    """Returns a printed-type filter the user's wording never names."""

    def __init__(self, cards: list[CardSearchResult]) -> None:
        super().__init__(cards)
        self._responses[0]["choices"][0]["message"]["tool_calls"][0]["function"][
            "arguments"
        ] = json.dumps(
            {
                "semantic_sort": "low-cost artifacts that produce mana",
                "types": {"must_contain_all": ["Artifact"]},
                "mana": {"value_maximum": 2},
                "max_results": 24,
            }
        )


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
    assert failed_details["provider_response"] == {"error": {"message": "Rate limit exceeded"}}
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
    assert debug.trace["stages"][2]["details"]["error_type"] == ("CardSearchUnavailable")
    assert (
        "Magic: The Gathering card-search agent" in (debug.trace["stages"][0]["details"]["content"])
    )
    assert "## Request\ngreen big creature" in (
        debug.trace["stages"][1]["details"]["content"]
    )


def test_agent_filters_reach_the_tool_even_when_the_query_never_names_them(
    tmp_path: Path,
) -> None:
    """Vernacular queries keep the agent's own hard filters.

    "cheap mana rocks" names no printed type, so the superseded runtime
    guardrail deleted the agent's Artifact filter. The agent now owns that
    decision and the tool must receive it verbatim.
    """

    cards = [GHALTA, GIGANTOSAURUS]
    model = VernacularModelClient(cards)
    local_tool = StubTool(cards)
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=local_tool,  # type: ignore[arg-type]
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=2,
        trace_logger=JsonlAgentSearchTraceLogger(trace_path),
        trace_log_path=str(trace_path),
        debug_default_enabled=False,
    )

    result = asyncio.run(
        service.search(AgenticCardSearchRequest(q="cheap mana rocks", debug=True))
    )

    assert result.strategy == "agentic"
    assert local_tool.calls == 1
    executed = local_tool.requests[0]
    assert executed.types is not None
    assert executed.types.must_contain_all == ["Artifact"]
    assert executed.mana is not None
    assert executed.mana.value_maximum == 2
    # No stage of the persisted trace may report a stripped filter.
    trace = trace_path.read_text()
    assert "Artifact" in trace
    assert "removed redundant or unrequested type filters" not in trace
    assert "did not ask to restrict result colors" not in trace


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
    assert local_tool.requests[0].semantic_sort == "green big creature"
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
    assert "## Request\ngreen big creature" in initial_user_message
    assert "image_uris" not in initial_user_message
    final_messages = model.payloads[1]["messages"]
    assert isinstance(final_messages, list)
    tool_message = final_messages[-1]["content"]
    assert isinstance(tool_message, str)
    assert "ID 1" in tool_message
    assert "Semantic closeness: 0.9000 (0-1)" in tool_message
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
    assert "## Request\ngreen big creature" in presentation_stages[1]["details"]["content"]
    assert presentation_stages[2]["details"]["reasoning"].startswith("The query asks")
    tool_result_trace = first.debug.trace["stages"][4]["details"]
    assert tool_result_trace["raw_tool_result"]["candidates"]
    assert tool_result_trace["message_to_agent"].startswith("## Search")
    assert tool_result_trace["numbered_candidates"][0]["id"] == 1
    assert tool_result_trace["numbered_candidates"][0]["semantic_score"] == 0.9
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


def test_agent_prompt_and_tool_response_include_commander_theme_and_edhrec_scores(
    tmp_path: Path,
) -> None:
    ranking = EdhrecCommanderRanking(
        associations={
            GHALTA.oracle_id: EdhrecAssociation(
                oracle_id=GHALTA.oracle_id,
                num_decks=45,
                potential_decks=60,
                synergy=0.5,
            ),
            GIGANTOSAURUS.oracle_id: EdhrecAssociation(
                oracle_id=GIGANTOSAURUS.oracle_id,
                num_decks=30,
                potential_decks=60,
                synergy=0.35,
            ),
        },
        source="cache",
    )
    edhrec_service = StubEdhrecCommanderService(
        EdhrecCommanderContext(
            commander_oracle_id=GHALTA.oracle_id,
            commander_name=GHALTA.name,
            themes=(
                EdhrecDeckTheme(slug="stompy", name="Stompy", deck_count=200),
                EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=60),
                *(
                    EdhrecDeckTheme(
                        slug=f"theme-{index}",
                        name=f"Theme {index}",
                        deck_count=60 - index,
                    )
                    for index in range(3, 12)
                ),
            ),
            source="cache",
        ),
        ranking,
    )
    model = StubModelClient([GHALTA, GIGANTOSAURUS])
    local_tool = LocalCardSearchTool(  # type: ignore[arg-type]
        StubCatalog([GHALTA, GIGANTOSAURUS]),
        default_max_results=24,
        hard_max_results=60,
        semantic_index=StubSemanticIndex(
            {
                GHALTA.oracle_id: 0.9,
                GIGANTOSAURUS.oracle_id: 0.8,
            }
        ),  # type: ignore[arg-type]
    )
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=local_tool,
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=6,
        trace_logger=JsonlAgentSearchTraceLogger(trace_path),
        trace_log_path=str(trace_path),
        debug_default_enabled=False,
        edhrec_service=edhrec_service,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="large threats",
                commander_oracle_id=GHALTA.oracle_id,
                enhance_with_edhrec=True,
                edhrec_theme="tokens",
                debug=True,
            )
        )
    )

    initial_messages = model.payloads[0]["messages"]
    assert isinstance(initial_messages, list)
    user_message = initial_messages[1]["content"]
    assert isinstance(user_message, str)
    assert "## Commander" in user_message
    assert "EDHREC evidence: available" in user_message
    assert "Ghalta, Primal Hunger" in user_message
    assert "Selected theme: Tokens (tokens)" in user_message
    assert "Advertised themes: Stompy, Tokens" in user_message
    assert "Theme 10" in user_message
    assert "Theme 11" not in user_message
    assert "decks; slug" not in user_message
    # sort_by guidance belongs to the system prompt, not this data section.
    assert "sort_by" not in user_message
    final_messages = model.payloads[1]["messages"]
    assert isinstance(final_messages, list)
    tool_message = final_messages[-1]["content"]
    assert isinstance(tool_message, str)
    assert "EDHREC commander fit: inclusion 0.7500 (45/60 decks); synergy 0.5000" in (
        tool_message
    )
    assert result.edhrec.status == "applied"
    assert result.edhrec.source == "cache"
    assert edhrec_service.ranking_calls == [(GHALTA.oracle_id, "tokens")]
    assert result.debug is not None
    tool_call = result.debug.trace["stages"][3]["details"]
    # The agent owns its own hard filters; nothing strips them after validation.
    assert tool_call["arguments"]["types"]["must_contain_all"] == ["Creature"]
    assert tool_call["arguments"]["colors"]["identity"] == ["G"]
    assert tool_call["provider_boundary_normalizations"] == [
        "semantic_sort defaulted to the user's request"
    ]


def test_exhausted_session_runs_one_continuation_with_already_shown_cards(
    tmp_path: Path,
) -> None:
    model = SequentialModelClient([[1], [2]])
    local_tool = RoundStubTool([[GHALTA], [GIGANTOSAURUS]])
    trace_path = tmp_path / "search.jsonl"
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=local_tool,  # type: ignore[arg-type]
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=6,
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
    assert first.cards == [GHALTA]
    assert first.has_more is False
    assert first.search_session_id is not None

    second = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="green big creature",
                page=2,
                debug=True,
                search_session_id=first.search_session_id,
                already_shown_oracle_ids=[GHALTA.oracle_id],
            )
        )
    )

    assert second.cards == [GIGANTOSAURUS]
    assert second.total_results == 2
    assert second.has_more is False
    assert local_tool.calls == 2
    assert GHALTA.oracle_id in local_tool.exclusions[1]
    continuation_messages = model.payloads[2]["messages"]
    assert isinstance(continuation_messages, list)
    continuation_prompt = continuation_messages[1]["content"]
    assert isinstance(continuation_prompt, str)
    assert "## Previous tool searches" in continuation_prompt
    assert "## Round\n2" in continuation_prompt
    assert "Round 1:" in continuation_prompt
    assert '"semantic_sort": "green big creature"' in continuation_prompt
    assert '"minimum": 4.0' in continuation_prompt
    assert "## Already showing" in continuation_prompt
    # The user message carries data only; broadening guidance lives in the system prompt.
    assert "Do not" not in continuation_prompt
    assert "Ghalta, Primal Hunger" in continuation_prompt
    assert "Power/Toughness: 12/12" in continuation_prompt
    assert "Oracle text:" in continuation_prompt
    assert "## Round\n2" in continuation_prompt
    assert second.debug is not None
    assert second.debug.trace["request"]["round_number"] == 2


def test_empty_continuation_is_successful_and_can_be_retried(
    tmp_path: Path,
) -> None:
    model = SequentialModelClient([[1], [], [2]])
    local_tool = RoundStubTool([[GHALTA], [], [KALONIAN_TWINGROVE]])
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=local_tool,  # type: ignore[arg-type]
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=6,
        trace_logger=JsonlAgentSearchTraceLogger(tmp_path / "search.jsonl"),
        trace_log_path=str(tmp_path / "search.jsonl"),
        debug_default_enabled=False,
    )

    first = asyncio.run(service.search(AgenticCardSearchRequest(q="green big creature")))
    assert first.search_session_id is not None
    empty = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="green big creature",
                page=2,
                search_session_id=first.search_session_id,
                already_shown_oracle_ids=[GHALTA.oracle_id],
            )
        )
    )
    assert empty.cards == []
    assert empty.warnings == ["No additional matches found in this pass."]

    retried = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="green big creature",
                page=3,
                search_session_id=first.search_session_id,
                already_shown_oracle_ids=[GHALTA.oracle_id],
            )
        )
    )
    assert retried.cards == [KALONIAN_TWINGROVE]
    assert retried.total_results == 2
    assert local_tool.calls == 3
    third_round_messages = model.payloads[4]["messages"]
    assert isinstance(third_round_messages, list)
    third_round_prompt = third_round_messages[1]["content"]
    assert isinstance(third_round_prompt, str)
    assert third_round_prompt.count("\nRound ") == 2
    assert "Round 1:" in third_round_prompt
    assert "Round 2:" in third_round_prompt
    assert "## Round\n3" in third_round_prompt


def test_empty_initial_result_can_start_a_continuation(
    tmp_path: Path,
) -> None:
    model = SequentialModelClient([[], [1]])
    local_tool = RoundStubTool([[], [GIGANTOSAURUS]])
    service = AgenticCardSearchService(
        fuzzy_provider=StubFuzzyProvider(),  # type: ignore[arg-type]
        local_tool=local_tool,  # type: ignore[arg-type]
        model_client=model,  # type: ignore[arg-type]
        settings=AgenticSearchSettings(enabled=True),
        page_size=6,
        trace_logger=JsonlAgentSearchTraceLogger(tmp_path / "search.jsonl"),
        trace_log_path=str(tmp_path / "search.jsonl"),
        debug_default_enabled=False,
    )

    first = asyncio.run(service.search(AgenticCardSearchRequest(q="green big creature")))
    assert first.cards == []
    assert first.search_session_id is not None

    second = asyncio.run(
        service.search(
            AgenticCardSearchRequest(
                q="green big creature",
                page=2,
                search_session_id=first.search_session_id,
                already_shown_oracle_ids=[],
            )
        )
    )
    assert second.cards == [GIGANTOSAURUS]
    continuation_messages = model.payloads[2]["messages"]
    assert isinstance(continuation_messages, list)
    prompt = continuation_messages[1]["content"]
    assert isinstance(prompt, str)
    assert "## Previous tool searches" in prompt
    assert "Already showing" in prompt
    assert "## Already showing\nNone" in prompt


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
    assert "## Fuzzy matches already shown" in initial_user_message
    assert "ID 1 [ALREADY SHOWN]" in initial_user_message
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
