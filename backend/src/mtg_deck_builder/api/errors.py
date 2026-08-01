"""Stable public error envelope shared by every API route."""

from pydantic import BaseModel, ConfigDict

from mtg_deck_builder.domain import SearchDebugSummary


class PublicError(BaseModel):
    """Stable public error information for local clients."""

    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    debug: SearchDebugSummary | None = None


class PublicErrorResponse(BaseModel):
    """FastAPI's standard error envelope with a typed detail object."""

    model_config = ConfigDict(extra="forbid")

    detail: PublicError
