"""Provider-neutral card search contracts."""

from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, StringConstraints

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
MagicColor = Literal["W", "U", "B", "R", "G"]
CardLegality = Literal["legal", "not_legal", "restricted", "banned"]
CardFinish = Literal["nonfoil", "foil", "etched"]


class CardModel(BaseModel):
    """Strict base model for the frontend-facing card contract."""

    model_config = ConfigDict(extra="forbid")


class CardImageUris(CardModel):
    """Scryfall-hosted image variants for a printing or card face."""

    small: AnyHttpUrl | None = None
    normal: AnyHttpUrl | None = None
    large: AnyHttpUrl | None = None
    png: AnyHttpUrl | None = None
    art_crop: AnyHttpUrl | None = None
    border_crop: AnyHttpUrl | None = None


class CardFace(CardModel):
    """Face-specific data for multi-faced printings."""

    name: NonEmptyString
    mana_cost: str | None = None
    type_line: NonEmptyString | None = None
    oracle_text: str | None = None
    colors: list[MagicColor] = Field(default_factory=list)
    image_uris: CardImageUris | None = None


class CardPrices(CardModel):
    """Daily price estimates reported by Scryfall for a printing."""

    usd: Decimal | None = None
    usd_foil: Decimal | None = None
    usd_etched: Decimal | None = None
    eur: Decimal | None = None
    eur_foil: Decimal | None = None
    tix: Decimal | None = None


class CardSearchResult(CardModel):
    """A searchable card with stable oracle and selected-printing identities."""

    oracle_id: UUID
    scryfall_id: UUID
    name: NonEmptyString
    layout: NonEmptyString
    mana_cost: str | None = None
    mana_value: Annotated[float, Field(ge=0)]
    type_line: NonEmptyString
    oracle_text: str | None = None
    colors: list[MagicColor] = Field(default_factory=list)
    color_identity: list[MagicColor] = Field(default_factory=list)
    image_uris: CardImageUris | None = None
    card_faces: list[CardFace] = Field(default_factory=list)
    set_code: NonEmptyString
    set_name: NonEmptyString
    collector_number: NonEmptyString
    rarity: NonEmptyString
    prices: CardPrices
    legalities: dict[NonEmptyString, CardLegality]
    finishes: list[CardFinish]
    scryfall_url: AnyHttpUrl
    cardmarket_url: AnyHttpUrl | None = None


class CardSearchQuery(CardModel):
    """Validated search input shared by API and provider implementations."""

    q: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    page: Annotated[int, Field(ge=1, le=1_000)] = 1


class CardSearchPage(CardModel):
    """One page of provider-neutral card search results."""

    query: NonEmptyString
    page: Annotated[int, Field(ge=1)]
    total_results: Annotated[int, Field(ge=0)]
    has_more: bool
    cards: list[CardSearchResult]
    warnings: list[str] = Field(default_factory=list)
