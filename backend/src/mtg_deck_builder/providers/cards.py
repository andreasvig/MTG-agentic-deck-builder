"""Card-data provider boundary."""

from typing import Protocol

from mtg_deck_builder.domain import CardSearchPage, CardSearchQuery


class CardSearchQueryError(Exception):
    """The external provider rejected the user's search expression."""


class CardSearchUnavailable(Exception):
    """The external card provider could not serve a valid response."""


class CardSearchProvider(Protocol):
    """Search card printings without exposing provider transport details."""

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        """Return one page of cards matching the query."""
