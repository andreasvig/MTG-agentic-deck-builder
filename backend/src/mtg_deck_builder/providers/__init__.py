"""External card-data provider interfaces and implementations."""

from mtg_deck_builder.providers.cards import (
    CardSearchProvider,
    CardSearchQueryError,
    CardSearchUnavailable,
)
from mtg_deck_builder.providers.scryfall import (
    map_scryfall_card,
    name_similarity_score,
)

__all__ = [
    "CardSearchProvider",
    "CardSearchQueryError",
    "CardSearchUnavailable",
    "map_scryfall_card",
    "name_similarity_score",
]
