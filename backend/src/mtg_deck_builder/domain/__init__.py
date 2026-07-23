"""Domain contracts shared by API routes and services."""

from mtg_deck_builder.domain.deck import (
    CardReference,
    Deck,
    DeckCardEntry,
    DeckSection,
)

__all__ = ["CardReference", "Deck", "DeckCardEntry", "DeckSection"]
