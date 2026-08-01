import asyncio
import re
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest

from mtg_deck_builder.agentic_card_search import LocalCardSearchTool
from mtg_deck_builder.card_catalog import CardSearchUnavailable
from mtg_deck_builder.config import DeckAgentToolSettings
from mtg_deck_builder.deck_agent_tools import (
    READ_DECK,
    SEARCH_CARDS,
    SEE_CARDS,
    DeckAgentToolbox,
    SearchCardsArguments,
)
from mtg_deck_builder.domain import (
    CardEnrichment,
    CardFace,
    CardPrices,
    CardSearchResult,
    CardTag,
    DeckAgentDeckCard,
    DeckAgentDeckSnapshot,
    EdhrecDeckTheme,
    LocalCardSearchRequest,
    RelatedOracleCard,
)
from mtg_deck_builder.edhrec_catalog import (
    EdhrecAssociation,
    EdhrecCatalogUnavailable,
    EdhrecCommanderContext,
    EdhrecCommanderRanking,
    EdhrecSimilarCardList,
    EdhrecSimilarSuggestion,
)
from mtg_deck_builder.semantic_index import SemanticScoreResult
from mtg_deck_builder.tagger_catalog import TaggerCatalogUnavailable

GHALTA = UUID("11111111-1111-4111-8111-111111111111")
SOL_RING = UUID("22222222-2222-4222-8222-222222222222")
FOREST = UUID("33333333-3333-4333-8333-333333333333")
ELVES = UUID("44444444-4444-4444-8444-444444444444")

# Cards EDHREC returns as similar to something in the deck. They are not catalog
# entries: `similar` reports the names EDHREC and Tagger gave, resolved or not.
MANA_VAULT = UUID("55555555-5555-4555-8555-555555555555")
BASALT_MONOLITH = UUID("66666666-6666-4666-8666-666666666666")

# Cards the search tests need. Declared here rather than beside SEARCHABLE below so the
# EDHREC stub can name the two that have commander pages.
MARWYN = UUID("77777777-7777-4777-8777-777777777777")
BOLT = UUID("88888888-8888-4888-8888-888888888888")
UNSTABLE = UUID("99999999-9999-4999-8999-999999999999")

PRINTING = {
    GHALTA: UUID("aaaaaaaa-1111-4111-8111-111111111111"),
    SOL_RING: UUID("aaaaaaaa-2222-4222-8222-222222222222"),
    FOREST: UUID("aaaaaaaa-3333-4333-8333-333333333333"),
    ELVES: UUID("aaaaaaaa-4444-4444-8444-444444444444"),
}


def make_card(
    oracle_id: UUID,
    name: str,
    type_line: str,
    **overrides: Any,
) -> CardSearchResult:
    values: dict[str, Any] = {
        "oracle_id": oracle_id,
        "scryfall_id": PRINTING[oracle_id],
        "name": name,
        "layout": "normal",
        "mana_cost": "{1}",
        "mana_value": 1,
        "type_line": type_line,
        "oracle_text": f"{name} does something.",
        "colors": [],
        "color_identity": [],
        "card_faces": [],
        "set_code": "tst",
        "set_name": "Test Set",
        "collector_number": "1",
        "rarity": "rare",
        "prices": CardPrices(eur="1.50"),
        "legalities": {"commander": "legal"},
        "finishes": ["nonfoil"],
        "scryfall_url": f"https://scryfall.com/card/tst/1/{name.lower()}",
    }
    values.update(overrides)
    return CardSearchResult(**values)


CARDS = {
    GHALTA: make_card(
        GHALTA,
        "Ghalta, Primal Hunger",
        "Legendary Creature — Elder Dinosaur",
        mana_cost="{12}{G}",
        mana_value=13,
        power="12",
        toughness="12",
        oracle_text="Trample",
    ),
    SOL_RING: make_card(
        SOL_RING,
        "Sol Ring",
        "Artifact",
        oracle_text="{T}: Add {C}{C}.",
        prices=CardPrices(eur="1.85", eur_foil="4.20", usd="2.10"),
    ),
    # An artifact land, to pin which type wins when a card has two.
    FOREST: make_card(FOREST, "Ancient Den", "Artifact Land"),
    ELVES: make_card(
        ELVES,
        "Llanowar Elves",
        "Creature — Elf Druid",
        power="1",
        toughness="1",
        prices=CardPrices(),
    ),
}


@dataclass
class _Entry:
    card: CardSearchResult


class StubCardCatalog:
    def __init__(self, *, cards: dict[UUID, CardSearchResult] | None = None) -> None:
        self._cards = CARDS if cards is None else cards
        self.entry_reads = 0

    async def entries(self) -> tuple[_Entry, ...]:
        self.entry_reads += 1
        return tuple(_Entry(card=card) for card in self._cards.values())

    async def oracle_ids_by_scryfall_ids(
        self,
        scryfall_ids: list[UUID],
    ) -> dict[UUID, UUID]:
        by_printing = {card.scryfall_id: card.oracle_id for card in self._cards.values()}
        return {
            scryfall_id: by_printing[scryfall_id]
            for scryfall_id in scryfall_ids
            if scryfall_id in by_printing
        }

    async def oracle_ids_by_names(self, names: list[str]) -> dict[str, UUID]:
        by_name = {card.name.casefold(): card.oracle_id for card in self._cards.values()}
        return {
            name.casefold(): by_name[name.casefold()]
            for name in names
            if name.casefold() in by_name
        }


class UnavailableCardCatalog(StubCardCatalog):
    async def entries(self) -> tuple[_Entry, ...]:
        raise CardSearchUnavailable("catalog is being replaced")

    async def oracle_ids_by_scryfall_ids(
        self,
        scryfall_ids: list[UUID],
    ) -> dict[UUID, UUID]:
        raise CardSearchUnavailable("catalog is being replaced")


TAGS = {
    SOL_RING: ["fast mana"],
    ELVES: ["mana dork"],
}

# Three groups that render and two that must not: `referenced_by` is deliberately
# unrendered by the interface too, and an empty group must not print an empty heading.
# `upgrades` is populated on purpose even though it is not needed to prove grouping —
# without it, reordering the group list is unobservable and its deliberate order
# ("what to play instead comes first") would be untested.
RELATIONSHIPS = {
    ELVES: {
        "upgrades": ["Bloom Tender"],
        "similar_cards": ["Elvish Mystic", "Fyndhorn Elves"],
        "downgrades": ["Woodland Mystic"],
        # Also similar, on purpose: a cross-reference is a different axis, so it must
        # NOT claim the card away from the merged similar list the way Outclasses does.
        "related_cards": ["Elvish Mystic"],
        "referenced_by": ["Elvish Archdruid"],
        "variants": [],
    }
}


class StubTaggerCatalog:
    def card_enrichment(self, oracle_id: UUID) -> CardEnrichment:
        related = {
            field: [
                RelatedOracleCard(oracle_id=MANA_VAULT, name=name) for name in names
            ]
            for field, names in RELATIONSHIPS.get(oracle_id, {}).items()
        }
        return CardEnrichment(
            oracle_id=oracle_id,
            tags=[
                CardTag(id=f"t{index}", name=name, slug=name.replace(" ", "-"))
                for index, name in enumerate(TAGS.get(oracle_id, []))
            ],
            **related,
        )


class UnavailableTaggerCatalog:
    def card_enrichment(self, oracle_id: UUID) -> CardEnrichment:
        raise TaggerCatalogUnavailable(str(oracle_id))


# The cards a commander page exists for: a legendary creature, not an artifact.
_HAS_COMMANDER_PAGE = frozenset({GHALTA, MARWYN})


class StubEdhrecService:
    def __init__(self, *, associations: dict[UUID, EdhrecAssociation] | None = None) -> None:
        self.ranking_calls: list[UUID] = []
        self.context_calls: list[UUID] = []
        self._associations = (
            associations
            if associations is not None
            else {
                SOL_RING: EdhrecAssociation(
                    oracle_id=SOL_RING,
                    num_decks=8_200,
                    potential_decks=10_000,
                    synergy=0.11,
                )
            }
        )

    async def ranking_for(
        self,
        commander_oracle_id: UUID,
        theme_slug: str | None = None,
    ) -> EdhrecCommanderRanking:
        self.ranking_calls.append(commander_oracle_id)
        return EdhrecCommanderRanking(associations=self._associations, source="cache")

    async def context_for(self, commander_oracle_id: UUID) -> EdhrecCommanderContext:
        self.context_calls.append(commander_oracle_id)
        if commander_oracle_id not in _HAS_COMMANDER_PAGE:
            # EDHREC only publishes a commander page for a card that can legally be
            # one, so a stub that answers for Sol Ring would hide the very branch that
            # tells the agent why a card has no themes.
            raise EdhrecCatalogUnavailable("not a commander")
        return EdhrecCommanderContext(
            commander_oracle_id=commander_oracle_id,
            commander_name="stub commander",
            # Ten, so the header's cap is observable. EDHREC really does advertise
            # sixty-odd for a popular commander, ordered by deck count, with a tail of
            # themes backed by a single deck.
            themes=tuple(
                EdhrecDeckTheme(
                    slug=slug,
                    name=slug.replace("-", " ").title(),
                    deck_count=count,
                )
                for slug, count in (
                    ("elfball", 900),
                    ("counters", 300),
                    ("combo", 250),
                    ("ramp", 222),
                    ("aggro", 106),
                    ("tokens", 87),
                    ("big-mana", 58),
                    ("midrange", 37),
                    ("storm", 2),
                    ("unnatural", 1),
                )
            ),
            source="cache",
        )

    async def similar_cards_for(self, oracle_id: UUID) -> EdhrecSimilarCardList:
        # Against ELVES' Tagger data each of these does one job, so the merge, the
        # dedup, its case-insensitivity and the more-specific-group rule are all
        # observable at once. A name EDHREC returned that the catalog could not resolve
        # is passed through as EDHREC spelled it, which is why case matters.
        return EdhrecSimilarCardList(
            oracle_id=oracle_id,
            suggestions=(
                EdhrecSimilarSuggestion(
                    rank=1, name="Fyndhorn Elves", oracle_id=BASALT_MONOLITH
                ),
                EdhrecSimilarSuggestion(rank=2, name="elvish mystic", oracle_id=None),
                EdhrecSimilarSuggestion(rank=3, name="Woodland Mystic", oracle_id=None),
                EdhrecSimilarSuggestion(rank=4, name="Mana Vault", oracle_id=MANA_VAULT),
            ),
            source="cache",
        )


class UnavailableEdhrecService(StubEdhrecService):
    async def ranking_for(
        self,
        commander_oracle_id: UUID,
        theme_slug: str | None = None,
    ) -> EdhrecCommanderRanking:
        raise EdhrecCatalogUnavailable("no EDHREC page")

    async def context_for(self, commander_oracle_id: UUID) -> EdhrecCommanderContext:
        raise EdhrecCatalogUnavailable("no EDHREC page")

    async def similar_cards_for(self, oracle_id: UUID) -> EdhrecSimilarCardList:
        raise EdhrecCatalogUnavailable("no EDHREC page")


def make_toolbox(
    *,
    card_catalog: Any = None,
    tagger_catalog: Any = None,
    edhrec_service: Any = None,
    local_tool: Any = None,
    **settings: Any,
) -> DeckAgentToolbox:
    return DeckAgentToolbox(
        card_catalog=StubCardCatalog() if card_catalog is None else card_catalog,
        tagger_catalog=StubTaggerCatalog() if tagger_catalog is None else tagger_catalog,
        edhrec_service=StubEdhrecService() if edhrec_service is None else edhrec_service,
        settings=DeckAgentToolSettings(**settings),
        local_tool=local_tool,
    )


def make_deck(*, commander: bool = True) -> DeckAgentDeckSnapshot:
    cards = [
        DeckAgentDeckCard(
            scryfall_id=PRINTING[SOL_RING],
            quantity=1,
            section="mainboard",
            group="Ramp",
        ),
        DeckAgentDeckCard(
            scryfall_id=PRINTING[FOREST], quantity=1, section="mainboard"
        ),
        DeckAgentDeckCard(scryfall_id=PRINTING[ELVES], quantity=1, section="mainboard"),
    ]
    if commander:
        cards.insert(
            0,
            DeckAgentDeckCard(
                scryfall_id=PRINTING[GHALTA],
                quantity=1,
                section="command_zone",
            ),
        )
    return DeckAgentDeckSnapshot(name="Ghalta Stompy", cards=cards)


def run(toolbox: DeckAgentToolbox, name: str, arguments: Any, deck: Any) -> Any:
    return asyncio.run(toolbox.run(name, arguments, deck=deck))


def test_read_deck_groups_by_primary_type_without_card_text() -> None:
    outcome = run(make_toolbox(), READ_DECK, {}, make_deck())

    assert outcome.ok is True
    assert outcome.signature == "read_deck()"
    assert 'Deck "Ghalta Stompy" — 4 cards, 4 distinct.' in outcome.content
    assert "Commander (1)" in outcome.content
    assert "Ghalta, Primal Hunger" in outcome.content
    assert "Creature (1)" in outcome.content
    assert "Llanowar Elves" in outcome.content
    # An artifact land is filed under Land, matching the board on screen.
    assert "Land (1)" in outcome.content
    assert "Ancient Den" in outcome.content
    assert "Artifact (1)" in outcome.content
    # The custom group the card sits in is part of how the user sees the deck.
    assert "[group: Ramp]" in outcome.content
    # The whole point of read_deck is that it is cheap: no rules text.
    assert "Add {C}{C}" not in outcome.content
    assert "Trample" not in outcome.content


def test_read_deck_reports_an_empty_command_zone_and_an_empty_deck() -> None:
    without_commander = run(make_toolbox(), READ_DECK, {}, make_deck(commander=False))
    empty = run(
        make_toolbox(),
        READ_DECK,
        {},
        DeckAgentDeckSnapshot(name="Untitled", cards=[]),
    )
    no_deck = run(make_toolbox(), READ_DECK, {}, None)

    assert "Commander (0)" in without_commander.content
    assert "completely empty" in empty.content
    assert "No deck is open" in no_deck.content
    # None of these are failures: the agent should ask, not report a broken tool.
    assert all(outcome.ok for outcome in (without_commander, empty, no_deck))


def test_read_deck_reports_a_printing_the_catalog_does_not_know() -> None:
    stranger = UUID("bbbbbbbb-9999-4999-8999-999999999999")
    deck = DeckAgentDeckSnapshot(
        name="Ghalta Stompy",
        cards=[
            DeckAgentDeckCard(
                scryfall_id=PRINTING[SOL_RING], quantity=1, section="mainboard"
            ),
            DeckAgentDeckCard(scryfall_id=stranger, quantity=1, section="mainboard"),
        ],
    )

    outcome = run(make_toolbox(), READ_DECK, {}, deck)

    # A deck list that is quietly one card short is worse than one that says so.
    assert "Not in the local catalog (1)" in outcome.content
    assert str(stranger) in outcome.content


def test_read_deck_short_ids_resolve_in_see_cards() -> None:
    toolbox = make_toolbox()
    deck = make_deck()
    listing = run(toolbox, READ_DECK, {}, deck)

    # Take the handle the agent was actually given rather than assuming its length.
    line = next(line for line in listing.content.splitlines() if "Sol Ring" in line)
    short_id = line.split("[", 1)[1].split("]", 1)[0]
    assert 8 <= len(short_id) < 36

    outcome = run(toolbox, SEE_CARDS, {"cards": [short_id]}, deck)

    assert "Sol Ring" in outcome.content
    assert "Add {C}{C}" in outcome.content
    assert "Not found" not in outcome.content


def test_short_ids_lengthen_rather_than_collide() -> None:
    from mtg_deck_builder.deck_agent_tools import _short_ids

    shared = [
        UUID("cccccccc-cccc-4ccc-8ccc-cccccccccc01"),
        UUID("cccccccc-cccc-4ccc-8ccc-cccccccccc02"),
    ]

    prefixes = _short_ids(shared)

    # Two handles that resolve to two cards would make see_cards ambiguous, so the
    # prefix grows until it cannot happen.
    assert len(set(prefixes.values())) == 2
    assert all(prefix in str(oracle_id) for oracle_id, prefix in prefixes.items())


def test_see_cards_resolves_names_ids_and_reports_what_it_cannot() -> None:
    deck = make_deck()
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {
            "cards": [
                "sol ring",
                str(GHALTA),
                str(PRINTING[ELVES]),
                "Blightsteel Colossus",
            ]
        },
        deck,
    )

    assert "Sol Ring" in outcome.content
    assert "Ghalta, Primal Hunger" in outcome.content
    assert "Llanowar Elves" in outcome.content
    assert "Not found: Blightsteel Colossus" in outcome.content


def test_see_cards_reports_only_the_requested_details() -> None:
    deck = make_deck()
    rules_only = run(make_toolbox(), SEE_CARDS, {"cards": ["Sol Ring"]}, deck)
    everything = run(
        make_toolbox(),
        SEE_CARDS,
        {
            "cards": ["Sol Ring"],
            "details": ["rules", "prices", "tags", "similar", "inclusion", "legality"],
        },
        deck,
    )

    # `details` defaults to rules, so an unasked-for EDHREC lookup never happens.
    assert "Add {C}{C}" in rules_only.content
    assert "Price" not in rules_only.content
    assert "Inclusion" not in rules_only.content

    assert "EUR 1.85" in everything.content
    assert "fast mana" in everything.content
    assert "Mana Vault" in everything.content
    assert "82% of 8,200 Ghalta, Primal Hunger decks" in everything.content
    assert "synergy +0.11" in everything.content
    assert "Commander legality: legal" in everything.content


def test_see_cards_signature_names_the_cards_and_the_depth() -> None:
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {"cards": ["Sol Ring", "Llanowar Elves"], "details": ["prices"]},
        make_deck(),
    )

    # This string is what the chat shows the user, so it is part of the contract.
    assert outcome.signature == "see_cards(Sol Ring, Llanowar Elves · prices)"


def test_see_cards_truncates_loudly_rather_than_silently() -> None:
    outcome = run(
        make_toolbox(see_cards_max_cards=1),
        SEE_CARDS,
        {"cards": ["Sol Ring", "Llanowar Elves"]},
        make_deck(),
    )

    assert "Sol Ring" in outcome.content
    # Being handed less than was asked for, with no word of it, would read as "that
    # is all there is".
    assert "Only the first 1 cards were read" in outcome.content
    assert "Llanowar Elves" in outcome.content
    assert "1 not read" in outcome.signature


def test_see_cards_reports_a_missing_price_as_missing_not_free() -> None:
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {"cards": ["Llanowar Elves"], "details": ["prices"]},
        make_deck(),
    )

    assert "no price reported" in outcome.content
    assert "0.00" not in outcome.content


def test_inclusion_needs_a_commander_and_says_when_there_is_none() -> None:
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {"cards": ["Sol Ring"], "details": ["inclusion"]},
        make_deck(commander=False),
    )

    assert "needs a commander" in outcome.content


def test_a_card_edhrec_does_not_list_is_not_reported_as_zero() -> None:
    outcome = run(
        make_toolbox(edhrec_service=StubEdhrecService(associations={})),
        SEE_CARDS,
        {"cards": ["Sol Ring"], "details": ["inclusion"]},
        make_deck(),
    )

    assert "not among the cards EDHREC lists" in outcome.content
    assert "0%" not in outcome.content


def test_a_card_block_labels_and_quotes_every_field() -> None:
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {"cards": ["Llanowar Elves"], "details": ["rules"]},
        make_deck(),
    )

    # This block is prompt text the model reads, so its shape is the contract: one
    # labelled field per line, every free-text value quoted, and the type line split
    # so a name cannot be mistaken for a type.
    assert outcome.content == "\n".join(
        [
            'Name: "Llanowar Elves"',
            '  Types: "Creature"',
            '  Subtypes: "Elf Druid"',
            '  Mana cost: "{1}"',
            "  Mana value: 1",
            "  Power/toughness: 1/1",
            '  Rules: "Llanowar Elves does something."',
        ]
    )


def test_a_two_word_subtype_is_not_split_but_two_card_types_are() -> None:
    outcome = run(make_toolbox(), SEE_CARDS, {"cards": ["Ancient Den"]}, make_deck())
    ghalta = run(
        make_toolbox(), SEE_CARDS, {"cards": ["Ghalta, Primal Hunger"]}, make_deck()
    )

    # Card types and supertypes are always single words, so they become separate
    # values; a subtype need not be (`Time Lord`), so that side is kept as printed.
    assert '  Types: "Artifact", "Land"' in outcome.content
    assert "  Subtypes:" not in outcome.content
    assert '  Types: "Legendary", "Creature"' in ghalta.content
    assert '  Subtypes: "Elder Dinosaur"' in ghalta.content


def test_a_double_faced_type_line_is_reported_as_printed() -> None:
    delver = make_card(
        ELVES,
        "Delver of Secrets // Insectile Aberration",
        "Creature — Human Wizard // Creature — Human Insect",
        card_faces=[
            CardFace(name="Delver of Secrets", oracle_text="Look at the top card."),
            CardFace(name="Insectile Aberration", oracle_text="Flying."),
        ],
    )
    outcome = run(
        make_toolbox(card_catalog=StubCardCatalog(cards={ELVES: delver})),
        SEE_CARDS,
        {"cards": ["Delver of Secrets // Insectile Aberration"], "details": ["rules"]},
        make_deck(commander=False),
    )

    # Two type lines joined by `//` cannot be split into one card's worth of fields,
    # so splitting is skipped rather than producing types that belong to a face.
    assert '  Types: "Creature — Human Wizard // Creature — Human Insect"' in outcome.content
    assert "  Subtypes:" not in outcome.content
    assert '    "Delver of Secrets" — rules: "Look at the top card."' in outcome.content


def test_details_are_reported_in_one_order_however_they_were_asked_for() -> None:
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {"cards": ["Sol Ring"], "details": ["similar", "prices", "rules", "similar"]},
        make_deck(),
    )
    content = outcome.content

    # Asked for similar first; it is still reported last, under the card's own facts.
    assert content.index("  Rules:") < content.index("  Price:") < content.index("  Similar:")
    # A detail asked for twice is reported once, and the tool line the user sees
    # names the details in the order the body actually used.
    assert content.count("  Similar:") == 1
    assert outcome.signature == "see_cards(Sol Ring · rules, prices, similar)"


def test_similar_merges_both_sources_and_names_each_card_once() -> None:
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {"cards": ["Llanowar Elves"], "details": ["similar"]},
        make_deck(),
    )

    # Grouped by how the cards relate, with the interface's own labels and order —
    # an upgrade is not a variant, so the names alone would lose the point — and one
    # merged similar list across Tagger and EDHREC:
    #   Fyndhorn Elves is in both sources, so it appears once;
    #   `elvish mystic` is the same card as Tagger's `Elvish Mystic`, so case does not
    #   buy a second mention, and the catalog's spelling is the one kept;
    #   Woodland Mystic is EDHREC-similar but already outclassed, so it appears only
    #   under Outclasses, which says strictly more;
    #   Mana Vault is EDHREC's alone and survives;
    #   Elvish Mystic is also a related card, and a cross-reference is a different axis,
    #   so that does NOT take it out of the similar list.
    assert outcome.content.endswith(
        "\n".join(
            [
                "  Similar:",
                '    Upgrades: "Bloom Tender"',
                '    Similar cards: "Elvish Mystic", "Fyndhorn Elves", "Mana Vault"',
                '    Outclasses: "Woodland Mystic"',
                '    Related cards: "Elvish Mystic"',
            ]
        )
    )
    # No separate EDHREC heading, and no tags: the ask was which cards are related.
    assert "EDHREC" not in outcome.content
    assert "tags:" not in outcome.content


def test_an_empty_or_unrendered_relationship_group_prints_no_heading() -> None:
    outcome = run(
        make_toolbox(),
        SEE_CARDS,
        {"cards": ["Llanowar Elves"], "details": ["similar"]},
        make_deck(),
    )

    # Tagger populates nine lists and most are empty for any given card. `Variants` is
    # empty here, and `referenced_by` is deliberately not reported at all — the
    # interface leaves it out too, so the agent must not surface what the user cannot.
    assert "Variants" not in outcome.content
    assert "Elvish Archdruid" not in outcome.content


def test_one_missing_similar_source_does_not_cost_the_other() -> None:
    without_tagger = DeckAgentToolbox(
        card_catalog=StubCardCatalog(),
        tagger_catalog=None,
        edhrec_service=StubEdhrecService(),
        settings=DeckAgentToolSettings(),
    )
    ask = {"cards": ["Llanowar Elves"], "details": ["similar"]}

    no_tagger = run(without_tagger, SEE_CARDS, ask, make_deck())
    unreadable_tagger = run(
        make_toolbox(tagger_catalog=UnavailableTaggerCatalog()), SEE_CARDS, ask, make_deck()
    )
    no_edhrec = run(
        make_toolbox(edhrec_service=UnavailableEdhrecService()), SEE_CARDS, ask, make_deck()
    )

    # Tagger gone: EDHREC's names still arrive under the merged heading, and the gap is
    # named once. Nothing can be excluded as more-specific, since the groups that would
    # say so are exactly what is missing.
    assert (
        '    Similar cards: "Fyndhorn Elves", "elvish mystic", "Woodland Mystic", "Mana Vault"'
        in no_tagger.content
    )
    assert no_tagger.content.count("the sidecar is not installed") == 1
    assert '    Similar cards: "Fyndhorn Elves"' in unreadable_tagger.content
    assert unreadable_tagger.content.count("the sidecar could not be read") == 1
    # EDHREC gone: Tagger's groups still arrive, and the gap is named once.
    assert '    Similar cards: "Elvish Mystic", "Fyndhorn Elves"' in no_edhrec.content
    assert '    Outclasses: "Woodland Mystic"' in no_edhrec.content
    assert no_edhrec.content.count("no EDHREC list") == 1


def test_a_card_with_no_related_cards_at_all_says_so_once() -> None:
    outcome = run(
        make_toolbox(edhrec_service=UnavailableEdhrecService()),
        SEE_CARDS,
        {"cards": ["Sol Ring"], "details": ["similar"]},
        make_deck(),
    )

    # Sol Ring has no relationships in the stub and EDHREC is down, so there is no
    # group to head — but an empty `Similar:` would read as "there are none".
    assert "  Similar: no EDHREC list" in outcome.content


def test_unavailable_sources_degrade_per_detail() -> None:
    outcome = run(
        make_toolbox(
            tagger_catalog=UnavailableTaggerCatalog(),
            edhrec_service=UnavailableEdhrecService(),
        ),
        SEE_CARDS,
        {"cards": ["Sol Ring"], "details": ["rules", "tags", "similar", "inclusion"]},
        make_deck(),
    )

    # One unavailable source must not cost the whole call: the rules still arrive.
    assert outcome.ok is True
    assert "Add {C}{C}" in outcome.content
    # Each detail names its own gap, rather than the call reporting one blanket
    # failure — counting the word "unavailable" would pass on any three of them.
    assert "  Tags: unavailable — the Tagger sidecar could not be read." in outcome.content
    assert "  Similar: no Tagger relationships" in outcome.content
    assert "no EDHREC list" in outcome.content
    assert "  Inclusion: unavailable" in outcome.content


def test_an_unavailable_catalog_fails_the_call_without_raising() -> None:
    outcome = run(
        make_toolbox(card_catalog=UnavailableCardCatalog()),
        READ_DECK,
        {},
        make_deck(),
    )

    assert outcome.ok is False
    assert "catalog is unavailable" in outcome.content
    assert outcome.detail is not None


def test_bad_arguments_come_back_as_a_failed_call_the_model_can_read() -> None:
    toolbox = make_toolbox()
    unknown_detail = run(
        toolbox, SEE_CARDS, {"cards": ["Sol Ring"], "details": ["vibes"]}, make_deck()
    )
    no_cards = run(toolbox, SEE_CARDS, {"cards": []}, make_deck())
    extra_key = run(
        toolbox, SEE_CARDS, {"cards": ["Sol Ring"], "limit": 3}, make_deck()
    )
    not_an_object = run(toolbox, SEE_CARDS, "Sol Ring", make_deck())
    unknown_tool = run(toolbox, "delete_deck", {}, make_deck())

    for outcome in (unknown_detail, no_cards, extra_key, not_an_object, unknown_tool):
        assert outcome.ok is False
        assert outcome.detail is not None
    assert "vibes" in unknown_detail.content or "details" in unknown_detail.content
    assert "no tool called" in unknown_tool.content


def test_the_catalog_is_indexed_once_per_call_not_once_per_card() -> None:
    catalog = StubCardCatalog()
    toolbox = make_toolbox(card_catalog=catalog)

    run(toolbox, READ_DECK, {}, make_deck())

    # `card_by_oracle_id` scans every entry, so resolving a hundred-card deck one
    # card at a time would walk the whole catalog a hundred times.
    assert catalog.entry_reads == 1


def test_tools_report_themselves_disabled_without_a_catalog_or_by_config() -> None:
    assert make_toolbox().enabled is True
    assert make_toolbox(enabled=False).enabled is False
    assert (
        DeckAgentToolbox(
            card_catalog=None,
            tagger_catalog=None,
            edhrec_service=None,
            settings=DeckAgentToolSettings(),
        ).enabled
        is False
    )


def test_definitions_advertise_both_tools_without_claiming_strict() -> None:
    definitions = make_toolbox().definitions()

    names = [definition["function"]["name"] for definition in definitions]
    assert names == [READ_DECK, SEE_CARDS]
    for definition in definitions:
        # Strict mode requires every property in `required`; `details` is optional,
        # and claiming strict anyway once cost an outright provider rejection.
        assert "strict" not in definition["function"]
        assert definition["function"]["parameters"]["type"] == "object"
    see_cards = definitions[1]["function"]["parameters"]
    assert see_cards["properties"]["cards"]["type"] == "array"


def test_default_details_must_not_repeat() -> None:
    with pytest.raises(ValueError):
        DeckAgentToolSettings(see_cards_default_details=["rules", "rules"])
    with pytest.raises(ValueError):
        DeckAgentToolSettings(see_cards_default_details=[])


# --------------------------------------------------------------------------------
# read_deck's curve and price
#
# Its own card set: the buckets and the average are only observable across a spread of
# mana values and quantities, and CARDS above is pinned by the listing tests. Every
# figure here is chosen so that dropping one of the two conventions copied from
# `useDeck.ts` changes it — the commander's EUR 10.00 dominates the total, and Dryad
# Arbor shares its mana value with the four one-drops.
# --------------------------------------------------------------------------------

CURVE_BOSS = UUID("dddddddd-1111-4111-8111-111111111111")
CURVE_ZERO = UUID("dddddddd-2222-4222-8222-222222222222")
CURVE_ONE = UUID("dddddddd-3333-4333-8333-333333333333")
CURVE_BIG = UUID("dddddddd-4444-4444-8444-444444444444")
CURVE_ARBOR = UUID("dddddddd-5555-4555-8555-555555555555")
CURVE_FOREST = UUID("dddddddd-6666-4666-8666-666666666666")
CURVE_UNPRICED = UUID("dddddddd-7777-4777-8777-777777777777")

for _index, _oracle_id in enumerate(
    (
        CURVE_BOSS,
        CURVE_ZERO,
        CURVE_ONE,
        CURVE_BIG,
        CURVE_ARBOR,
        CURVE_FOREST,
        CURVE_UNPRICED,
    )
):
    PRINTING[_oracle_id] = UUID(f"eeeeeeee-{_index}000-4000-8000-000000000000")

CURVE_CARDS = {
    CURVE_BOSS: make_card(
        CURVE_BOSS,
        "Curve Boss",
        "Legendary Creature — Avatar",
        mana_value=6,
        prices=CardPrices(eur="10.00"),
    ),
    CURVE_ZERO: make_card(
        CURVE_ZERO, "Zero Rock", "Artifact", mana_value=0, prices=CardPrices(eur="0.25")
    ),
    CURVE_ONE: make_card(
        CURVE_ONE,
        "One Drop",
        "Creature — Elf Druid",
        mana_value=1,
        prices=CardPrices(eur="0.50"),
    ),
    # Nine, not seven: the top bucket has to collect a value above its own label or it
    # is only a bucket for exactly seven.
    CURVE_BIG: make_card(
        CURVE_BIG, "Big Finish", "Sorcery", mana_value=9, prices=CardPrices(eur="3.00")
    ),
    # Dryad Arbor's shape, and the reason this file cares about it: `useDeck.ts` tests
    # `type_line.includes("Land")`, so a creature that is also a land is out of the
    # curve on screen. The tool mirrors that deliberately.
    CURVE_ARBOR: make_card(
        CURVE_ARBOR,
        "Dryad Arbor",
        "Legendary Creature — Land Dryad",
        mana_value=1,
        prices=CardPrices(eur="1.00"),
    ),
    CURVE_FOREST: make_card(
        CURVE_FOREST,
        "Forest",
        "Basic Land — Forest",
        mana_value=0,
        prices=CardPrices(eur="0.10"),
    ),
    CURVE_UNPRICED: make_card(
        CURVE_UNPRICED, "No Estimate", "Instant", mana_value=2, prices=CardPrices()
    ),
}

# The quantities the curve is weighted by, so a bucket count that merely counted
# distinct printings would be wrong for the one-drops and the rocks.
CURVE_QUANTITIES = {
    CURVE_ZERO: 2,
    CURVE_ONE: 4,
    CURVE_BIG: 1,
    CURVE_ARBOR: 1,
    CURVE_FOREST: 3,
    CURVE_UNPRICED: 1,
}


def make_curve_toolbox(*, cards: Any = None) -> DeckAgentToolbox:
    return make_toolbox(
        card_catalog=StubCardCatalog(cards=CURVE_CARDS if cards is None else cards)
    )


def make_curve_deck(*, only_commander: bool = False) -> DeckAgentDeckSnapshot:
    cards = [
        DeckAgentDeckCard(
            scryfall_id=PRINTING[CURVE_BOSS], quantity=1, section="command_zone"
        )
    ]
    if not only_commander:
        cards.extend(
            DeckAgentDeckCard(
                scryfall_id=PRINTING[oracle_id], quantity=quantity, section="mainboard"
            )
            for oracle_id, quantity in CURVE_QUANTITIES.items()
        )
    return DeckAgentDeckSnapshot(name="Curve Test", cards=cards)


def curve_rows(content: str) -> dict[str, int]:
    """Read the histogram back as bucket label -> card count.

    Parsed rather than string-matched so the assertions pin the numbers and not the
    glyphs or the column layout, either of which may be retuned.
    """

    lines = content.splitlines()
    start = next(index for index, line in enumerate(lines) if line.startswith("Curve"))
    end = next(
        index for index, line in enumerate(lines) if line.startswith("Average mana value")
    )
    counts: dict[str, int] = {}
    for line in lines[start + 1 : end]:
        fields = line.split()
        assert len(fields) % 3 == 0, line
        for index in range(0, len(fields), 3):
            counts[fields[index]] = int(fields[index + 2])
    return counts


def price_line(content: str) -> str:
    return next(line for line in content.splitlines() if line.startswith("Price"))


def average_line(content: str) -> str:
    return next(
        line for line in content.splitlines() if line.startswith("Average mana value")
    )


def test_read_deck_draws_a_quantity_weighted_curve_in_eight_buckets() -> None:
    outcome = run(make_curve_toolbox(), READ_DECK, {}, make_curve_deck())

    assert curve_rows(outcome.content) == {
        "0": 2,
        "1": 4,
        "2": 1,
        "3": 0,
        "4": 0,
        "5": 0,
        "6": 0,
        # The top bucket collects everything at seven and above, so the nine-drop is here
        # and there is no bucket labelled 9.
        "7+": 1,
    }


def test_the_curve_excludes_the_command_zone_and_anything_with_land_in_its_type() -> None:
    outcome = run(make_curve_toolbox(), READ_DECK, {}, make_curve_deck())

    rows = curve_rows(outcome.content)
    # The commander is a six-drop, and it is not in the curve.
    assert rows["6"] == 0
    # Dryad Arbor is a one-drop creature, and it is not in the curve either: `useDeck.ts`
    # excludes it because its type line contains "Land", and the tool matches that quirk
    # rather than being cleverer on one side of the screen than the other. Were it
    # counted, this bucket would read 5.
    assert rows["1"] == 4
    # Three basic Forests are out for the same reason.
    assert sum(rows.values()) == 8
    # 0*2 + 1*4 + 2*1 + 9*1 over eight cards. Counting Dryad Arbor would give 1.78 over
    # nine, and counting the commander as well would give 2.40 over ten.
    assert "1.88" in average_line(outcome.content)
    assert "8 cards" in average_line(outcome.content)
    # It is still a card in the deck, and still listed as one.
    assert "Dryad Arbor" in outcome.content


def test_the_price_sums_every_card_including_the_command_zone() -> None:
    outcome = run(make_curve_toolbox(), READ_DECK, {}, make_curve_deck())

    line = price_line(outcome.content)
    # 10.00 + 0.25*2 + 0.50*4 + 3.00 + 1.00 + 0.10*3, over 13 cards.
    assert "EUR 16.80" in line
    assert "13 cards" in line
    # Dropping the commander would leave EUR 6.80, which is the failure this pins.
    assert "EUR 6.80" not in outcome.content


def test_a_card_with_no_price_is_counted_in_words_and_never_priced_at_zero() -> None:
    outcome = run(make_curve_toolbox(), READ_DECK, {}, make_curve_deck())

    line = price_line(outcome.content)
    # `getCardPrice` in the frontend reads a missing estimate as 0, so the figure on
    # screen under-reports silently. Here the count is stated instead.
    #
    # Pinned as "1 of them" rather than as a bare "1": the line already carries "16.80"
    # and "13 cards", so `"1" in line` is true of a clause that dropped the number
    # altogether ("Some of them have no price estimate").
    assert "1 of them has" in line
    assert "no price" in line
    # A card with no price is not a free card.
    assert "EUR 0.00" not in outcome.content

    # The control: give that one card an estimate and the count must disappear, so the
    # clause above cannot be unconditional boilerplate.
    priced = run(
        make_curve_toolbox(
            cards={
                **CURVE_CARDS,
                CURVE_UNPRICED: make_card(
                    CURVE_UNPRICED,
                    "No Estimate",
                    "Instant",
                    mana_value=2,
                    prices=CardPrices(eur="2.00"),
                ),
            }
        ),
        READ_DECK,
        {},
        make_curve_deck(),
    )

    assert "no price" not in price_line(priced.content)
    assert "EUR 18.80" in price_line(priced.content)


def test_the_unpriced_count_counts_copies_rather_than_distinct_cards() -> None:
    # Three copies of one unpriced card is three cards missing from the total, not one.
    # The main fixture holds a single copy, which cannot tell the two apart.
    deck = DeckAgentDeckSnapshot(
        name="Curve Test",
        cards=[
            DeckAgentDeckCard(
                scryfall_id=PRINTING[CURVE_BOSS], quantity=1, section="command_zone"
            ),
            DeckAgentDeckCard(
                scryfall_id=PRINTING[CURVE_UNPRICED], quantity=3, section="mainboard"
            ),
        ],
    )

    line = price_line(run(make_curve_toolbox(), READ_DECK, {}, deck).content)

    assert "3 of them have" in line
    assert "1 of them" not in line


def test_a_price_over_a_deck_with_unresolved_printings_does_not_speak_for_the_deck() -> (
    None
):
    # Only resolved entries can be priced, so a deck holding a printing the catalog does
    # not know has more cards than the total covers. The line must not call that figure
    # the deck's, and must point at the unresolved list rather than leaving the reader to
    # notice the arithmetic does not add up.
    deck = DeckAgentDeckSnapshot(
        name="Curve Test",
        cards=[
            DeckAgentDeckCard(
                scryfall_id=PRINTING[CURVE_BOSS], quantity=1, section="command_zone"
            ),
            DeckAgentDeckCard(
                scryfall_id=UUID("ffffffff-ffff-4fff-8fff-ffffffffffff"),
                quantity=5,
                section="mainboard",
            ),
        ],
    )

    content = run(make_curve_toolbox(), READ_DECK, {}, deck).content
    line = price_line(content)

    assert "Not in the local catalog (1)" in content
    assert "the deck's" not in line
    assert "not in this total" in line
    # The figure itself is still the truth about what it covers.
    assert "EUR 10.00" in line


def test_a_deck_where_nothing_has_a_price_reports_no_total_rather_than_zero() -> None:
    deck = DeckAgentDeckSnapshot(
        name="Curve Test",
        cards=[
            DeckAgentDeckCard(
                scryfall_id=PRINTING[CURVE_UNPRICED], quantity=1, section="mainboard"
            )
        ],
    )

    outcome = run(make_curve_toolbox(), READ_DECK, {}, deck)

    # No figure at all, because a total of zero would be a claim about the deck's value.
    assert re.search(r"EUR\s+\d", outcome.content) is None
    assert "0.00" not in outcome.content


def test_a_deck_holding_only_a_commander_has_no_curve_and_says_so() -> None:
    outcome = run(
        make_curve_toolbox(), READ_DECK, {}, make_curve_deck(only_commander=True)
    )

    # An all-zero histogram reads as a deck full of nought-cost spells.
    assert "█" not in outcome.content
    assert "Average mana value" not in outcome.content
    assert "Curve" in outcome.content
    # The price still lands, because the command zone counts toward it.
    assert "EUR 10.00" in price_line(outcome.content)


def test_an_empty_or_absent_deck_gets_no_curve_and_no_price() -> None:
    empty = run(
        make_toolbox(), READ_DECK, {}, DeckAgentDeckSnapshot(name="Untitled", cards=[])
    )
    no_deck = run(make_toolbox(), READ_DECK, {}, None)

    for outcome in (empty, no_deck):
        assert outcome.ok is True
        assert "Curve" not in outcome.content
        assert "mana value" not in outcome.content
        assert "EUR" not in outcome.content
    # And they still say what they said before.
    assert "completely empty" in empty.content
    assert "No deck is open" in no_deck.content


def test_the_curve_bar_scales_rather_than_running_off_the_line() -> None:
    from mtg_deck_builder.deck_agent_tools import _CURVE_BAR_MAX, _curve_bar

    # One block per card while that fits, so a small deck's bar is countable.
    assert _curve_bar(3, widest=4) == "███"
    # Past the cap every bar scales together and none of them vanishes, because the
    # count beside it is the truth and the bar is only the shape.
    scaled = _curve_bar(1, widest=_CURVE_BAR_MAX * 40)
    assert len(scaled) == 1
    assert len(_curve_bar(_CURVE_BAR_MAX * 40, widest=_CURVE_BAR_MAX * 40)) == _CURVE_BAR_MAX


# --------------------------------------------------------------------------------
# search_cards
#
# A separate card set, because the colour-identity behaviour under test needs cards
# that actually have colours, and the deck-reading tests above pin CARDS as it is.
# --------------------------------------------------------------------------------

PRINTING[MARWYN] = UUID("aaaaaaaa-7777-4777-8777-777777777777")
PRINTING[BOLT] = UUID("aaaaaaaa-8888-4888-8888-888888888888")
PRINTING[UNSTABLE] = UUID("aaaaaaaa-9999-4999-8999-999999999999")

SEARCHABLE = {
    MARWYN: make_card(
        MARWYN,
        "Marwyn, the Nurturer",
        "Legendary Creature — Elf Druid",
        mana_cost="{3}{G}",
        mana_value=3,
        color_identity=["G"],
        power="1",
        toughness="1",
    ),
    # Outside a green commander's identity, so the gate is observable.
    BOLT: make_card(
        BOLT,
        "Lightning Bolt",
        "Instant",
        mana_cost="{R}",
        color_identity=["R"],
        oracle_text="Lightning Bolt deals 3 damage to any target.",
    ),
    # Colorless: it must survive a commander gate and be removed by `colors`.
    SOL_RING: CARDS[SOL_RING],
    ELVES: make_card(
        ELVES,
        "Llanowar Elves",
        "Creature — Elf Druid",
        mana_cost="{G}",
        color_identity=["G"],
        power="1",
        toughness="1",
        prices=CardPrices(),
    ),
    UNSTABLE: make_card(
        UNSTABLE,
        "Steamflogger Boss",
        "Creature — Goblin Rigger",
        color_identity=["R"],
        legalities={"commander": "not_legal"},
    ),
}

SEMANTIC_SCORES = {SOL_RING: 0.91, ELVES: 0.72, MARWYN: 0.55, BOLT: 0.30, UNSTABLE: 0.10}


class StubSemanticIndex:
    def __init__(self) -> None:
        self.queries: list[str] = []

    async def score(self, query: str, oracle_ids: Any) -> SemanticScoreResult:
        self.queries.append(query)
        return SemanticScoreResult(
            scores={oracle_id: SEMANTIC_SCORES[oracle_id] for oracle_id in oracle_ids},
            model="stub-embeddings",
            dimensions=8,
        )


def make_search_toolbox(
    *,
    edhrec_service: Any = None,
    semantic_index: Any = None,
    default_max_results: int = 12,
    hard_max_results: int = 60,
    **settings: Any,
) -> DeckAgentToolbox:
    catalog = StubCardCatalog(cards=SEARCHABLE)
    return make_toolbox(
        card_catalog=catalog,
        edhrec_service=edhrec_service,
        local_tool=LocalCardSearchTool(
            catalog,
            default_max_results=default_max_results,
            hard_max_results=hard_max_results,
            semantic_index=StubSemanticIndex() if semantic_index is None else semantic_index,
        ),
        **settings,
    )


def search(toolbox: DeckAgentToolbox, arguments: Any, deck: Any = None) -> Any:
    return run(toolbox, SEARCH_CARDS, arguments, deck)


ANY_TYPE = {"must_contain_any": ["Instant", "Creature", "Artifact"]}


def test_search_cards_returns_ranked_cards_under_the_models_own_filters() -> None:
    toolbox = make_search_toolbox()

    outcome = search(
        toolbox,
        {"semantic_sort": "mana rock, ramp", "sort_by": "semantic", "types": ANY_TYPE},
    )

    assert outcome.ok is True
    # Ordered by the stub's semantic scores, best first.
    assert outcome.content.index("Sol Ring") < outcome.content.index("Llanowar Elves")
    assert "Semantic closeness: 0.910 of 1" in outcome.content
    # The same labelled card block `see_cards` renders, rules text included.
    assert 'Rules: "{T}: Add {C}{C}."' in outcome.content
    # One estimate in a search, not the three-way breakdown `see_cards` gives on ask.
    assert "Price: EUR 1.85\n" in outcome.content
    assert "EUR foil" not in outcome.content
    assert "USD" not in outcome.content


def test_a_commander_gate_removes_out_of_identity_cards_but_keeps_colorless() -> None:
    toolbox = make_search_toolbox()
    commander = {"card": "Marwyn, the Nurturer"}

    restricted = search(toolbox, {"types": ANY_TYPE, "commander": commander})
    # The control: the same search with the gate off must show what the gate removed.
    unrestricted = search(
        toolbox,
        {
            "types": ANY_TYPE,
            "commander": {**commander, "restrict_to_color_identity": False},
        },
    )

    assert "Lightning Bolt" not in restricted.content
    assert "Lightning Bolt" in unrestricted.content
    # A colorless card's identity is empty, which fits inside every commander's
    # colours — so the gate keeps it. The prompt tells the agent this; it has to hold.
    assert "Sol Ring" in restricted.content
    # The model typed the commander's name but not its colour identity, so the removal
    # is the one part of this it could not have predicted.
    assert (
        "Cards outside Marwyn, the Nurturer's {G} identity were removed"
        in restricted.content
    )
    assert "were removed" not in unrestricted.content


def test_the_colors_filter_removes_colorless_cards_unless_told_otherwise() -> None:
    toolbox = make_search_toolbox()

    without = search(toolbox, {"types": ANY_TYPE, "colors": {"identity": ["G"]}})
    with_colorless = search(
        toolbox,
        {
            "types": ANY_TYPE,
            "colors": {"identity": ["G"], "include_colorless": True},
        },
    )

    # The asymmetry the prompt warns about: unlike the commander gate, `colors`
    # deletes every colorless card by default — which is most of the good ramp.
    assert "Sol Ring" not in without.content
    assert "Sol Ring" in with_colorless.content


def test_a_commander_that_is_not_in_the_deck_still_resolves() -> None:
    toolbox = make_search_toolbox()

    outcome = search(
        toolbox,
        {"types": ANY_TYPE, "commander": {"card": "Marwyn, the Nurturer"}},
        make_deck(),
    )

    # The open deck is commanded by Ghalta. Naming another commander is the whole
    # point: it is how "what would work under a different commander?" is answered.
    assert outcome.ok is True
    assert "Marwyn, the Nurturer's {G} identity" in outcome.content
    assert "Marwyn, the Nurturer decks" in outcome.content


def test_an_unknown_commander_fails_the_call_rather_than_searching_without_one() -> None:
    outcome = search(make_search_toolbox(), {"types": ANY_TYPE, "commander": {"card": "Marwn"}})

    assert outcome.ok is False
    assert "Marwn" in outcome.content
    assert "Lightning Bolt" not in outcome.content


def test_edhrec_sorting_says_which_reason_it_has_no_evidence() -> None:
    no_commander = search(make_search_toolbox(), {"sort_by": "edhrec_inclusion"})
    no_edhrec = search(
        make_search_toolbox(edhrec_service=UnavailableEdhrecService()),
        {
            "sort_by": "edhrec_synergy",
            "commander": {"card": "Marwyn, the Nurturer"},
        },
    )

    # Two causes needing different fixes, so they must not read the same.
    assert no_commander.ok is False
    assert "no commander was named" in no_commander.content
    assert no_edhrec.ok is False
    assert "no EDHREC data for" in no_edhrec.content
    assert "Marwyn, the Nurturer" in no_edhrec.content


def test_edhrec_evidence_is_reported_per_card_and_absence_is_not_zero() -> None:
    outcome = search(
        make_search_toolbox(),
        {"types": ANY_TYPE, "commander": {"card": "Marwyn, the Nurturer"}},
    )

    assert "Inclusion: 82% of 8,200 Marwyn, the Nurturer decks, synergy +0.11" in outcome.content
    # Llanowar Elves has no association. A card EDHREC does not list is not a card
    # played in 0% of decks, and must not render as one.
    assert "not among the cards EDHREC lists for Marwyn, the Nurturer" in outcome.content
    assert "Inclusion: 0%" not in outcome.content


def test_an_unknown_edhrec_theme_is_refused_with_every_valid_slug() -> None:
    refused = search(
        make_search_toolbox(),
        {
            "types": ANY_TYPE,
            "commander": {"card": "Marwyn, the Nurturer", "edhrec_theme": "elfbal"},
        },
    )

    assert refused.ok is False
    # Listing what is valid is the difference between an error it can recover from and
    # one it can only retry blindly, so every slug is named — including the tail the
    # `themes` detail caps away.
    assert '"elfball"' in refused.content
    assert '"unnatural"' in refused.content


def test_a_search_does_not_echo_back_what_the_model_itself_wrote() -> None:
    outcome = search(
        make_search_toolbox(),
        {
            "semantic_sort": "mana rock, ramp",
            "sort_by": "semantic",
            "types": ANY_TYPE,
            "commander": {"card": "Marwyn, the Nurturer"},
        },
    )

    # The filters, the sort and the commander's name were all written by the model a
    # moment earlier. Repeating them costs tokens on every call to say nothing.
    assert "mana rock, ramp" not in outcome.content
    assert "Sorted by" not in outcome.content
    assert "Legality" not in outcome.content
    assert "Deck themes" not in outcome.content
    # Two header lines: the match count, and the gate it could not have predicted.
    assert outcome.content.split("\n\n")[0].count("\n") == 2


def test_deck_themes_are_a_see_cards_detail_and_say_when_a_card_has_none() -> None:
    toolbox = make_toolbox()

    commander = run(
        toolbox,
        SEE_CARDS,
        {"cards": ["Ghalta, Primal Hunger"], "details": ["themes"]},
        make_deck(),
    )
    not_a_commander = run(
        toolbox,
        SEE_CARDS,
        {"cards": ["Sol Ring"], "details": ["themes"]},
        make_deck(),
    )

    assert '"elfball" (900 decks)' in commander.content
    # Capped, with the count beside each slug: sorting by synergy inside a two-deck
    # theme is evidence about two decks.
    assert '"unnatural" (1 deck)' in commander.content
    # A card with no EDHREC commander page is told which of the two reasons applies,
    # because "no themes" and "not a commander" lead somewhere different.
    assert "legendary creature" in not_a_commander.content


def test_asking_for_themes_on_a_non_commander_does_not_cost_the_other_details() -> None:
    outcome = run(
        make_toolbox(edhrec_service=UnavailableEdhrecService()),
        SEE_CARDS,
        {"cards": ["Sol Ring"], "details": ["rules", "themes"]},
        make_deck(),
    )

    assert outcome.ok is True
    assert 'Rules: "{T}: Add {C}{C}."' in outcome.content
    assert "legendary creature" in outcome.content


def test_cards_already_in_the_deck_are_excluded_only_when_asked() -> None:
    toolbox = make_search_toolbox()

    excluded = search(
        toolbox, {"types": ANY_TYPE, "exclude_cards_in_deck": True}, make_deck()
    )
    included = search(toolbox, {"types": ANY_TYPE}, make_deck())

    assert "Sol Ring" not in excluded.content
    assert "Sol Ring" in included.content
    # Two, not four: the search catalog holds Sol Ring and Llanowar Elves out of the
    # snapshot's four printings, and a printing it cannot resolve cannot be excluded.
    assert "2 already in the deck were excluded" in excluded.content
    # Asked for with no deck open, "0 were excluded" would read as an empty deck
    # rather than as no deck.
    no_deck = search(toolbox, {"types": ANY_TYPE, "exclude_cards_in_deck": True})
    assert "no deck is open" in no_deck.content
    assert "Sol Ring" in no_deck.content


def test_illegal_cards_are_out_until_the_model_says_otherwise() -> None:
    toolbox = make_search_toolbox()

    default = search(toolbox, {"types": ANY_TYPE})
    widened = search(toolbox, {"types": ANY_TYPE, "commander_legal_only": False})

    # Card presence is the property; the header does not restate a flag the model set.
    assert "Steamflogger Boss" not in default.content
    assert "Steamflogger Boss" in widened.content


def test_the_header_reports_the_total_so_twelve_of_many_is_not_read_as_all() -> None:
    toolbox = make_search_toolbox(default_max_results=1)

    outcome = search(toolbox, {"types": ANY_TYPE, "semantic_sort": "ramp"})

    # Without the total, "here are the only matches" and "here is the top of a long
    # list" are indistinguishable, and the agent will assert the first.
    assert "4 cards matched; showing the best 1, best first." in outcome.content


def test_nothing_matching_says_which_kind_of_filter_to_relax() -> None:
    outcome = search(
        make_search_toolbox(),
        {"types": {"must_contain_all": ["Planeswalker"]}},
    )

    assert outcome.ok is True
    assert "Nothing matched" in outcome.content
    assert "rather than rewording semantic_sort, which removes nothing" in outcome.content
    assert "Name:" not in outcome.content


def test_a_search_with_no_criteria_at_all_is_refused_readably() -> None:
    outcome = search(make_search_toolbox(), {})

    assert outcome.ok is False
    assert "semantic_sort" in outcome.content


def test_the_projection_hands_the_engine_only_the_fields_it_knows() -> None:
    arguments = SearchCardsArguments.model_validate(
        {
            "semantic_sort": "ramp",
            "commander": {"card": "Marwyn, the Nurturer"},
            "exclude_cards_in_deck": True,
            "commander_legal_only": False,
        }
    )

    request = arguments.local_request()

    # The three added fields must not reach the shared engine, where a commander
    # alone would read as a search criterion.
    assert set(request.model_dump()) == set(LocalCardSearchRequest.model_fields)
    assert "commander" not in request.model_dump()
    assert request.semantic_sort == "ramp"


def test_the_identity_is_absent_rather_than_disagreeing_with_a_second_flag() -> None:
    commander = SEARCHABLE[MARWYN]
    restricting = SearchCardsArguments.model_validate(
        {"commander": {"card": "Marwyn, the Nurturer"}}
    )
    permissive = SearchCardsArguments.model_validate(
        {"commander": {"card": "Marwyn, the Nurturer", "restrict_to_color_identity": False}}
    )

    assert restricting.catalog_filters(commander).commander_color_identity == ["G"]
    # Not restricting is expressed by having no identity, so the two fields that
    # would otherwise have to agree cannot disagree.
    assert permissive.catalog_filters(commander).commander_color_identity is None
    assert (
        permissive.catalog_filters(commander).include_outside_commander_color_identity
        is False
    )
    assert SearchCardsArguments().catalog_filters(None).commander_color_identity is None


def test_search_cards_is_advertised_only_when_it_can_run() -> None:
    without = make_toolbox().definitions()
    with_engine = make_search_toolbox().definitions()

    assert [item["function"]["name"] for item in without] == [READ_DECK, SEE_CARDS]
    assert [item["function"]["name"] for item in with_engine] == [
        READ_DECK,
        SEE_CARDS,
        SEARCH_CARDS,
    ]
    schema = with_engine[2]["function"]["parameters"]
    assert "strict" not in with_engine[2]["function"]
    assert "commander" in schema["properties"]
    assert "semantic_sort" in schema["properties"]


def test_the_tool_line_carries_the_theme_that_decided_the_ranking() -> None:
    outcome = search(
        make_search_toolbox(),
        {
            "sort_by": "edhrec_synergy",
            "types": ANY_TYPE,
            "commander": {"card": "Marwyn, the Nurturer", "edhrec_theme": "elfball"},
        },
    )

    # After the commander, the theme is the argument that changes the result most, and
    # without it in the signature the transcript cannot show which one was searched.
    assert "Marwyn, the Nurturer / elfball" in outcome.signature
    untouched = search(
        make_search_toolbox(),
        {"types": ANY_TYPE, "commander": {"card": "Marwyn, the Nurturer"}},
    )
    assert "/" not in untouched.signature


def test_the_tool_line_names_the_search_and_stays_inside_its_field() -> None:
    toolbox = make_search_toolbox()

    outcome = search(
        toolbox,
        {
            "semantic_sort": "x" * 400,
            "sort_by": "semantic",
            "types": ANY_TYPE,
            "commander": {"card": "Marwyn, the Nurturer"},
        },
    )

    assert outcome.signature.startswith("search_cards(")
    assert "semantic" in outcome.signature
    # `DeckAgentToolCall.signature` is a 200-character field, and the model chooses
    # what goes inside a signature. Overflowing it would fail validation and take
    # down a turn that had already answered.
    assert len(outcome.signature) <= 200


def test_search_result_bounds_must_agree() -> None:
    with pytest.raises(ValueError):
        DeckAgentToolSettings(
            search_cards_default_max_results=30,
            search_cards_hard_max_results=12,
        )
