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
SearchStrategy = Literal["fuzzy", "agentic"]
CardSearchOrder = Literal["name"]
SearchDebugStageStatus = Literal["ok", "skipped", "error"]
EdhrecEnhancementStatus = Literal["not_requested", "applied", "unavailable"]
EdhrecEnhancementSource = Literal["cache", "network"]


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
    power: str | None = None
    toughness: str | None = None
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
    power: str | None = None
    toughness: str | None = None
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


class CardTag(CardModel):
    """One human-readable Scryfall Tagger label attached to an Oracle card."""

    id: NonEmptyString
    name: NonEmptyString
    slug: NonEmptyString
    description: str | None = None


class CardTagMatch(CardTag):
    """One fuzzy tag-name result with normalized local match evidence."""

    match_score: Annotated[float, Field(ge=0, le=1)]


class CardTagFilter(CardModel):
    """An immutable interface-selected Tagger filter."""

    id: NonEmptyString
    name: NonEmptyString


class CardSubtypeMatch(CardModel):
    """One fuzzy card-subtype result with normalized local match evidence."""

    name: NonEmptyString
    match_score: Annotated[float, Field(ge=0, le=1)]


class RelatedOracleCard(CardModel):
    """A related Oracle card that can be opened independently of its printing."""

    oracle_id: UUID
    name: NonEmptyString


class CardEnrichment(CardModel):
    """Optional local Tagger context loaded only for a highlighted card.

    Every list holds the *other* card, described from the highlighted card's point
    of view: `upgrades` are the cards Tagger considers strictly better than this
    one, and `downgrades` are the ones this card outclasses.
    """

    oracle_id: UUID
    tags: list[CardTag] = Field(default_factory=list)
    similar_cards: list[RelatedOracleCard] = Field(default_factory=list)
    references: list[RelatedOracleCard] = Field(default_factory=list)
    referenced_by: list[RelatedOracleCard] = Field(default_factory=list)
    upgrades: list[RelatedOracleCard] = Field(default_factory=list)
    downgrades: list[RelatedOracleCard] = Field(default_factory=list)
    variants: list[RelatedOracleCard] = Field(default_factory=list)
    creature_versions: list[RelatedOracleCard] = Field(default_factory=list)
    spell_versions: list[RelatedOracleCard] = Field(default_factory=list)
    related_cards: list[RelatedOracleCard] = Field(default_factory=list)


class CardSearchFilters(CardModel):
    """Structured filters applied to every search strategy."""

    colors: list[MagicColor] = Field(default_factory=list, max_length=5)
    include_colorless: bool = False
    color_mode: ColorMatchMode = "subset"
    include_non_commander_legal: bool = False
    include_outside_commander_color_identity: bool = False
    commander_color_identity: list[MagicColor] | None = Field(
        default=None,
        max_length=5,
    )
    tags: list[CardTagFilter] = Field(default_factory=list, max_length=20)
    card_types: list[NonEmptyString] = Field(default_factory=list, max_length=20)
    subtypes: list[NonEmptyString] = Field(default_factory=list, max_length=50)
    mana_value_min: Annotated[float | None, Field(default=None, ge=0, le=100)] = None
    mana_value_max: Annotated[float | None, Field(default=None, ge=0, le=100)] = None
    price_eur_min: Annotated[Decimal | None, Field(default=None, ge=0)] = None
    price_eur_max: Annotated[Decimal | None, Field(default=None, ge=0)] = None

    @field_validator("colors")
    @classmethod
    def colors_must_be_unique(cls, value: list[MagicColor]) -> list[MagicColor]:
        return list(dict.fromkeys(value))

    @field_validator("commander_color_identity")
    @classmethod
    def commander_colors_must_be_unique(
        cls,
        value: list[MagicColor] | None,
    ) -> list[MagicColor] | None:
        return list(dict.fromkeys(value)) if value is not None else None

    @field_validator("tags")
    @classmethod
    def tags_must_be_unique(cls, value: list[CardTagFilter]) -> list[CardTagFilter]:
        return list({tag.id: tag for tag in value}.values())

    @field_validator("card_types", "subtypes")
    @classmethod
    def type_values_must_be_unique(cls, value: list[str]) -> list[str]:
        return list({item.casefold(): item for item in value}.values())

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

    q: Annotated[
        str,
        StringConstraints(strip_whitespace=True, max_length=4_000),
    ]
    page: Annotated[int, Field(ge=1, le=1_000)] = 1
    filters: CardSearchFilters = Field(default_factory=CardSearchFilters)
    order: CardSearchOrder = "name"
    debug: bool = False
    commander_oracle_id: UUID | None = None
    enhance_with_edhrec: bool = False
    edhrec_theme: Annotated[
        str | None,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=100,
            pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
        ),
    ] = None


class AgenticCardSearchRequest(CardModel):
    """Start or continue one progressive agentic card search."""

    q: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000),
    ]
    page: Annotated[int, Field(ge=1, le=1_000)] = 1
    filters: CardSearchFilters = Field(default_factory=CardSearchFilters)
    debug: bool = False
    search_session_id: UUID | None = None
    already_shown_oracle_ids: list[UUID] = Field(default_factory=list, max_length=10_000)
    commander_oracle_id: UUID | None = None
    enhance_with_edhrec: bool = False
    edhrec_theme: Annotated[
        str | None,
        StringConstraints(
            strip_whitespace=True,
            min_length=1,
            max_length=100,
            pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
        ),
    ] = None

    @field_validator("already_shown_oracle_ids")
    @classmethod
    def already_shown_ids_must_be_unique(cls, value: list[UUID]) -> list[UUID]:
        return list(dict.fromkeys(value))


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
    # What the model calls in this run cost, in USD, as the provider accounted for
    # it. `None` means no figure was reported, which a local fuzzy search never has.
    total_cost_usd: Annotated[float, Field(ge=0)] | None = None
    stages: list[SearchDebugStage]
    trace: dict[str, Any]


class EdhrecSearchEnhancement(CardModel):
    """Outcome of optional filter-only EDHREC commander ranking."""

    status: EdhrecEnhancementStatus = "not_requested"
    source: EdhrecEnhancementSource | None = None
    message: str | None = None


class EdhrecDeckTheme(CardModel):
    """One EDHREC deck theme available for the selected commander."""

    slug: NonEmptyString
    name: NonEmptyString
    deck_count: Annotated[int, Field(ge=0)]


class EdhrecCommanderContext(CardModel):
    """Public load state and theme choices for one selected commander."""

    status: EdhrecEnhancementStatus
    source: EdhrecEnhancementSource | None = None
    commander_oracle_id: UUID
    commander_name: str | None = None
    themes: list[EdhrecDeckTheme] = Field(default_factory=list)
    message: str | None = None


class EdhrecSimilarCard(CardModel):
    """One EDHREC similar-card suggestion, kept in the order EDHREC published it.

    `oracle_id` is absent when the published name matches nothing in the local
    catalog, which keeps an unresolvable suggestion visible instead of dropping it
    silently. Only a resolved suggestion can be opened as a card.
    """

    rank: Annotated[int, Field(ge=1)]
    name: NonEmptyString
    oracle_id: UUID | None = None


class EdhrecSimilarCards(CardModel):
    """Public load state and EDHREC's similar-card list for one highlighted card."""

    status: EdhrecEnhancementStatus
    source: EdhrecEnhancementSource | None = None
    oracle_id: UUID
    cards: list[EdhrecSimilarCard] = Field(default_factory=list)
    message: str | None = None


class CardSearchPage(CardModel):
    """One page of provider-neutral card search results."""

    query: str
    page: Annotated[int, Field(ge=1)]
    total_results: Annotated[int, Field(ge=0)]
    has_more: bool
    cards: list[CardSearchResult]
    name_match_scores: dict[
        UUID,
        Annotated[float, Field(ge=0, le=1)],
    ] = Field(default_factory=dict)
    title_confidence_scores: dict[
        UUID,
        Annotated[float, Field(ge=0, le=1)],
    ] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    strategy: SearchStrategy = "fuzzy"
    interpretation: str | None = None
    reranked: bool = False
    agentic_required: bool = False
    search_session_id: UUID | None = None
    edhrec: EdhrecSearchEnhancement = Field(default_factory=EdhrecSearchEnhancement)
    debug: SearchDebugSummary | None = None
    debug_runs: list[SearchDebugSummary] = Field(default_factory=list)
