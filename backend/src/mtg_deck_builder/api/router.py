"""Versioned API route composition."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from mtg_deck_builder import __version__
from mtg_deck_builder.api.cards import router as cards_router


class HealthResponse(BaseModel):
    """Liveness response for local clients and process supervisors."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["ok"] = "ok"
    service: Literal["mtg-agentic-deck-builder-api"] = "mtg-agentic-deck-builder-api"
    version: str = __version__


router = APIRouter(prefix="/api/v1")
router.include_router(cards_router)


@router.get("/health", response_model=HealthResponse, tags=["system"])
async def health() -> HealthResponse:
    """Report that the API process is accepting requests."""

    return HealthResponse()
