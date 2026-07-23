"""FastAPI application entry point."""

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager

import httpx2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mtg_deck_builder import __version__
from mtg_deck_builder.api.router import router as api_router
from mtg_deck_builder.config import Settings, get_settings
from mtg_deck_builder.providers import ScryfallCardSearchProvider
from mtg_deck_builder.search import (
    FastEmbedCardRanker,
    HybridCardSearchProvider,
    OpenRouterCardReranker,
)
from mtg_deck_builder.search_debug import JsonlSearchDebugLogger


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build an application instance with explicit runtime settings."""

    runtime_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            scryfall_client = await stack.enter_async_context(
                httpx2.AsyncClient(
                    base_url=runtime_settings.scryfall_base_url,
                    headers={
                        "Accept": "application/json;q=0.9,*/*;q=0.8",
                        "User-Agent": runtime_settings.scryfall_user_agent,
                    },
                    timeout=httpx2.Timeout(runtime_settings.scryfall_timeout_seconds),
                )
            )
            scryfall = ScryfallCardSearchProvider(scryfall_client)
            llm_ranker = None
            if runtime_settings.openrouter_api_key is not None:
                openrouter_client = await stack.enter_async_context(
                    httpx2.AsyncClient(
                        base_url=runtime_settings.openrouter_base_url,
                        headers={
                            "Accept": "application/json",
                            "Authorization": (
                                "Bearer "
                                f"{runtime_settings.openrouter_api_key.get_secret_value()}"
                            ),
                            "HTTP-Referer": runtime_settings.frontend_origin,
                            "X-Title": "MTG Agentic Deck Builder",
                        },
                        timeout=httpx2.Timeout(
                            runtime_settings.openrouter_timeout_seconds
                        ),
                    )
                )
                llm_ranker = OpenRouterCardReranker(
                    openrouter_client,
                    model=runtime_settings.openrouter_model,
                    provider=runtime_settings.openrouter_provider,
                    reasoning_effort=runtime_settings.openrouter_reasoning_effort,
                    max_tokens=runtime_settings.openrouter_max_tokens,
                )
            application.state.card_search_provider = HybridCardSearchProvider(
                scryfall,
                semantic_ranker=FastEmbedCardRanker(
                    runtime_settings.embedding_model
                ),
                llm_ranker=llm_ranker,
                debug_logger=JsonlSearchDebugLogger(
                    runtime_settings.search_debug_log_path,
                    result_limit=runtime_settings.search_debug_result_limit,
                ),
                debug_default_enabled=runtime_settings.search_debug_enabled,
                fuzzy_candidate_limit=(
                    runtime_settings.fuzzy_name_candidate_limit
                ),
                fuzzy_min_score=runtime_settings.fuzzy_name_min_score,
            )
            yield

    application = FastAPI(
        title="MTG Agentic Deck Builder API",
        version=__version__,
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[runtime_settings.frontend_origin],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(api_router)
    return application


app = create_app()


def run() -> None:
    """Run the development server using configured network settings."""

    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "mtg_deck_builder.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )


if __name__ == "__main__":
    run()
