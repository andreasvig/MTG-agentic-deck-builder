"""One local fuzzy card-title search path with observable scoring."""

import asyncio
import logging
from dataclasses import dataclass

from mtg_deck_builder.card_catalog import CatalogEntry, SQLiteCardCatalog
from mtg_deck_builder.domain import (
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
)
from mtg_deck_builder.providers import name_similarity_score
from mtg_deck_builder.search_debug import (
    JsonlSearchDebugLogger,
    SearchDebugTrace,
    stage_elapsed_ms,
    stage_started,
)

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class _RankedCard:
    card: CardSearchResult
    matched_alias: str
    score: float
    original_rank: int = 0


class FuzzyTitleSearchProvider:
    """Rank the complete local card catalog without a score threshold."""

    def __init__(
        self,
        catalog: SQLiteCardCatalog,
        *,
        debug_logger: JsonlSearchDebugLogger | None = None,
        debug_default_enabled: bool = False,
        page_size: int = 12,
    ) -> None:
        if not 1 <= page_size <= 30:
            raise ValueError("page_size must be between 1 and 30")
        self._catalog = catalog
        self._debug_logger = debug_logger
        self._debug_default_enabled = debug_default_enabled
        self._page_size = page_size

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        trace = (
            self._debug_logger.new_trace(
                query,
                configuration={
                    "algorithm": "rapidfuzz.WRatio",
                    "catalog": str(self._catalog.path),
                    "minimum_score": None,
                    "page_size": self._page_size,
                },
            )
            if self._debug_logger is not None and (self._debug_default_enabled or query.debug)
            else None
        )
        try:
            page = await self._search(query, trace)
        except asyncio.CancelledError as exc:
            await self._record_failed_trace(trace, exc)
            raise
        except Exception as exc:
            await self._record_failed_trace(trace, exc)
            raise

        if trace is None:
            return page

        trace.finish(page)
        log_written = await self._write_trace(trace)
        return page.model_copy(update={"debug": trace.summary(log_written=log_written)})

    async def _search(
        self,
        query: CardSearchQuery,
        trace: SearchDebugTrace | None,
    ) -> CardSearchPage:
        search_started = stage_started()
        entries = await self._catalog.entries()
        ranked = await asyncio.to_thread(_rank_cards, query.q, entries)
        filtered = [
            candidate
            for candidate in ranked
            if _matches_filters(candidate.card, query.filters)
        ]
        page_start = (query.page - 1) * self._page_size
        page_end = min(page_start + self._page_size, len(filtered))
        page_candidates = filtered[page_start:page_end]
        cards = [candidate.card for candidate in page_candidates]
        scores = {
            candidate.card.scryfall_id: candidate.score for candidate in page_candidates
        }

        if trace is not None:
            trace.add_stage(
                "Local fuzzy title ranking",
                status="ok",
                duration_ms=stage_elapsed_ms(search_started),
                output_cards=cards,
                details={
                    "algorithm": "rapidfuzz.WRatio",
                    "minimum_score": None,
                    "catalog_card_count": len(entries),
                    "filtered_card_count": len(filtered),
                    "removed_by_filters": len(entries) - len(filtered),
                    "page": query.page,
                    "page_size": self._page_size,
                    "page_start": page_start,
                    "page_end": page_end,
                    "top_score": filtered[0].score if filtered else None,
                    "fuzzy_candidates": [
                        {
                            "rank": page_start + index,
                            "original_rank": candidate.original_rank,
                            "name": candidate.card.name,
                            "matched_alias": candidate.matched_alias,
                            "score": candidate.score,
                        }
                        for index, candidate in enumerate(page_candidates, start=1)
                    ],
                },
            )
            trace.set_decision(
                input_kind="card_title",
                strategy="fuzzy",
                source="local_sqlite_catalog",
                top_score=filtered[0].score if filtered else None,
                page=query.page,
                page_start=page_start,
                page_end=page_end,
            )

        return CardSearchPage(
            query=query.q,
            page=query.page,
            total_results=len(filtered),
            has_more=page_end < len(filtered),
            cards=cards,
            name_match_scores=scores,
            strategy="fuzzy",
            interpretation="Titles ranked locally by fuzzy similarity",
            reranked=False,
        )

    async def _record_failed_trace(
        self,
        trace: SearchDebugTrace | None,
        error: BaseException,
    ) -> None:
        if trace is None:
            return
        trace.finish_error(error)
        await self._write_trace(trace)

    async def _write_trace(self, trace: SearchDebugTrace) -> bool:
        if self._debug_logger is None:
            return False
        try:
            await self._debug_logger.write(trace)
        except Exception as exc:
            _LOGGER.warning(
                "Search debug log write failed (%s): %s",
                type(exc).__name__,
                exc,
            )
            return False
        return True


def _rank_cards(query: str, entries: tuple[CatalogEntry, ...]) -> list[_RankedCard]:
    ranked: list[_RankedCard] = []
    for entry in entries:
        aliases = entry.aliases or (entry.card.name.casefold(),)
        matched_alias, score = max(
            (
                (alias, name_similarity_score(query, alias))
                for alias in aliases
            ),
            key=lambda match: match[1],
        )
        ranked.append(
            _RankedCard(
                card=entry.card,
                matched_alias=matched_alias,
                score=score,
            )
        )
    ranked.sort(
        key=lambda candidate: (
            -candidate.score,
            abs(len(candidate.matched_alias) - len(query)),
            candidate.card.name.casefold(),
        )
    )
    return [
        _RankedCard(
            card=candidate.card,
            matched_alias=candidate.matched_alias,
            score=candidate.score,
            original_rank=rank,
        )
        for rank, candidate in enumerate(ranked, start=1)
    ]


def _matches_filters(card: CardSearchResult, filters: CardSearchFilters) -> bool:
    selected_colors = set(filters.colors)
    identity = set(card.color_identity)

    if filters.color_mode == "exact":
        if selected_colors:
            if identity != selected_colors and not (
                filters.include_colorless and not identity
            ):
                return False
        elif filters.include_colorless and identity:
            return False
    elif selected_colors:
        if identity:
            if not identity.issubset(selected_colors):
                return False
        elif not filters.include_colorless:
            return False
    elif filters.include_colorless and identity:
        return False

    if filters.mana_value_min is not None and card.mana_value < filters.mana_value_min:
        return False
    if filters.mana_value_max is not None and card.mana_value > filters.mana_value_max:
        return False

    eur = card.prices.eur
    if filters.price_eur_min is not None and (
        eur is None or eur < filters.price_eur_min
    ):
        return False
    return not (
        filters.price_eur_max is not None
        and (eur is None or eur > filters.price_eur_max)
    )
