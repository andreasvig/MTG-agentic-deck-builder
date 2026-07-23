"""FastAPI application entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mtg_deck_builder import __version__
from mtg_deck_builder.api.router import router as api_router
from mtg_deck_builder.config import Settings, get_settings
from mtg_deck_builder.providers import ScryfallCardSearchProvider


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build an application instance with explicit runtime settings."""

    runtime_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        timeout = httpx2.Timeout(runtime_settings.scryfall_timeout_seconds)
        async with httpx2.AsyncClient(
            base_url=runtime_settings.scryfall_base_url,
            headers={
                "Accept": "application/json;q=0.9,*/*;q=0.8",
                "User-Agent": runtime_settings.scryfall_user_agent,
            },
            timeout=timeout,
        ) as client:
            application.state.card_search_provider = ScryfallCardSearchProvider(client)
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
