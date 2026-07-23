"""Domain contracts shared by API routes and services."""

from mtg_deck_builder.domain.cards import (
    CardFace,
    CardFinish,
    CardImageUris,
    CardLegality,
    CardPrices,
    CardSearchFilters,
    CardSearchOrder,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
    ColorMatchMode,
    MagicColor,
    SearchDebugStage,
    SearchDebugSummary,
    SearchStrategy,
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
    "CardSearchFilters",
    "CardSearchOrder",
    "CardSearchPage",
    "CardSearchQuery",
    "CardSearchResult",
    "ColorMatchMode",
    "Deck",
    "DeckCardEntry",
    "DeckSection",
    "MagicColor",
    "SearchDebugStage",
    "SearchDebugSummary",
    "SearchStrategy",
]
