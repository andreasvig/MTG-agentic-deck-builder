"""Scryfall card-object mapping and provider-neutral title scoring."""

import re
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
)
from rapidfuzz.fuzz import WRatio

from mtg_deck_builder.domain import (
    CardFace,
    CardImageUris,
    CardPrices,
    CardSearchResult,
    MagicColor,
)

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


def map_scryfall_card(payload: object) -> CardSearchResult:
    """Validate one Scryfall card object and map it to the app contract."""

    return _ScryfallCard.model_validate(payload).to_domain()


def _normalize_card_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def name_similarity_score(query: str, candidate: str) -> float:
    """Score exact, typo, word, and partial-segment title similarity."""

    normalized_query = _normalize_card_name(query)
    normalized_candidate = _normalize_card_name(candidate)
    if not normalized_query or not normalized_candidate:
        return 0.0
    return round(WRatio(normalized_query, normalized_candidate) / 100, 6)
