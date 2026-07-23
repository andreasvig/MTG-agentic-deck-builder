"""Typed contracts for Commander decks."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class DomainModel(BaseModel):
    """Base contract that rejects unknown input and supports ORM-style sources."""

    model_config = ConfigDict(extra="forbid", from_attributes=True)


class CardReference(DomainModel):
    """Stable card identity plus the selected Scryfall printing."""

    oracle_id: UUID
    scryfall_id: UUID
    name: NonEmptyString


class DeckSection(StrEnum):
    """Supported deck zones for a stored card entry."""

    COMMAND_ZONE = "command_zone"
    MAINBOARD = "mainboard"
    MAYBEBOARD = "maybeboard"


class DeckCardEntry(DomainModel):
    """A card and its placement within a deck."""

    card: CardReference
    quantity: Annotated[int, Field(ge=1)]
    section: DeckSection
    categories: list[NonEmptyString] = Field(default_factory=list)

    @field_validator("categories")
    @classmethod
    def categories_must_be_unique(cls, categories: list[str]) -> list[str]:
        if len(categories) != len(set(categories)):
            raise ValueError("categories must not contain duplicates")
        return categories


class Deck(DomainModel):
    """Minimal persisted Commander deck representation."""

    id: UUID
    name: NonEmptyString
    format: Literal["commander"] = "commander"
    cards: list[DeckCardEntry] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
