"""Card discovery API."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict

from mtg_deck_builder.domain import CardSearchPage, CardSearchQuery
from mtg_deck_builder.providers import (
    CardSearchProvider,
    CardSearchQueryError,
    CardSearchUnavailable,
)

router = APIRouter(prefix="/cards", tags=["cards"])


class PublicError(BaseModel):
    """Stable public error information for card-search clients."""

    model_config = ConfigDict(extra="forbid")

    code: str
    message: str


class PublicErrorResponse(BaseModel):
    """FastAPI's standard error envelope with a typed detail object."""

    model_config = ConfigDict(extra="forbid")

    detail: PublicError


def get_card_search_provider(request: Request) -> CardSearchProvider:
    """Resolve the provider configured for this application process."""

    return request.app.state.card_search_provider


@router.get(
    "/search",
    response_model=CardSearchPage,
    responses={
        status.HTTP_400_BAD_REQUEST: {
            "description": "The Scryfall search expression is invalid.",
            "model": PublicErrorResponse,
        },
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "description": "The card-data provider is temporarily unavailable.",
            "model": PublicErrorResponse,
        },
    },
)
async def search_cards(
    provider: Annotated[CardSearchProvider, Depends(get_card_search_provider)],
    q: Annotated[
        str,
        Query(
            min_length=1,
            max_length=500,
            pattern=r".*\S.*",
            description="A Scryfall full-text search expression.",
        ),
    ],
    page: Annotated[int, Query(ge=1, le=1_000)] = 1,
) -> CardSearchPage:
    """Return one representative printing per card matching an expression."""

    query = CardSearchQuery(q=q, page=page)
    try:
        return await provider.search(query)
    except CardSearchQueryError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=PublicError(
                code="invalid_card_search",
                message="The card search query is not valid.",
            ).model_dump(),
        ) from None
    except CardSearchUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_search_unavailable",
                message="Card search is temporarily unavailable.",
            ).model_dump(),
        ) from None
