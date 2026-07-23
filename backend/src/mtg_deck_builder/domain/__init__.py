"""Domain contracts shared by API routes and services."""

from mtg_deck_builder.domain.cards import (
    CardFace,
    CardFinish,
    CardImageUris,
    CardLegality,
    CardPrices,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
    MagicColor,
)
from mtg_deck_builder.domain.deck import (
    CardReference,
    Deck,
    DeckCardEntry,
    DeckSection,
)

__all__ = [
    "CardFace",
    "CardFinish",
    "CardImageUris",
    "CardLegality",
    "CardPrices",
    "CardReference",
    "CardSearchPage",
    "CardSearchQuery",
    "CardSearchResult",
    "Deck",
    "DeckCardEntry",
    "DeckSection",
    "MagicColor",
]
