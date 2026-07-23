"""Provider-neutral card search contracts."""

from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
MagicColor = Literal["W", "U", "B", "R", "G"]
CardLegality = Literal["legal", "not_legal", "restricted", "banned"]
CardFinish = Literal["nonfoil", "foil", "etched"]
ColorMatchMode = Literal["subset", "exact"]
SearchStrategy = Literal["exact", "fuzzy", "intent", "syntax"]
CardSearchOrder = Literal["name", "edhrec"]
SearchDebugStageStatus = Literal["ok", "skipped", "error"]


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


class CardSearchFilters(CardModel):
    """Structured filters applied to every search strategy."""

    colors: list[MagicColor] = Field(default_factory=list, max_length=5)
    include_colorless: bool = False
    color_mode: ColorMatchMode = "subset"
    mana_value_min: Annotated[float | None, Field(default=None, ge=0, le=100)] = None
    mana_value_max: Annotated[float | None, Field(default=None, ge=0, le=100)] = None
    price_eur_min: Annotated[Decimal | None, Field(default=None, ge=0)] = None
    price_eur_max: Annotated[Decimal | None, Field(default=None, ge=0)] = None

    @field_validator("colors")
    @classmethod
    def colors_must_be_unique(cls, value: list[MagicColor]) -> list[MagicColor]:
        return list(dict.fromkeys(value))

    @model_validator(mode="after")
    def ranges_must_be_ordered(self) -> "CardSearchFilters":
        if (
            self.mana_value_min is not None
            and self.mana_value_max is not None
            and self.mana_value_min > self.mana_value_max
        ):
            raise ValueError("mana_value_min must not exceed mana_value_max")
        if (
            self.price_eur_min is not None
            and self.price_eur_max is not None
            and self.price_eur_min > self.price_eur_max
        ):
            raise ValueError("price_eur_min must not exceed price_eur_max")
        return self


class CardSearchQuery(CardModel):
    """Validated search input shared by API and provider implementations."""

    q: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    page: Annotated[int, Field(ge=1, le=1_000)] = 1
    filters: CardSearchFilters = Field(default_factory=CardSearchFilters)
    order: CardSearchOrder = "name"
    debug: bool = False


class SearchDebugStage(CardModel):
    """Compact timing and cardinality summary for one search layer."""

    name: NonEmptyString
    status: SearchDebugStageStatus
    duration_ms: Annotated[float, Field(ge=0)]
    input_count: Annotated[int | None, Field(default=None, ge=0)] = None
    output_count: Annotated[int | None, Field(default=None, ge=0)] = None


class SearchDebugSummary(CardModel):
    """Debug trace metadata returned only while search debugging is enabled."""

    trace_id: UUID
    log_path: NonEmptyString
    log_written: bool
    total_duration_ms: Annotated[float, Field(ge=0)]
    stages: list[SearchDebugStage]
    trace: dict[str, Any]


class CardSearchPage(CardModel):
    """One page of provider-neutral card search results."""

    query: NonEmptyString
    page: Annotated[int, Field(ge=1)]
    total_results: Annotated[int, Field(ge=0)]
    has_more: bool
    cards: list[CardSearchResult]
    name_match_scores: dict[
        UUID,
        Annotated[float, Field(ge=0, le=1)],
    ] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    strategy: SearchStrategy = "syntax"
    interpretation: str | None = None
    reranked: bool = False
    debug: SearchDebugSummary | None = None
