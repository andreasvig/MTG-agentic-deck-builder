"""Strict contracts for progressive agentic card search."""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from mtg_deck_builder.domain.cards import (
    CardLegality,
    CardSearchResult,
    ColorMatchMode,
    MagicColor,
)

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
BoundedString = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000),
]
SearchToolName = Literal["search_local_cards"]
AgentTraceStatus = Literal["ok", "error", "cancelled"]
AgentTraceStageName = Literal[
    "request_context",
    "initial_model_request",
    "initial_model_response",
    "tool_call",
    "tool_result",
    "final_model_request",
    "final_model_response",
    "validation",
]

COMPLETED_AGENT_TRACE_STAGES: tuple[AgentTraceStageName, ...] = (
    "request_context",
    "initial_model_request",
    "initial_model_response",
    "tool_call",
    "tool_result",
    "final_model_request",
    "final_model_response",
    "validation",
)


class AgentSearchModel(BaseModel):
    """Strict base model for internal agentic-search contracts."""

    model_config = ConfigDict(extra="forbid")


class TextConditions(AgentSearchModel):
    """Exact text conditions with multiset semantics for duplicate values."""

    must_contain_all: list[NonEmptyString] = Field(
        default_factory=list,
        max_length=50,
        description=(
            "Literal values that must all occur. Duplicate values require that many occurrences."
        ),
    )
    must_contain_any: list[NonEmptyString] = Field(
        default_factory=list,
        max_length=50,
        description="At least one of these literal values must occur.",
    )
    must_not_contain: list[NonEmptyString] = Field(
        default_factory=list,
        max_length=50,
        description="Cards containing any of these literal values are removed.",
    )


class NameSearch(AgentSearchModel):
    """Optional name search for the local card tool."""

    query: BoundedString | None = Field(
        default=None,
        description=(
            "Case-insensitive complete or partial card-name filter. "
            "Use semantic_sort for concepts rather than names."
        ),
    )


class OracleTextSearch(TextConditions):
    """Literal Oracle-text filters."""


class ManaSearch(TextConditions):
    """Combined mana-value and mana-cost conditions."""

    value_minimum: Annotated[
        float | None,
        Field(default=None, ge=0, le=100, description="Inclusive mana-value minimum."),
    ] = None
    value_maximum: Annotated[
        float | None,
        Field(default=None, ge=0, le=100, description="Inclusive mana-value maximum."),
    ] = None

    @model_validator(mode="after")
    def range_must_be_ordered(self) -> "ManaSearch":
        if (
            self.value_minimum is not None
            and self.value_maximum is not None
            and self.value_minimum > self.value_maximum
        ):
            raise ValueError("value_minimum must not exceed value_maximum")
        return self


class TypeSearch(TextConditions):
    """Literal type-line filters, such as Creature, Elf, Artifact, or Saga."""


class ColorSearch(AgentSearchModel):
    """Optional color-identity conditions."""

    identity: list[MagicColor] | None = Field(
        default=None,
        max_length=5,
        description="Requested W/U/B/R/G color identity.",
    )
    mode: ColorMatchMode = Field(
        default="subset",
        description=(
            "subset allows cards whose identity is contained in the requested "
            "identity; exact requires equality."
        ),
    )
    include_colorless: bool = Field(
        default=False,
        description="Also allow exactly colorless identity.",
    )

    @field_validator("identity")
    @classmethod
    def identity_must_be_unique(
        cls,
        value: list[MagicColor] | None,
    ) -> list[MagicColor] | None:
        return list(dict.fromkeys(value)) if value is not None else None


class NumericRange(AgentSearchModel):
    """Optional inclusive numeric range."""

    minimum: Annotated[float | None, Field(default=None, ge=0, le=1_000)] = None
    maximum: Annotated[float | None, Field(default=None, ge=0, le=1_000)] = None

    @model_validator(mode="after")
    def range_must_be_ordered(self) -> "NumericRange":
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("minimum must not exceed maximum")
        return self


class PriceRange(AgentSearchModel):
    """Optional inclusive EUR price range."""

    minimum: Annotated[Decimal | None, Field(default=None, ge=0)] = None
    maximum: Annotated[Decimal | None, Field(default=None, ge=0)] = None

    @model_validator(mode="after")
    def range_must_be_ordered(self) -> "PriceRange":
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("minimum must not exceed maximum")
        return self


class LocalCardSearchRequest(AgentSearchModel):
    """All-optional structured input for the local card-search tool."""

    semantic_sort: BoundedString | None = Field(
        default=None,
        description=(
            "A natural-language description of the user's intended cards. "
            "It sorts surviving candidates by meaning and never filters them."
        ),
    )
    name: NameSearch | None = None
    oracle_text: OracleTextSearch | None = None
    mana: ManaSearch | None = None
    types: TypeSearch | None = None
    colors: ColorSearch | None = None
    power: NumericRange | None = None
    toughness: NumericRange | None = None
    price_eur: PriceRange | None = None
    format: NonEmptyString | None = Field(
        default=None,
        description="Format name used for an exact legality filter.",
    )
    legality: CardLegality | None = Field(
        default=None,
        description="Required legality; format must also be supplied.",
    )
    sets: list[NonEmptyString] | None = Field(
        default=None,
        max_length=100,
        description="Allowed exact set codes.",
    )
    rarities: list[NonEmptyString] | None = Field(
        default=None,
        max_length=20,
        description="Allowed exact rarity names.",
    )
    max_results: Annotated[
        int | None,
        Field(
            default=None,
            ge=1,
            le=60,
            description="Maximum top candidates returned after filtering and sorting.",
        ),
    ] = None

    def has_agent_criteria(self) -> bool:
        """Return whether the model supplied a meaningful search condition."""

        payload = self.model_dump(exclude_none=True, exclude_defaults=True)
        payload.pop("max_results", None)
        return any(value not in ({}, []) for value in payload.values())


class LocalSearchToolCall(AgentSearchModel):
    """Discriminated call to the structured local card tool."""

    name: Literal["search_local_cards"]
    arguments: LocalCardSearchRequest


AgentSearchToolCall = LocalSearchToolCall


class AgentSearchCandidate(AgentSearchModel):
    """One tool candidate with the evidence needed by the final ranking call."""

    card: CardSearchResult
    semantic_score: Annotated[float | None, Field(default=None, ge=0, le=1)] = None
    exact_match_evidence: list[str] = Field(default_factory=list)
    filter_decisions: dict[str, bool] = Field(default_factory=dict)


class LocalCardSearchResult(AgentSearchModel):
    """Bounded result returned by the local card-search tool."""

    request: LocalCardSearchRequest
    total_candidates: Annotated[int, Field(ge=0)]
    candidates: list[AgentSearchCandidate] = Field(max_length=60)
    compiled_query: dict[str, Any]


class AgentRankedSearchOutput(AgentSearchModel):
    """Final structured output after the single allowed tool call."""

    interpretation: BoundedString
    ranked_ids: list[Annotated[int, Field(ge=1, le=1_000_000)]] = Field(max_length=90)

    @field_validator("ranked_ids")
    @classmethod
    def ranked_ids_must_be_unique(cls, value: list[int]) -> list[int]:
        if len(value) != len(set(value)):
            raise ValueError("ranked_ids must be unique")
        return value


class AgentTraceStage(AgentSearchModel):
    """One complete, untruncated observable stage in an agent run."""

    name: AgentTraceStageName
    recorded_at: datetime
    duration_ms: Annotated[float | None, Field(default=None, ge=0)] = None
    payload: dict[str, Any]


class AgentSearchTraceRecord(AgentSearchModel):
    """Versioned persisted and inline trace for one completed agentic search."""

    schema_version: Literal[2] = 2
    trace_id: UUID
    started_at: datetime
    completed_at: datetime
    status: AgentTraceStatus
    stages: list[AgentTraceStage]
    error: dict[str, Any] | None = None

    @model_validator(mode="after")
    def successful_trace_must_contain_every_stage(self) -> "AgentSearchTraceRecord":
        if self.status != "ok":
            return self
        names = tuple(stage.name for stage in self.stages)
        if names != COMPLETED_AGENT_TRACE_STAGES:
            raise ValueError(
                "successful agent trace must contain every observable stage exactly once "
                "and in execution order"
            )
        return self
