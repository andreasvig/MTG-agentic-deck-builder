"""Card discovery API."""

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict

from mtg_deck_builder.domain import (
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    ColorMatchMode,
    MagicColor,
)
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
            "description": "The card-title lookup could not be executed.",
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
            description="A complete or partial card title.",
        ),
    ],
    page: Annotated[int, Query(ge=1, le=1_000)] = 1,
    color: Annotated[
        list[MagicColor] | None,
        Query(description="Allowed or exact color identities. Repeat for multiple colors."),
    ] = None,
    include_colorless: Annotated[
        bool,
        Query(description="Include colorless identities in color-filtered results."),
    ] = False,
    color_mode: Annotated[
        ColorMatchMode,
        Query(description="Match identities within the colors or require an exact identity."),
    ] = "subset",
    mana_min: Annotated[float | None, Query(ge=0, le=100)] = None,
    mana_max: Annotated[float | None, Query(ge=0, le=100)] = None,
    price_min: Annotated[Decimal | None, Query(ge=0)] = None,
    price_max: Annotated[Decimal | None, Query(ge=0)] = None,
    debug: Annotated[
        bool,
        Query(description="Write and return a layered search debug trace."),
    ] = False,
) -> CardSearchPage:
    """Return fuzzy, partial, and typo-tolerant card-title matches."""

    if mana_min is not None and mana_max is not None and mana_min > mana_max:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Minimum mana value must not exceed the maximum.",
        )
    if price_min is not None and price_max is not None and price_min > price_max:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Minimum EUR price must not exceed the maximum.",
        )

    query = CardSearchQuery(
        q=q,
        page=page,
        debug=debug,
        filters=CardSearchFilters(
            colors=color or [],
            include_colorless=include_colorless,
            color_mode=color_mode,
            mana_value_min=mana_min,
            mana_value_max=mana_max,
            price_eur_min=price_min,
            price_eur_max=price_max,
        ),
    )
    try:
        return await provider.search(query)
    except CardSearchQueryError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=PublicError(
                code="invalid_card_search",
                message="The card title could not be searched.",
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
