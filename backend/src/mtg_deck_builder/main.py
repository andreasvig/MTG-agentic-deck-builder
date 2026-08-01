"""FastAPI application entry point."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from mtg_deck_builder import __version__
from mtg_deck_builder.agentic_card_search import (
    AgenticCardSearchService,
    LocalCardSearchTool,
)
from mtg_deck_builder.agentic_search_debug import JsonlAgentSearchTraceLogger
from mtg_deck_builder.api.router import router as api_router
from mtg_deck_builder.card_catalog import SQLiteCardCatalog
from mtg_deck_builder.config import Settings, get_settings
from mtg_deck_builder.deck_agent import DeckAgentService
from mtg_deck_builder.deck_agent_tools import DeckAgentToolbox
from mtg_deck_builder.edhrec_catalog import (
    EdhrecCommanderService,
    SQLiteEdhrecCatalog,
)
from mtg_deck_builder.providers.edhrec import EdhrecJsonClient
from mtg_deck_builder.providers.openrouter import OpenRouterClient
from mtg_deck_builder.search import FuzzyTitleSearchProvider
from mtg_deck_builder.search_debug import JsonlSearchDebugLogger
from mtg_deck_builder.semantic_index import SemanticCardIndex
from mtg_deck_builder.tagger_catalog import SQLiteTaggerCatalog


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build an application instance with explicit runtime settings."""

    runtime_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        title_match = runtime_settings.search.title_match
        agentic = runtime_settings.search.agentic
        deck_agent = runtime_settings.agent
        semantic_sort = runtime_settings.search.semantic_sort
        catalog = SQLiteCardCatalog(runtime_settings.card_catalog_path)
        tagger_catalog = SQLiteTaggerCatalog(runtime_settings.tagger.database_path)
        edhrec = runtime_settings.edhrec
        edhrec_service = (
            EdhrecCommanderService(
                cache=SQLiteEdhrecCatalog(edhrec.database_path),
                card_catalog=catalog,
                client=EdhrecJsonClient(
                    base_url=edhrec.base_url,
                    user_agent=edhrec.user_agent,
                    timeout_seconds=edhrec.timeout_seconds,
                ),
                refresh_after_days=edhrec.refresh_after_days,
                similar_refresh_after_days=edhrec.similar_refresh_after_days,
            )
            if edhrec.enabled
            else None
        )
        semantic_index = SemanticCardIndex(
            path=semantic_sort.index_path,
            catalog=catalog,
            settings=semantic_sort,
            tagger_catalog=tagger_catalog,
        )
        fuzzy_provider = FuzzyTitleSearchProvider(
            catalog,
            debug_logger=JsonlSearchDebugLogger(
                runtime_settings.search_debug_log_path,
                result_limit=runtime_settings.search_debug_result_limit,
            ),
            debug_default_enabled=runtime_settings.search_debug_enabled,
            page_size=title_match.page_size,
            preview_min_confidence=title_match.preview_min_confidence,
            agentic_enabled=agentic.enabled,
            tagger_catalog=tagger_catalog,
            edhrec_service=edhrec_service,
        )
        application.state.card_catalog = catalog
        application.state.card_search_provider = fuzzy_provider
        application.state.tagger_catalog = tagger_catalog
        application.state.edhrec_service = edhrec_service
        api_key = (
            runtime_settings.openrouter_api_key.get_secret_value()
            if runtime_settings.openrouter_api_key is not None
            else None
        )
        model_client = (
            OpenRouterClient(
                api_key=api_key,
                base_url=runtime_settings.openrouter_base_url,
                timeout_seconds=agentic.timeout_seconds,
            )
            if api_key
            else None
        )
        application.state.agentic_card_search = AgenticCardSearchService(
            fuzzy_provider=fuzzy_provider,
            local_tool=LocalCardSearchTool(
                catalog,
                default_max_results=agentic.local_tool.default_max_results,
                hard_max_results=agentic.local_tool.hard_max_results,
                weighted_weights=agentic.ranking.weighted,
                semantic_index=semantic_index,
                tagger_catalog=tagger_catalog,
            ),
            model_client=model_client,
            settings=agentic,
            page_size=title_match.page_size,
            trace_logger=JsonlAgentSearchTraceLogger(runtime_settings.search_debug_log_path),
            trace_log_path=str(runtime_settings.search_debug_log_path),
            debug_default_enabled=runtime_settings.search_debug_enabled,
            edhrec_service=edhrec_service,
        )
        # The chat agent gets its own client: one xhigh reply outlives the search
        # agent's whole timeout, and a shared client would apply one of the two
        # deadlines to both.
        application.state.deck_agent = DeckAgentService(
            model_client=(
                OpenRouterClient(
                    api_key=api_key,
                    base_url=runtime_settings.openrouter_base_url,
                    timeout_seconds=deck_agent.timeout_seconds,
                )
                if api_key
                else None
            ),
            settings=deck_agent,
            # The same catalog, sidecar and EDHREC cache the interface reads, so the
            # agent and the user cannot be looking at different data.
            toolbox=DeckAgentToolbox(
                card_catalog=catalog,
                tagger_catalog=tagger_catalog,
                edhrec_service=edhrec_service,
                settings=deck_agent.tools,
                # The search agent's engine, second instance. It holds only
                # references — the same catalog, the same semantic index, the same
                # sidecar — so what differs is the two result bounds, which are
                # fixed at construction. The `weighted` blend weights are shared
                # deliberately: how much semantic closeness is worth against EDHREC
                # inclusion is a property of the ranking, not of which agent asked.
                local_tool=LocalCardSearchTool(
                    catalog,
                    default_max_results=deck_agent.tools.search_cards_default_max_results,
                    hard_max_results=deck_agent.tools.search_cards_hard_max_results,
                    weighted_weights=agentic.ranking.weighted,
                    semantic_index=semantic_index,
                    tagger_catalog=tagger_catalog,
                ),
            ),
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
