"""Card discovery API."""

from decimal import Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool

from mtg_deck_builder.agentic_card_search import (
    AgenticCardSearchService,
    AgenticCardSearchUnavailable,
)
from mtg_deck_builder.api.errors import PublicError, PublicErrorResponse
from mtg_deck_builder.card_catalog import SQLiteCardCatalog
from mtg_deck_builder.domain import (
    AgenticCardSearchRequest,
    CardEnrichment,
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
    CardSubtypeMatch,
    CardTagMatch,
    ColorMatchMode,
    EdhrecCommanderContext,
    EdhrecDeckTheme,
    EdhrecSimilarCard,
    EdhrecSimilarCards,
    MagicColor,
)
from mtg_deck_builder.edhrec_catalog import (
    EdhrecCatalogUnavailable,
    EdhrecCommanderService,
)
from mtg_deck_builder.providers import (
    CardSearchProvider,
    CardSearchQueryError,
    CardSearchUnavailable,
)
from mtg_deck_builder.search import search_card_subtypes
from mtg_deck_builder.tagger_catalog import (
    SQLiteTaggerCatalog,
    TaggerCatalogUnavailable,
    TaggerTagNotFound,
)

router = APIRouter(prefix="/cards", tags=["cards"])


def get_card_search_provider(request: Request) -> CardSearchProvider:
    """Resolve the provider configured for this application process."""

    return request.app.state.card_search_provider


def get_agentic_card_search(request: Request) -> AgenticCardSearchService:
    """Resolve the progressive agentic-search service."""

    return request.app.state.agentic_card_search


def get_tagger_catalog(request: Request) -> SQLiteTaggerCatalog:
    """Resolve the read-only local Tagger enrichment catalog."""

    return request.app.state.tagger_catalog


def get_card_catalog(request: Request) -> SQLiteCardCatalog:
    """Resolve the canonical local card catalog."""

    return request.app.state.card_catalog


def get_edhrec_service(request: Request) -> EdhrecCommanderService | None:
    """Resolve optional on-demand EDHREC commander enrichment."""

    return request.app.state.edhrec_service


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
    tagger_catalog: Annotated[SQLiteTaggerCatalog, Depends(get_tagger_catalog)],
    q: Annotated[
        str,
        Query(
            max_length=500,
            description="An optional complete or partial card title.",
        ),
    ] = "",
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
    include_non_commander_legal: Annotated[
        bool,
        Query(description="Include cards that are not legal in Commander."),
    ] = False,
    include_outside_commander_identity: Annotated[
        bool,
        Query(description="Include cards outside the supplied commander identity."),
    ] = False,
    commander_color: Annotated[
        list[MagicColor] | None,
        Query(description="The current deck commander's color identity."),
    ] = None,
    commander_identity_known: Annotated[
        bool,
        Query(description=("Whether a commander identity is established, including colorless.")),
    ] = False,
    tag: Annotated[
        list[str] | None,
        Query(description="Required Tagger IDs. Repeat to require every selected tag."),
    ] = None,
    card_type: Annotated[
        list[str] | None,
        Query(description=("Required literal card types. Repeat to require every selected type.")),
    ] = None,
    subtype: Annotated[
        list[str] | None,
        Query(
            description=(
                "Required literal card subtypes. Repeat to require every selected subtype."
            )
        ),
    ] = None,
    commander_oracle_id: Annotated[
        UUID | None,
        Query(description="The single selected commander used for optional EDHREC ranking."),
    ] = None,
    enhance_with_edhrec: Annotated[
        bool,
        Query(description="Rank filter-only results by cached EDHREC inclusion data."),
    ] = False,
    edhrec_theme: Annotated[
        str | None,
        Query(
            min_length=1,
            max_length=100,
            pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$",
            description="Optional EDHREC theme slug for commander-specific ranking.",
        ),
    ] = None,
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

    try:
        selected_tags = await run_in_threadpool(
            tagger_catalog.tag_filters,
            tag or [],
        )
    except TaggerTagNotFound:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=PublicError(
                code="invalid_card_tag",
                message="A selected card tag is no longer available.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    except TaggerCatalogUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_enrichment_unavailable",
                message="Card tags and relationships are not available yet.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None

    query = CardSearchQuery(
        q=q,
        page=page,
        debug=debug,
        commander_oracle_id=commander_oracle_id,
        enhance_with_edhrec=enhance_with_edhrec,
        edhrec_theme=edhrec_theme,
        filters=CardSearchFilters(
            colors=color or [],
            include_colorless=include_colorless,
            color_mode=color_mode,
            include_non_commander_legal=include_non_commander_legal,
            include_outside_commander_color_identity=(include_outside_commander_identity),
            commander_color_identity=(
                commander_color or []
                if commander_identity_known or commander_color is not None
                else None
            ),
            tags=selected_tags,
            card_types=card_type or [],
            subtypes=subtype or [],
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
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    except CardSearchUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_search_unavailable",
                message="Card search is temporarily unavailable.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None


@router.post(
    "/search/agentic",
    response_model=CardSearchPage,
    responses={
        status.HTTP_400_BAD_REQUEST: {
            "description": "The agentic search request or session was invalid.",
            "model": PublicErrorResponse,
        },
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "description": "Agentic card search is temporarily unavailable.",
            "model": PublicErrorResponse,
        },
        status.HTTP_502_BAD_GATEWAY: {
            "description": "The search agent returned an invalid response.",
            "model": PublicErrorResponse,
        },
    },
)
async def search_cards_agentically(
    request_body: AgenticCardSearchRequest,
    request: Request,
    tagger_catalog: Annotated[SQLiteTaggerCatalog, Depends(get_tagger_catalog)],
) -> CardSearchPage:
    """Run one tool-assisted search or page through its stored ranking."""

    service = get_agentic_card_search(request)
    try:
        selected_tags = await run_in_threadpool(
            tagger_catalog.tag_filters,
            [tag.id for tag in request_body.filters.tags],
        )
        canonical_filters = request_body.filters.model_copy(
            update={"tags": selected_tags},
        )
        return await service.search(
            request_body.model_copy(update={"filters": canonical_filters}),
        )
    except TaggerTagNotFound:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=PublicError(
                code="invalid_card_tag",
                message="A selected card tag is no longer available.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    except TaggerCatalogUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_enrichment_unavailable",
                message="Card tags and relationships are not available yet.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    except CardSearchQueryError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=PublicError(
                code="invalid_agentic_search",
                message="The agentic card search could not be completed.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    except AgenticCardSearchUnavailable as exc:
        if exc.contract_error:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=PublicError(
                    code="agentic_search_contract_error",
                    message=(
                        "The search agent returned invalid search parameters. Please try again."
                    ),
                    debug=exc.debug,
                ).model_dump(mode="json", exclude_none=True),
            ) from None
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="agentic_search_unavailable",
                message="Agentic card search is temporarily unavailable.",
                debug=exc.debug,
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    except CardSearchUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="agentic_search_unavailable",
                message="Agentic card search is temporarily unavailable.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None


@router.get("/tags/search", response_model=list[CardTagMatch])
def search_card_tags(
    catalog: Annotated[SQLiteTaggerCatalog, Depends(get_tagger_catalog)],
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=20)] = 12,
) -> list[CardTagMatch]:
    """Return fuzzy local Tagger matches for the filter picker."""

    try:
        return catalog.search_tags(q, limit=limit)
    except TaggerCatalogUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_enrichment_unavailable",
                message="Card tags and relationships are not available yet.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None


@router.get("/subtypes/search", response_model=list[CardSubtypeMatch])
async def search_subtypes(
    catalog: Annotated[SQLiteCardCatalog, Depends(get_card_catalog)],
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=20)] = 12,
) -> list[CardSubtypeMatch]:
    """Return fuzzy matches from the local printed card-subtype vocabulary."""

    try:
        entries = await catalog.entries()
    except CardSearchUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_search_unavailable",
                message="Card subtypes are temporarily unavailable.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    return await run_in_threadpool(
        search_card_subtypes,
        entries,
        q,
        limit=limit,
    )


@router.get("/{oracle_id}/edhrec", response_model=EdhrecCommanderContext)
async def get_commander_edhrec_context(
    oracle_id: UUID,
    service: Annotated[EdhrecCommanderService | None, Depends(get_edhrec_service)],
) -> EdhrecCommanderContext:
    """Return fresh commander theme choices without making search depend on them."""

    if service is None:
        return EdhrecCommanderContext(
            status="unavailable",
            commander_oracle_id=oracle_id,
            message="EDHREC enhancement is disabled. Local card search still works.",
        )
    try:
        context = await service.context_for(oracle_id)
    except EdhrecCatalogUnavailable:
        return EdhrecCommanderContext(
            status="unavailable",
            commander_oracle_id=oracle_id,
            message=(
                "EDHREC commander themes could not be fetched. Local card search still works."
            ),
        )
    return EdhrecCommanderContext(
        status="applied",
        source=context.source,
        commander_oracle_id=oracle_id,
        commander_name=context.commander_name,
        themes=[
            EdhrecDeckTheme(
                slug=theme.slug,
                name=theme.name,
                deck_count=theme.deck_count,
            )
            for theme in context.themes
        ],
    )


@router.get("/{oracle_id}/edhrec/similar", response_model=EdhrecSimilarCards)
async def get_card_edhrec_similar(
    oracle_id: UUID,
    service: Annotated[EdhrecCommanderService | None, Depends(get_edhrec_service)],
) -> EdhrecSimilarCards:
    """Return EDHREC's similar-card list without making card display depend on it."""

    if service is None:
        return EdhrecSimilarCards(
            status="unavailable",
            oracle_id=oracle_id,
            message="EDHREC enhancement is disabled. Local card search still works.",
        )
    try:
        similar = await service.similar_cards_for(oracle_id)
    except EdhrecCatalogUnavailable:
        return EdhrecSimilarCards(
            status="unavailable",
            oracle_id=oracle_id,
            message="EDHREC similar cards could not be fetched.",
        )
    return EdhrecSimilarCards(
        status="applied",
        source=similar.source,
        oracle_id=oracle_id,
        cards=[
            EdhrecSimilarCard(
                rank=suggestion.rank,
                name=suggestion.name,
                oracle_id=suggestion.oracle_id,
            )
            for suggestion in similar.suggestions
        ],
    )


@router.get(
    "/{oracle_id}",
    response_model=CardSearchResult,
    responses={
        status.HTTP_404_NOT_FOUND: {
            "description": "The Oracle card is not present in the local catalog.",
            "model": PublicErrorResponse,
        },
    },
)
async def get_card(
    oracle_id: UUID,
    catalog: Annotated[SQLiteCardCatalog, Depends(get_card_catalog)],
) -> CardSearchResult:
    """Return the canonical local printing used by card-detail navigation."""

    try:
        card = await catalog.card_by_oracle_id(str(oracle_id))
    except CardSearchUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_search_unavailable",
                message="Card search is temporarily unavailable.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None
    if card is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=PublicError(
                code="card_not_found",
                message="That card is not available in the local catalog.",
            ).model_dump(mode="json", exclude_none=True),
        )
    return card


@router.get(
    "/{oracle_id}/enrichment",
    response_model=CardEnrichment,
    responses={
        status.HTTP_503_SERVICE_UNAVAILABLE: {
            "description": "The optional local Tagger sidecar is unavailable.",
            "model": PublicErrorResponse,
        },
    },
)
def get_card_enrichment(
    oracle_id: UUID,
    catalog: Annotated[SQLiteTaggerCatalog, Depends(get_tagger_catalog)],
) -> CardEnrichment:
    """Return lazy-loaded local Tagger context for one highlighted card."""

    try:
        return catalog.card_enrichment(oracle_id)
    except TaggerCatalogUnavailable:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=PublicError(
                code="card_enrichment_unavailable",
                message="Card tags and relationships are not available yet.",
            ).model_dump(mode="json", exclude_none=True),
        ) from None
