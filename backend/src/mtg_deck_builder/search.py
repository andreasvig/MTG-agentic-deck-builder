"""One local fuzzy card-title search path with observable scoring."""

import asyncio
import logging
from dataclasses import dataclass
from uuid import UUID

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
    CardSubtypeMatch,
    EdhrecSearchEnhancement,
)
from mtg_deck_builder.edhrec_catalog import (
    EdhrecCatalogUnavailable,
    EdhrecCommanderRanking,
    EdhrecCommanderService,
)
from mtg_deck_builder.providers import CardSearchUnavailable, name_similarity_score
from mtg_deck_builder.search_debug import (
    JsonlSearchDebugLogger,
    SearchDebugTrace,
    stage_elapsed_ms,
    stage_started,
)
from mtg_deck_builder.tagger_catalog import (
    SQLiteTaggerCatalog,
    TaggerCatalogUnavailable,
)

_LOGGER = logging.getLogger(__name__)
CARD_TYPES: tuple[str, ...] = (
    "Artifact",
    "Battle",
    "Creature",
    "Enchantment",
    "Instant",
    "Kindred",
    "Land",
    "Planeswalker",
    "Sorcery",
)


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
        page_size: int = 6,
        preview_min_confidence: float = 0.75,
        agentic_enabled: bool = False,
        tagger_catalog: SQLiteTaggerCatalog | None = None,
        edhrec_service: EdhrecCommanderService | None = None,
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
        self._tagger_catalog = tagger_catalog
        self._edhrec_service = edhrec_service

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
        tag_oracle_ids = await resolve_tag_filter_oracle_ids(
            self._tagger_catalog,
            query.filters,
        )
        filtered = [
            candidate
            for candidate in ranked
            if matches_card_filters(
                candidate.card,
                query.filters,
                tag_oracle_ids=tag_oracle_ids,
            )
        ]
        edhrec = EdhrecSearchEnhancement()
        edhrec_ranking: EdhrecCommanderRanking | None = None
        if query.enhance_with_edhrec and not query.q:
            if query.commander_oracle_id is None:
                edhrec = _edhrec_unavailable(
                    "Select one commander before enabling EDHREC enhancement."
                )
            elif self._edhrec_service is None:
                edhrec = _edhrec_unavailable(
                    "EDHREC enhancement is disabled. Results use normal local sorting."
                )
            else:
                try:
                    if query.edhrec_theme is None:
                        edhrec_ranking = await self._edhrec_service.ranking_for(
                            query.commander_oracle_id,
                        )
                    else:
                        edhrec_ranking = await self._edhrec_service.ranking_for(
                            query.commander_oracle_id,
                            query.edhrec_theme,
                        )
                except EdhrecCatalogUnavailable:
                    edhrec = _edhrec_unavailable(
                        "EDHREC data could not be fetched. Results use normal local sorting."
                    )
                else:
                    filtered = _rank_by_edhrec(filtered, edhrec_ranking)
                    edhrec = EdhrecSearchEnhancement(
                        status="applied",
                        source=edhrec_ranking.source,
                        message=None,
                    )
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
            self._agentic_enabled
            and bool(query.q)
            and query.page == 1
            and len(preview_candidates) < self._page_size
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
                    "edhrec": edhrec.model_dump(mode="json"),
                    "edhrec_known_card_count": (
                        len(edhrec_ranking.associations)
                        if edhrec_ranking is not None
                        else None
                    ),
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
                input_kind="card_title" if query.q else "filters",
                strategy="fuzzy",
                source="local_sqlite_catalog",
                top_score=filtered[0].score if filtered else None,
                page=query.page,
                page_start=page_start,
                page_end=page_end,
                preview_candidate_count=len(preview_candidates),
                preview_min_confidence=self._preview_min_confidence,
                agentic_search_required=agentic_required,
                edhrec=edhrec.model_dump(mode="json"),
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
                else (
                    "Titles ranked locally by fuzzy similarity"
                    if query.q
                    else (
                        "Cards matching the selected filters, ranked by EDHREC inclusion"
                        if edhrec.status == "applied"
                        else "Cards matching the selected filters"
                    )
                )
            ),
            reranked=edhrec.status == "applied",
            agentic_required=agentic_required,
            edhrec=edhrec,
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
    if not normalize_card_title(query):
        return [
            _RankedCard(
                card=entry.card,
                matched_alias=entry.aliases[0] if entry.aliases else entry.card.name.casefold(),
                score=0,
                preview_alias=entry.aliases[0] if entry.aliases else entry.card.name.casefold(),
                preview_confidence=0,
                original_rank=rank,
            )
            for rank, entry in enumerate(
                sorted(entries, key=lambda candidate: candidate.card.name.casefold()),
                start=1,
            )
        ]
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


def _rank_by_edhrec(
    candidates: list[_RankedCard],
    ranking: EdhrecCommanderRanking,
) -> list[_RankedCard]:
    """Put known EDHREC associations first without treating unknown as zero."""

    return sorted(
        candidates,
        key=lambda candidate: (
            0 if candidate.card.oracle_id in ranking.associations else 1,
            -(
                ranking.associations[candidate.card.oracle_id].inclusion
                if candidate.card.oracle_id in ranking.associations
                else 0
            ),
            -(
                ranking.associations[candidate.card.oracle_id].num_decks
                if candidate.card.oracle_id in ranking.associations
                else 0
            ),
            candidate.original_rank,
        ),
    )


def _edhrec_unavailable(message: str) -> EdhrecSearchEnhancement:
    return EdhrecSearchEnhancement(
        status="unavailable",
        source=None,
        message=message,
    )


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


async def resolve_tag_filter_oracle_ids(
    catalog: SQLiteTaggerCatalog | None,
    filters: CardSearchFilters,
) -> frozenset[UUID] | None:
    """Resolve immutable Tagger filters before scanning card candidates."""

    if not filters.tags:
        return None
    if catalog is None:
        raise CardSearchUnavailable("Tagger filtering is unavailable")
    try:
        return await asyncio.to_thread(
            catalog.oracle_ids_for_tags,
            [tag.id for tag in filters.tags],
        )
    except TaggerCatalogUnavailable as exc:
        raise CardSearchUnavailable("Tagger filtering is unavailable") from exc


def matches_card_filters(
    card: CardSearchResult,
    filters: CardSearchFilters,
    *,
    tag_oracle_ids: frozenset[UUID] | None = None,
) -> bool:
    """Apply immutable UI filters to a provider-neutral card."""

    selected_colors = set(filters.colors)
    identity = set(card.color_identity)

    if not filters.include_non_commander_legal and card.legalities.get("commander") != "legal":
        return False
    if (
        not filters.include_outside_commander_color_identity
        and filters.commander_color_identity is not None
        and not identity.issubset(set(filters.commander_color_identity))
    ):
        return False
    if filters.tags and (tag_oracle_ids is None or card.oracle_id not in tag_oracle_ids):
        return False
    card_types, subtypes = card_type_line_parts(card)
    if not {value.casefold() for value in filters.card_types}.issubset(card_types):
        return False
    if not {value.casefold() for value in filters.subtypes}.issubset(subtypes):
        return False

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


def card_type_line_parts(card: CardSearchResult) -> tuple[frozenset[str], frozenset[str]]:
    """Return normalized printed card types and subtypes across every card face."""

    face_type_lines = [face.type_line for face in card.card_faces if face.type_line is not None]
    type_lines = face_type_lines or [card.type_line]
    card_types: set[str] = set()
    subtypes: set[str] = set()
    known_card_types = {value.casefold() for value in CARD_TYPES}
    for type_line in type_lines:
        for face_line in type_line.split(" // "):
            left, separator, right = face_line.partition("—")
            card_types.update(
                token.casefold() for token in left.split() if token.casefold() in known_card_types
            )
            if separator:
                subtypes.update(token.casefold() for token in right.split())
    return frozenset(card_types), frozenset(subtypes)


def search_card_subtypes(
    entries: tuple[CatalogEntry, ...],
    query: str,
    *,
    limit: int = 12,
) -> list[CardSubtypeMatch]:
    """Fuzzy-rank the local catalog's distinct printed subtype vocabulary."""

    display_names: dict[str, str] = {}
    for entry in entries:
        face_type_lines = [
            face.type_line for face in entry.card.card_faces if face.type_line is not None
        ]
        for type_line in face_type_lines or [entry.card.type_line]:
            for face_line in type_line.split(" // "):
                _, separator, right = face_line.partition("—")
                if not separator:
                    continue
                for token in right.split():
                    display_names.setdefault(token.casefold(), token)

    ranked = sorted(
        (
            CardSubtypeMatch(
                name=display_name,
                match_score=name_similarity_score(query, display_name),
            )
            for display_name in display_names.values()
        ),
        key=lambda match: (-match.match_score, match.name.casefold()),
    )
    return ranked[:limit]
