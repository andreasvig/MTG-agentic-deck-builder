"""One local fuzzy card-title search path with observable scoring."""

import asyncio
import logging
from dataclasses import dataclass

from rapidfuzz.fuzz import ratio

from mtg_deck_builder.card_catalog import (
    CatalogEntry,
    SQLiteCardCatalog,
    normalize_card_title,
)
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
    preview_alias: str
    preview_confidence: float
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
        preview_min_confidence: float = 0.75,
        agentic_enabled: bool = False,
    ) -> None:
        if not 1 <= page_size <= 30:
            raise ValueError("page_size must be between 1 and 30")
        if not 0 <= preview_min_confidence <= 1:
            raise ValueError("preview_min_confidence must be between 0 and 1")
        self._catalog = catalog
        self._debug_logger = debug_logger
        self._debug_default_enabled = debug_default_enabled
        self._page_size = page_size
        self._preview_min_confidence = preview_min_confidence
        self._agentic_enabled = agentic_enabled

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        trace = (
            self._debug_logger.new_trace(
                query,
                configuration={
                    "algorithm": "rapidfuzz.WRatio",
                    "catalog": str(self._catalog.path),
                    "minimum_score": None,
                    "page_size": self._page_size,
                    "preview_min_confidence": self._preview_min_confidence,
                    "agentic_enabled": self._agentic_enabled,
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
            candidate for candidate in ranked if matches_card_filters(candidate.card, query.filters)
        ]
        page_start = (query.page - 1) * self._page_size
        page_end = min(page_start + self._page_size, len(filtered))
        page_candidates = filtered[page_start:page_end]
        first_page_candidates = filtered[: self._page_size]
        preview_candidates = [
            candidate
            for candidate in first_page_candidates
            if candidate.preview_confidence >= self._preview_min_confidence
        ]
        agentic_required = (
            self._agentic_enabled and query.page == 1 and len(preview_candidates) < self._page_size
        )
        returned_candidates = preview_candidates if agentic_required else page_candidates
        cards = [candidate.card for candidate in returned_candidates]
        scores = {candidate.card.scryfall_id: candidate.score for candidate in returned_candidates}
        confidence_scores = {
            candidate.card.scryfall_id: candidate.preview_confidence
            for candidate in returned_candidates
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
                    "preview_min_confidence": self._preview_min_confidence,
                    "preview_candidate_count": len(preview_candidates),
                    "agentic_search_required": agentic_required,
                    "fuzzy_candidates": [
                        {
                            "rank": page_start + index,
                            "original_rank": candidate.original_rank,
                            "name": candidate.card.name,
                            "matched_alias": candidate.matched_alias,
                            "score": candidate.score,
                            "preview_alias": candidate.preview_alias,
                            "preview_confidence": candidate.preview_confidence,
                            "qualifies_for_preview": (
                                candidate.preview_confidence >= self._preview_min_confidence
                            ),
                        }
                        for index, candidate in enumerate(
                            first_page_candidates if query.page == 1 else page_candidates,
                            start=1,
                        )
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
                preview_candidate_count=len(preview_candidates),
                preview_min_confidence=self._preview_min_confidence,
                agentic_search_required=agentic_required,
            )

        return CardSearchPage(
            query=query.q,
            page=query.page,
            total_results=(len(preview_candidates) if agentic_required else len(filtered)),
            has_more=False if agentic_required else page_end < len(filtered),
            cards=cards,
            name_match_scores=scores,
            title_confidence_scores=confidence_scores,
            strategy="fuzzy",
            interpretation=(
                "Confident title matches shown while agentic search continues"
                if agentic_required
                else "Titles ranked locally by fuzzy similarity"
            ),
            reranked=False,
            agentic_required=agentic_required,
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
        scored_aliases = [
            (
                alias,
                name_similarity_score(query, alias),
                preview_confidence_score(query, alias),
            )
            for alias in aliases
        ]
        matched_alias, score, _ = max(
            scored_aliases,
            key=lambda match: match[1],
        )
        preview_alias, _, preview_confidence = max(
            scored_aliases,
            key=lambda match: match[2],
        )
        ranked.append(
            _RankedCard(
                card=entry.card,
                matched_alias=matched_alias,
                score=score,
                preview_alias=preview_alias,
                preview_confidence=preview_confidence,
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
            preview_alias=candidate.preview_alias,
            preview_confidence=candidate.preview_confidence,
            original_rank=rank,
        )
        for rank, candidate in enumerate(ranked, start=1)
    ]


def preview_confidence_score(query: str, candidate: str) -> float:
    """Score whether a fuzzy title result is safe to show before agent planning.

    Complete title segments retain the existing WRatio behavior. Other matches
    use whole-string edit similarity so token shortcuts cannot make a
    natural-language request look like a confident card title.
    """

    normalized_query = normalize_card_title(query)
    normalized_candidate = normalize_card_title(candidate)
    if not normalized_query or not normalized_candidate:
        return 0.0
    if normalized_query in normalized_candidate:
        return name_similarity_score(normalized_query, normalized_candidate)
    return round(ratio(normalized_query, normalized_candidate) / 100, 6)


def matches_card_filters(card: CardSearchResult, filters: CardSearchFilters) -> bool:
    """Apply immutable UI filters to a provider-neutral card."""

    selected_colors = set(filters.colors)
    identity = set(card.color_identity)

    if filters.color_mode == "exact":
        if selected_colors:
            if identity != selected_colors and not (filters.include_colorless and not identity):
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
    if filters.price_eur_min is not None and (eur is None or eur < filters.price_eur_min):
        return False
    return not (filters.price_eur_max is not None and (eur is None or eur > filters.price_eur_max))
