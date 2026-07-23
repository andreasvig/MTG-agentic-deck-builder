"""Live Scryfall implementation of the card search boundary."""

import asyncio
from decimal import Decimal
from time import monotonic
from typing import Annotated, Literal
from uuid import UUID

import httpx2
from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
)

from mtg_deck_builder.domain import (
    CardFace,
    CardImageUris,
    CardPrices,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
    MagicColor,
)
from mtg_deck_builder.providers.cards import CardSearchQueryError, CardSearchUnavailable

_NonEmptyString = Annotated[str, StringConstraints(min_length=1)]
_Legality = Literal["legal", "not_legal", "restricted", "banned"]
_Finish = Literal["nonfoil", "foil", "etched"]


class _ScryfallModel(BaseModel):
    model_config = ConfigDict(extra="ignore")


class _ScryfallImageUris(_ScryfallModel):
    small: AnyHttpUrl | None = None
    normal: AnyHttpUrl | None = None
    large: AnyHttpUrl | None = None
    png: AnyHttpUrl | None = None
    art_crop: AnyHttpUrl | None = None
    border_crop: AnyHttpUrl | None = None

    def to_domain(self) -> CardImageUris:
        return CardImageUris.model_validate(self.model_dump())


class _ScryfallFace(_ScryfallModel):
    oracle_id: UUID | None = None
    name: _NonEmptyString
    mana_cost: str | None = None
    cmc: Annotated[float, Field(ge=0)] | None = None
    type_line: str | None = None
    oracle_text: str | None = None
    colors: list[MagicColor] = Field(default_factory=list)
    image_uris: _ScryfallImageUris | None = None

    def to_domain(self) -> CardFace:
        return CardFace(
            name=self.name,
            mana_cost=self.mana_cost,
            type_line=self.type_line,
            oracle_text=self.oracle_text,
            colors=self.colors,
            image_uris=self.image_uris.to_domain() if self.image_uris else None,
        )


class _ScryfallPrices(_ScryfallModel):
    usd: Decimal | None = None
    usd_foil: Decimal | None = None
    usd_etched: Decimal | None = None
    eur: Decimal | None = None
    eur_foil: Decimal | None = None
    tix: Decimal | None = None

    def to_domain(self) -> CardPrices:
        return CardPrices.model_validate(self.model_dump())


class _ScryfallCard(_ScryfallModel):
    id: UUID
    oracle_id: UUID | None = None
    name: _NonEmptyString
    layout: _NonEmptyString
    mana_cost: str | None = None
    cmc: Annotated[float, Field(ge=0)] | None = None
    type_line: _NonEmptyString | None = None
    oracle_text: str | None = None
    colors: list[MagicColor] | None = None
    color_identity: list[MagicColor] = Field(default_factory=list)
    image_uris: _ScryfallImageUris | None = None
    card_faces: list[_ScryfallFace] = Field(default_factory=list)
    set: _NonEmptyString
    set_name: _NonEmptyString
    collector_number: _NonEmptyString
    rarity: _NonEmptyString
    prices: _ScryfallPrices
    legalities: dict[_NonEmptyString, _Legality]
    finishes: list[_Finish]
    scryfall_uri: AnyHttpUrl
    purchase_uris: dict[str, AnyHttpUrl] = Field(default_factory=dict)

    def to_domain(self) -> CardSearchResult:
        first_face = self.card_faces[0] if self.card_faces else None
        face_oracle_id = first_face.oracle_id if first_face else None
        face_mana_cost = first_face.mana_cost if first_face else None
        face_mana_value = first_face.cmc if first_face else None
        face_type_line = first_face.type_line if first_face else None
        face_oracle_text = first_face.oracle_text if first_face else None
        face_colors = first_face.colors if first_face else None
        return CardSearchResult(
            oracle_id=self.oracle_id or face_oracle_id,
            scryfall_id=self.id,
            name=self.name,
            layout=self.layout,
            mana_cost=self.mana_cost if self.mana_cost is not None else face_mana_cost,
            mana_value=self.cmc if self.cmc is not None else face_mana_value,
            type_line=self.type_line or face_type_line,
            oracle_text=(self.oracle_text if self.oracle_text is not None else face_oracle_text),
            colors=self.colors if self.colors is not None else face_colors,
            color_identity=self.color_identity,
            image_uris=self.image_uris.to_domain() if self.image_uris else None,
            card_faces=[face.to_domain() for face in self.card_faces],
            set_code=self.set,
            set_name=self.set_name,
            collector_number=self.collector_number,
            rarity=self.rarity,
            prices=self.prices.to_domain(),
            legalities=self.legalities,
            finishes=self.finishes,
            scryfall_url=self.scryfall_uri,
            cardmarket_url=self.purchase_uris.get("cardmarket"),
        )


class _ScryfallList(_ScryfallModel):
    object: Literal["list"]
    total_cards: Annotated[int, Field(ge=0)]
    has_more: bool
    data: list[_ScryfallCard]
    warnings: list[str] = Field(default_factory=list)


class ScryfallCardSearchProvider:
    """Search Scryfall while keeping its wire format out of the application."""

    def __init__(
        self,
        client: httpx2.AsyncClient,
        *,
        minimum_request_interval_seconds: float = 0.11,
    ) -> None:
        if minimum_request_interval_seconds < 0:
            raise ValueError("minimum_request_interval_seconds must not be negative")
        self._client = client
        self._minimum_request_interval_seconds = minimum_request_interval_seconds
        self._request_lock = asyncio.Lock()
        self._last_request_started_at = 0.0

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        await self._wait_for_request_slot()
        try:
            response = await self._client.get(
                "/cards/search",
                params={
                    "q": query.q,
                    "page": query.page,
                    "unique": "cards",
                    "order": "name",
                    "include_extras": "false",
                    "include_multilingual": "false",
                },
            )
        except httpx2.RequestError as exc:
            raise CardSearchUnavailable from exc

        if response.status_code == 404:
            return CardSearchPage(
                query=query.q,
                page=query.page,
                total_results=0,
                has_more=False,
                cards=[],
            )
        if response.status_code in {400, 422}:
            raise CardSearchQueryError
        if response.is_error:
            raise CardSearchUnavailable

        try:
            payload = _ScryfallList.model_validate(response.json())
            cards = [card.to_domain() for card in payload.data]
        except (ValueError, ValidationError) as exc:
            raise CardSearchUnavailable from exc

        return CardSearchPage(
            query=query.q,
            page=query.page,
            total_results=payload.total_cards,
            has_more=payload.has_more,
            cards=cards,
            warnings=payload.warnings,
        )

    async def _wait_for_request_slot(self) -> None:
        async with self._request_lock:
            elapsed = monotonic() - self._last_request_started_at
            remaining = self._minimum_request_interval_seconds - elapsed
            if remaining > 0:
                await asyncio.sleep(remaining)
            self._last_request_started_at = monotonic()
