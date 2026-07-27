"""FastAPI application entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mtg_deck_builder import __version__
from mtg_deck_builder.api.router import router as api_router
from mtg_deck_builder.card_catalog import SQLiteCardCatalog
from mtg_deck_builder.config import Settings, get_settings
from mtg_deck_builder.search import FuzzyTitleSearchProvider
from mtg_deck_builder.search_debug import JsonlSearchDebugLogger


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build an application instance with explicit runtime settings."""

    runtime_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        title_match = runtime_settings.search.title_match
        application.state.card_search_provider = FuzzyTitleSearchProvider(
            SQLiteCardCatalog(runtime_settings.card_catalog_path),
            debug_logger=JsonlSearchDebugLogger(
                runtime_settings.search_debug_log_path,
                result_limit=runtime_settings.search_debug_result_limit,
            ),
            debug_default_enabled=runtime_settings.search_debug_enabled,
            page_size=title_match.page_size,
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
