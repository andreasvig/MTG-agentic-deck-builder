"""External card-data provider interfaces and implementations."""

from mtg_deck_builder.providers.cards import (
    CardSearchProvider,
    CardSearchQueryError,
    CardSearchUnavailable,
)
from mtg_deck_builder.providers.scryfall import (
    FuzzyNameCandidate,
    ScryfallCardSearchProvider,
    name_similarity_score,
)

__all__ = [
    "CardSearchProvider",
    "CardSearchQueryError",
    "CardSearchUnavailable",
    "FuzzyNameCandidate",
    "ScryfallCardSearchProvider",
    "name_similarity_score",
]
