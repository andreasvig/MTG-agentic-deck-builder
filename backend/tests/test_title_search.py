import asyncio
import json
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid5

from mtg_deck_builder.card_catalog import CatalogEntry, card_title_aliases
from mtg_deck_builder.domain import (
    CardPrices,
    CardSearchFilters,
    CardSearchQuery,
    CardSearchResult,
)
from mtg_deck_builder.edhrec_catalog import (
    EdhrecAssociation,
    EdhrecCatalogUnavailable,
    EdhrecCommanderRanking,
)
from mtg_deck_builder.search import FuzzyTitleSearchProvider, preview_confidence_score
from mtg_deck_builder.search_debug import JsonlSearchDebugLogger

_UUID_NAMESPACE = UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f")


def make_card(
    name: str,
    *,
    colors: list[str] | None = None,
    mana_value: float = 0,
    price_eur: str | None = "0.12",
    commander_legality: str = "legal",
    type_line: str = "Card",
) -> CardSearchResult:
    identity = colors or []
    return CardSearchResult(
        oracle_id=uuid5(_UUID_NAMESPACE, f"oracle:{name}"),
        scryfall_id=uuid5(_UUID_NAMESPACE, f"printing:{name}"),
        name=name,
        layout="normal",
        mana_cost=None,
        mana_value=mana_value,
        type_line=type_line,
        oracle_text=None,
        colors=identity,
        color_identity=identity,
        image_uris=None,
        card_faces=[],
        set_code="tst",
        set_name="Test",
        collector_number="1",
        rarity="common",
        prices=CardPrices(eur=Decimal(price_eur) if price_eur else None),
        legalities={"commander": commander_legality},
        finishes=["nonfoil"],
        scryfall_url="https://scryfall.com/card/tst/1/test",
    )


FOREST = make_card("Forest", colors=["G"])
FOREST_BEAR = make_card("Forest Bear", colors=["G"], mana_value=2)
MISTY_RAINFOREST = make_card("Misty Rainforest", colors=["G", "U"])
FESTIVAL = make_card("Festival", colors=["W"], mana_value=1, price_eur="0.40")
COLORLESS = make_card("Forest Compass", price_eur=None)


class StubCatalog:
    path = Path("test-cards.sqlite3")

    def __init__(self, cards: list[CardSearchResult]) -> None:
        self._entries = tuple(
            CatalogEntry(card=card, aliases=card_title_aliases(card)) for card in cards
        )
        self.calls = 0

    async def entries(self) -> tuple[CatalogEntry, ...]:
        self.calls += 1
        return self._entries


class StubTaggerCatalog:
    def __init__(self, oracle_ids: set[UUID]) -> None:
        self.oracle_ids = frozenset(oracle_ids)
        self.calls: list[list[str]] = []

    def oracle_ids_for_tags(self, tag_ids: list[str]) -> frozenset[UUID]:
        self.calls.append(tag_ids)
        return self.oracle_ids


class StubEdhrecService:
    def __init__(
        self,
        outcome: EdhrecCommanderRanking | Exception,
    ) -> None:
        self.outcome = outcome
        self.calls: list[UUID] = []

    async def ranking_for(self, commander_oracle_id: UUID) -> EdhrecCommanderRanking:
        self.calls.append(commander_oracle_id)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def test_every_query_ranks_the_complete_local_catalog_and_exact_title_stays_first() -> None:
    catalog = StubCatalog([MISTY_RAINFOREST, FESTIVAL, FOREST_BEAR, FOREST])
    provider = FuzzyTitleSearchProvider(catalog)  # type: ignore[arg-type]

    result = asyncio.run(provider.search(CardSearchQuery(q="forest")))

    assert catalog.calls == 1
    assert [card.name for card in result.cards[:3]] == [
        "Forest",
        "Forest Bear",
        "Misty Rainforest",
    ]
    assert result.name_match_scores[FOREST.scryfall_id] == 1.0
    assert result.title_confidence_scores[FOREST.scryfall_id] == 1.0
    assert result.total_results == 4
    assert result.strategy == "fuzzy"
    assert result.interpretation == "Titles ranked locally by fuzzy similarity"
    assert result.reranked is False


def test_there_is_no_minimum_match_threshold() -> None:
    catalog = StubCatalog([FOREST, FESTIVAL])
    provider = FuzzyTitleSearchProvider(catalog)  # type: ignore[arg-type]

    result = asyncio.run(provider.search(CardSearchQuery(q="completely unrelated")))

    assert len(result.cards) == 2
    assert result.total_results == 2
    assert all(score >= 0 for score in result.name_match_scores.values())


def test_blank_title_lists_filter_matches_without_agentic_handoff() -> None:
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog([FOREST_BEAR, FOREST]),
        agentic_enabled=True,
    )

    result = asyncio.run(provider.search(CardSearchQuery(q="")))

    assert [card.name for card in result.cards] == ["Forest", "Forest Bear"]
    assert result.agentic_required is False
    assert result.interpretation == "Cards matching the selected filters"


def test_blank_filter_results_can_be_ranked_by_edhrec_inclusion() -> None:
    commander_id = uuid5(_UUID_NAMESPACE, "commander")
    service = StubEdhrecService(
        EdhrecCommanderRanking(
            associations={
                FOREST.oracle_id: EdhrecAssociation(
                    oracle_id=FOREST.oracle_id,
                    num_decks=20,
                    potential_decks=100,
                    synergy=0.1,
                ),
                FOREST_BEAR.oracle_id: EdhrecAssociation(
                    oracle_id=FOREST_BEAR.oracle_id,
                    num_decks=60,
                    potential_decks=100,
                    synergy=0.4,
                ),
            },
            source="network",
        )
    )
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog([FESTIVAL, FOREST, FOREST_BEAR, COLORLESS]),
        edhrec_service=service,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="",
                commander_oracle_id=commander_id,
                enhance_with_edhrec=True,
            )
        )
    )

    assert [card.name for card in result.cards] == [
        "Forest Bear",
        "Forest",
        "Festival",
        "Forest Compass",
    ]
    assert service.calls == [commander_id]
    assert result.edhrec.status == "applied"
    assert result.edhrec.source == "network"
    assert result.reranked is True
    assert result.interpretation == (
        "Cards matching the selected filters, ranked by EDHREC inclusion"
    )


def test_edhrec_failure_returns_normal_local_sort_with_visible_status() -> None:
    commander_id = uuid5(_UUID_NAMESPACE, "commander")
    service = StubEdhrecService(EdhrecCatalogUnavailable())
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog([FOREST_BEAR, FOREST]),
        edhrec_service=service,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="",
                commander_oracle_id=commander_id,
                enhance_with_edhrec=True,
            )
        )
    )

    assert [card.name for card in result.cards] == ["Forest", "Forest Bear"]
    assert result.edhrec.status == "unavailable"
    assert result.edhrec.message == (
        "EDHREC data could not be fetched. Results use normal local sorting."
    )
    assert result.reranked is False


def test_edhrec_is_not_used_for_typed_title_queries() -> None:
    commander_id = uuid5(_UUID_NAMESPACE, "commander")
    service = StubEdhrecService(EdhrecCatalogUnavailable())
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog([FOREST_BEAR, FOREST]),
        edhrec_service=service,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="forest",
                commander_oracle_id=commander_id,
                enhance_with_edhrec=True,
            )
        )
    )

    assert service.calls == []
    assert result.edhrec.status == "not_requested"
    assert [card.name for card in result.cards] == ["Forest", "Forest Bear"]


def test_default_safety_filters_enforce_legality_and_commander_identity() -> None:
    illegal_green = make_card(
        "Illegal Green Card",
        colors=["G"],
        commander_legality="banned",
    )
    legal_blue = make_card("Legal Blue Card", colors=["U"])
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog([FOREST, illegal_green, legal_blue]),
    )

    safe = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="card",
                filters=CardSearchFilters(commander_color_identity=["G"]),
            ),
        ),
    )
    permissive = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="card",
                filters=CardSearchFilters(
                    commander_color_identity=["G"],
                    include_non_commander_legal=True,
                    include_outside_commander_color_identity=True,
                ),
            ),
        ),
    )

    assert [card.name for card in safe.cards] == ["Forest"]
    assert {card.name for card in permissive.cards} == {
        "Forest",
        "Illegal Green Card",
        "Legal Blue Card",
    }


def test_selected_tags_filter_the_local_title_results() -> None:
    tagger = StubTaggerCatalog({FOREST_BEAR.oracle_id})
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog([FOREST, FOREST_BEAR]),
        tagger_catalog=tagger,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="forest",
                filters=CardSearchFilters(
                    tags=[{"id": "tag-bear", "name": "Bear"}],
                ),
            ),
        ),
    )

    assert [card.name for card in result.cards] == ["Forest Bear"]
    assert tagger.calls == [["tag-bear"]]


def test_required_card_types_and_subtypes_use_and_semantics() -> None:
    artifact_elf_druid = make_card(
        "Clockwork Archdruid",
        type_line="Artifact Creature — Elf Druid",
    )
    artifact_elf = make_card(
        "Clockwork Elf",
        type_line="Artifact Creature — Elf",
    )
    elf_druid = make_card(
        "Forest Archdruid",
        type_line="Creature — Elf Druid",
    )
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog([artifact_elf_druid, artifact_elf, elf_druid]),
    )

    result = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="",
                filters=CardSearchFilters(
                    card_types=["Artifact", "Creature"],
                    subtypes=["Elf", "Druid"],
                ),
            )
        )
    )

    assert [card.name for card in result.cards] == ["Clockwork Archdruid"]


def test_preview_confidence_keeps_title_segments_and_typos_but_rejects_intent() -> None:
    assert preview_confidence_score("forest", "Forest") == 1.0
    assert preview_confidence_score("forest", "Misty Rainforest") == 0.9
    assert preview_confidence_score("galta", "Ghalta") == 0.909091
    assert (
        preview_confidence_score(
            "creatures that untap elves",
            "Seeker of Skybreak",
        )
        < 0.75
    )
    assert preview_confidence_score("cheap blue card draw", "Quick Study") < 0.75
    assert preview_confidence_score("big green creatures", "Green Dragon") < 0.75


def test_results_use_simple_six_card_pages_without_a_candidate_cap() -> None:
    cards = [make_card(f"Forest Match {index}") for index in range(1, 15)]
    catalog = StubCatalog(cards)
    provider = FuzzyTitleSearchProvider(catalog)  # type: ignore[arg-type]

    first = asyncio.run(provider.search(CardSearchQuery(q="forest", page=1)))
    second = asyncio.run(provider.search(CardSearchQuery(q="forest", page=2)))
    third = asyncio.run(provider.search(CardSearchQuery(q="forest", page=3)))

    assert len(first.cards) == 6
    assert first.total_results == 14
    assert first.has_more is True
    assert len(second.cards) == 6
    assert second.total_results == 14
    assert second.has_more is True
    assert len(third.cards) == 2
    assert third.total_results == 14
    assert third.has_more is False
    assert {card.scryfall_id for card in first.cards}.isdisjoint(
        card.scryfall_id for card in second.cards
    )
    assert {card.scryfall_id for card in second.cards}.isdisjoint(
        card.scryfall_id for card in third.cards
    )


def test_agentic_handoff_requires_six_high_confidence_title_hits() -> None:
    six_cards = [make_card(f"Forest Match {index}") for index in range(1, 7)]
    six_hit_provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog(six_cards),
        agentic_enabled=True,
    )
    five_hit_provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        StubCatalog(six_cards[:5]),
        agentic_enabled=True,
    )

    complete_page = asyncio.run(six_hit_provider.search(CardSearchQuery(q="forest")))
    incomplete_page = asyncio.run(five_hit_provider.search(CardSearchQuery(q="forest")))

    assert len(complete_page.cards) == 6
    assert complete_page.agentic_required is False
    assert len(incomplete_page.cards) == 5
    assert incomplete_page.agentic_required is True


def test_structured_filters_are_applied_locally_after_fuzzy_ranking() -> None:
    catalog = StubCatalog([FOREST, FOREST_BEAR, MISTY_RAINFOREST, FESTIVAL, COLORLESS])
    provider = FuzzyTitleSearchProvider(catalog)  # type: ignore[arg-type]

    subset = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="forest",
                filters=CardSearchFilters(
                    colors=["G"],
                    mana_value_min=1,
                    mana_value_max=3,
                    price_eur_max=Decimal("0.20"),
                ),
            )
        )
    )
    exact_or_colorless = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="forest",
                filters=CardSearchFilters(
                    colors=["G"],
                    color_mode="exact",
                    include_colorless=True,
                ),
            )
        )
    )

    assert [card.name for card in subset.cards] == ["Forest Bear"]
    assert {card.name for card in exact_or_colorless.cards} == {
        "Forest",
        "Forest Bear",
        "Forest Compass",
    }


def test_debug_trace_explains_local_catalog_counts_and_fuzzy_scores(
    tmp_path: Path,
) -> None:
    log_path = tmp_path / "search.jsonl"
    catalog = StubCatalog([FOREST, FESTIVAL])
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        catalog,
        debug_logger=JsonlSearchDebugLogger(log_path),
    )

    result = asyncio.run(provider.search(CardSearchQuery(q="forest", debug=True)))

    assert result.debug is not None
    assert [stage.name for stage in result.debug.stages] == ["Local fuzzy title ranking"]
    record = json.loads(log_path.read_text(encoding="utf-8"))
    details = record["stages"][0]["details"]
    assert details["catalog_card_count"] == 2
    assert details["filtered_card_count"] == 2
    assert details["minimum_score"] is None
    assert details["preview_min_confidence"] == 0.75
    assert details["preview_candidate_count"] == 1
    assert details["agentic_search_required"] is False
    assert details["fuzzy_candidates"][0]["name"] == "Forest"
    assert details["fuzzy_candidates"][0]["score"] == 1.0
    assert details["fuzzy_candidates"][0]["preview_confidence"] == 1.0
    assert "provider_queries" not in details


def test_agentic_mode_returns_only_confident_preview_cards() -> None:
    catalog = StubCatalog([FOREST, FESTIVAL])
    provider = FuzzyTitleSearchProvider(  # type: ignore[arg-type]
        catalog,
        agentic_enabled=True,
    )

    result = asyncio.run(provider.search(CardSearchQuery(q="big green creatures")))

    assert result.cards == []
    assert result.total_results == 0
    assert result.has_more is False
    assert result.agentic_required is True
    assert result.interpretation == ("Confident title matches shown while agentic search continues")
