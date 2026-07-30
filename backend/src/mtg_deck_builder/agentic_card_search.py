"""Progressive one-tool agentic card search."""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from dataclasses import dataclass, replace
from decimal import Decimal
from time import monotonic, perf_counter
from typing import Any
from uuid import UUID, uuid4

from pydantic import TypeAdapter, ValidationError

from mtg_deck_builder.agentic_search import (
    AgentSearchContractError,
    resolve_local_tool_limit,
    validate_final_ranking,
)
from mtg_deck_builder.agentic_search_debug import (
    AgentSearchTraceBuilder,
    JsonlAgentSearchTraceLogger,
)
from mtg_deck_builder.card_catalog import (
    CatalogEntry,
    SQLiteCardCatalog,
    card_title_aliases,
    normalize_card_title,
)
from mtg_deck_builder.config import AgenticSearchSettings
from mtg_deck_builder.domain import (
    AgenticCardSearchRequest,
    AgentRankedSearchOutput,
    AgentSearchCandidate,
    AgentSearchToolCall,
    AgentSearchTraceRecord,
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
    EdhrecSearchEnhancement,
    LocalCardSearchRequest,
    LocalCardSearchResult,
    SearchDebugStage,
    SearchDebugSummary,
)
from mtg_deck_builder.edhrec_catalog import (
    EdhrecAssociation,
    EdhrecCatalogUnavailable,
    EdhrecCommanderContext,
    EdhrecCommanderRanking,
    EdhrecCommanderService,
)
from mtg_deck_builder.providers import (
    CardSearchQueryError,
    CardSearchUnavailable,
    name_similarity_score,
)
from mtg_deck_builder.providers.openrouter import OpenRouterClient, OpenRouterError
from mtg_deck_builder.search import (
    FuzzyTitleSearchProvider,
    matches_card_filters,
    preview_confidence_score,
    resolve_tag_filter_oracle_ids,
)
from mtg_deck_builder.semantic_index import SemanticCardIndex, SemanticScoreResult
from mtg_deck_builder.tagger_catalog import SQLiteTaggerCatalog

_TOOL_CALL_ADAPTER = TypeAdapter(AgentSearchToolCall)
_NESTED_TOOL_FIELDS = frozenset(
    {
        "name",
        "mana",
        "types",
        "colors",
        "power",
        "toughness",
        "price_eur",
    }
)
_MAJOR_CARD_TYPES = frozenset(
    {
        "artifact",
        "battle",
        "creature",
        "enchantment",
        "instant",
        "kindred",
        "land",
        "planeswalker",
        "sorcery",
    }
)
_ABSTRACT_TYPE_ALTERNATIVES: dict[str, tuple[str, ...]] = {
    "permanent": (
        "Artifact",
        "Battle",
        "Creature",
        "Enchantment",
        "Land",
        "Planeswalker",
    ),
    "spell": (
        "Artifact",
        "Battle",
        "Creature",
        "Enchantment",
        "Instant",
        "Kindred",
        "Planeswalker",
        "Sorcery",
    ),
}


@dataclass(frozen=True)
class ExecutedSearchTool:
    """One bounded tool result ready to return to the final model call."""

    name: str
    arguments: dict[str, Any]
    candidates: tuple[AgentSearchCandidate, ...]
    payload: dict[str, Any]


@dataclass(frozen=True)
class _AgentCommanderContext:
    """Immutable commander context and optional EDHREC evidence for one round."""

    card: CardSearchResult
    edhrec_context: EdhrecCommanderContext | None
    edhrec_ranking: EdhrecCommanderRanking | None
    selected_theme_slug: str | None
    selected_theme_name: str | None
    enhancement: EdhrecSearchEnhancement


class AgenticCardSearchUnavailable(CardSearchUnavailable):
    """An agentic failure with an optional sanitized trace for debug clients."""

    def __init__(
        self,
        debug: SearchDebugSummary | None = None,
        *,
        contract_error: bool = False,
    ) -> None:
        super().__init__()
        self.debug = debug
        self.contract_error = contract_error


@dataclass(frozen=True)
class _StoredAgentSearch:
    session_id: UUID
    query: str
    filters: CardSearchFilters
    cards: tuple[CardSearchResult, ...]
    page_batches: dict[int, tuple[CardSearchResult, ...]]
    prefix_count: int
    name_match_scores: dict[UUID, float]
    title_confidence_scores: dict[UUID, float]
    interpretation: str
    warnings: tuple[str, ...]
    debug: SearchDebugSummary | None
    debug_runs: tuple[SearchDebugSummary, ...]
    debug_page: int
    considered_oracle_ids: frozenset[UUID]
    tool_request_history: tuple[dict[str, Any], ...]
    next_candidate_id: int
    round_number: int
    commander_oracle_id: UUID | None
    enhance_with_edhrec: bool
    edhrec_theme: str | None
    edhrec: EdhrecSearchEnhancement
    created_at: float


class AgenticSearchSessionStore:
    """Keep ranked cards and continuation state for one progressive search."""

    def __init__(self, *, ttl_seconds: float = 900) -> None:
        self._ttl_seconds = ttl_seconds
        self._sessions: dict[UUID, _StoredAgentSearch] = {}
        self._lock = asyncio.Lock()

    async def put(self, search: _StoredAgentSearch) -> None:
        async with self._lock:
            self._remove_expired()
            self._sessions[search.session_id] = search

    async def get(self, session_id: UUID) -> _StoredAgentSearch | None:
        async with self._lock:
            self._remove_expired()
            return self._sessions.get(session_id)

    def _remove_expired(self) -> None:
        cutoff = monotonic() - self._ttl_seconds
        expired = [
            session_id
            for session_id, search in self._sessions.items()
            if search.created_at < cutoff
        ]
        for session_id in expired:
            self._sessions.pop(session_id, None)


class LocalCardSearchTool:
    """Execute the agent's structured filters against the complete local catalog."""

    def __init__(
        self,
        catalog: SQLiteCardCatalog,
        *,
        default_max_results: int,
        hard_max_results: int,
        semantic_index: SemanticCardIndex | None = None,
        tagger_catalog: SQLiteTaggerCatalog | None = None,
    ) -> None:
        self._catalog = catalog
        self._default_max_results = default_max_results
        self._hard_max_results = hard_max_results
        self._semantic_index = semantic_index
        self._tagger_catalog = tagger_catalog

    async def search(
        self,
        request: LocalCardSearchRequest,
        *,
        immutable_filters: CardSearchFilters,
        excluded_oracle_ids: frozenset[UUID] = frozenset(),
        edhrec_ranking: EdhrecCommanderRanking | None = None,
    ) -> ExecutedSearchTool:
        limit = resolve_local_tool_limit(
            request,
            immutable_filters=immutable_filters,
            default_max_results=self._default_max_results,
            hard_max_results=self._hard_max_results,
        )
        if (
            request.sort_by in {"edhrec_inclusion", "edhrec_synergy"}
            and edhrec_ranking is None
        ):
            raise AgentSearchContractError(
                "EDHREC sorting requires available commander evidence"
            )

        entries = await self._catalog.entries()
        tag_oracle_ids = await resolve_tag_filter_oracle_ids(
            self._tagger_catalog,
            immutable_filters,
        )
        matches = await asyncio.to_thread(
            _filter_local_candidates,
            entries,
            request,
            immutable_filters,
            excluded_oracle_ids,
            tag_oracle_ids,
        )
        semantic_result: SemanticScoreResult | None = None
        if request.semantic_sort is not None:
            if self._semantic_index is None:
                raise CardSearchUnavailable("semantic index is unavailable")
            semantic_result = await self._semantic_index.score(
                request.semantic_sort,
                [candidate.card.oracle_id for _, candidate in matches],
            )
        result = _rank_local_candidates(
            matches,
            request=request,
            immutable_filters=immutable_filters,
            excluded_oracle_ids=excluded_oracle_ids,
            limit=limit,
            semantic_result=semantic_result,
            edhrec_ranking=edhrec_ranking,
        )
        return ExecutedSearchTool(
            name="search_local_cards",
            arguments=request.model_dump(mode="json", exclude_none=True),
            candidates=tuple(result.candidates),
            payload=result.model_dump(mode="json"),
        )

    async def cards_by_oracle_ids(
        self,
        oracle_ids: list[UUID],
    ) -> tuple[CardSearchResult, ...]:
        """Resolve canonical local cards in the order supplied by the client."""

        if not oracle_ids:
            return ()
        entries = await self._catalog.entries()
        cards_by_id = {entry.card.oracle_id: entry.card for entry in entries}
        try:
            return tuple(cards_by_id[oracle_id] for oracle_id in oracle_ids)
        except KeyError as exc:
            raise CardSearchQueryError from exc


class AgenticCardSearchService:
    """Coordinate fuzzy preview, one model-selected tool, and final ranking."""

    def __init__(
        self,
        *,
        fuzzy_provider: FuzzyTitleSearchProvider,
        local_tool: LocalCardSearchTool,
        model_client: OpenRouterClient | None,
        settings: AgenticSearchSettings,
        page_size: int,
        trace_logger: JsonlAgentSearchTraceLogger,
        trace_log_path: str,
        debug_default_enabled: bool,
        edhrec_service: EdhrecCommanderService | None = None,
        sessions: AgenticSearchSessionStore | None = None,
    ) -> None:
        self._fuzzy_provider = fuzzy_provider
        self._local_tool = local_tool
        self._model_client = model_client
        self._settings = settings
        self._page_size = page_size
        self._trace_logger = trace_logger
        self._trace_log_path = trace_log_path
        self._debug_default_enabled = debug_default_enabled
        self._edhrec_service = edhrec_service
        self._sessions = sessions or AgenticSearchSessionStore()
        self._session_locks: dict[UUID, asyncio.Lock] = {}

    async def search(self, request: AgenticCardSearchRequest) -> CardSearchPage:
        """Start, page, or continue one progressive agentic search session."""

        if request.search_session_id is not None:
            return await self._page_stored_search(request)

        if request.already_shown_oracle_ids:
            shown_cards = list(
                await self._local_tool.cards_by_oracle_ids(request.already_shown_oracle_ids)
            )
        else:
            preview = await self._fuzzy_provider.search(
                CardSearchQuery(
                    q=request.q,
                    filters=request.filters,
                    debug=False,
                )
            )
            shown_cards = preview.cards
        is_continuation = request.page != 1
        if is_continuation and not self._settings.continuation.enabled:
            raise CardSearchQueryError
        commander_context = await self._resolve_commander_context(request)
        selectable_preview = [] if is_continuation else shown_cards
        already_shown = shown_cards if is_continuation else []
        completed, debug = await self._execute_agent_round(
            request,
            selectable_preview=selectable_preview,
            already_shown=already_shown,
            excluded_oracle_ids=(
                frozenset(card.oracle_id for card in already_shown)
                if self._settings.continuation.exclude_already_shown
                else frozenset()
            ),
            candidate_id_start=(len(already_shown) + 1 if is_continuation else 1),
            round_number=1,
            previous_tool_requests=(),
            commander_context=commander_context,
        )
        session_id = uuid4()
        cards = _deduplicate_cards(completed.cards)
        title_scores = {card.scryfall_id: _card_title_scores(request.q, card) for card in cards}
        batches = _page_batches(
            cards,
            first_page=request.page,
            page_size=self._page_size,
        )
        stored = _StoredAgentSearch(
            session_id=session_id,
            query=request.q,
            filters=request.filters,
            cards=cards,
            page_batches=batches,
            prefix_count=len(already_shown),
            name_match_scores={
                card.scryfall_id: title_scores[card.scryfall_id][0] for card in cards
            },
            title_confidence_scores={
                card.scryfall_id: title_scores[card.scryfall_id][1] for card in cards
            },
            interpretation=completed.output.interpretation,
            warnings=(
                ("No additional matches found in this pass.",)
                if is_continuation and not cards
                else ()
            ),
            debug=debug,
            debug_runs=(debug,) if debug is not None else (),
            debug_page=request.page,
            considered_oracle_ids=frozenset(
                candidate.card.oracle_id for candidate in completed.tool.candidates
            ),
            tool_request_history=(completed.tool.arguments,),
            next_candidate_id=completed.next_candidate_id,
            round_number=1,
            commander_oracle_id=request.commander_oracle_id,
            enhance_with_edhrec=request.enhance_with_edhrec,
            edhrec_theme=request.edhrec_theme,
            edhrec=(
                commander_context.enhancement
                if commander_context is not None
                else EdhrecSearchEnhancement()
            ),
            created_at=monotonic(),
        )
        await self._sessions.put(stored)
        return _page_from_stored(stored, page=request.page)

    async def _resolve_commander_context(
        self,
        request: AgenticCardSearchRequest,
    ) -> _AgentCommanderContext | None:
        """Resolve commander details and degrade cleanly when EDHREC is unavailable."""

        if request.commander_oracle_id is None:
            return None
        cards = await self._local_tool.cards_by_oracle_ids([request.commander_oracle_id])
        commander = cards[0]
        if not request.enhance_with_edhrec:
            return _AgentCommanderContext(
                card=commander,
                edhrec_context=None,
                edhrec_ranking=None,
                selected_theme_slug=None,
                selected_theme_name=None,
                enhancement=EdhrecSearchEnhancement(),
            )
        if self._edhrec_service is None:
            return _AgentCommanderContext(
                card=commander,
                edhrec_context=None,
                edhrec_ranking=None,
                selected_theme_slug=request.edhrec_theme,
                selected_theme_name=None,
                enhancement=EdhrecSearchEnhancement(
                    status="unavailable",
                    message=(
                        "EDHREC commander data is unavailable. "
                        "Agentic search used local and semantic evidence only."
                    ),
                ),
            )
        try:
            context = await self._edhrec_service.context_for(request.commander_oracle_id)
            selected_theme = next(
                (
                    theme
                    for theme in context.themes
                    if theme.slug == request.edhrec_theme
                ),
                None,
            )
            if request.edhrec_theme is not None and selected_theme is None:
                raise CardSearchQueryError
            ranking = await self._edhrec_service.ranking_for(
                request.commander_oracle_id,
                request.edhrec_theme,
            )
        except CardSearchQueryError:
            raise
        except EdhrecCatalogUnavailable:
            return _AgentCommanderContext(
                card=commander,
                edhrec_context=None,
                edhrec_ranking=None,
                selected_theme_slug=request.edhrec_theme,
                selected_theme_name=None,
                enhancement=EdhrecSearchEnhancement(
                    status="unavailable",
                    message=(
                        "EDHREC commander data could not be fetched. "
                        "Agentic search used local and semantic evidence only."
                    ),
                ),
            )
        return _AgentCommanderContext(
            card=commander,
            edhrec_context=context,
            edhrec_ranking=ranking,
            selected_theme_slug=request.edhrec_theme,
            selected_theme_name=(
                selected_theme.name if selected_theme is not None else None
            ),
            enhancement=EdhrecSearchEnhancement(
                status="applied",
                source=ranking.source,
            ),
        )

    async def _execute_agent_round(
        self,
        request: AgenticCardSearchRequest,
        *,
        selectable_preview: list[CardSearchResult],
        already_shown: list[CardSearchResult],
        excluded_oracle_ids: frozenset[UUID],
        candidate_id_start: int,
        round_number: int,
        previous_tool_requests: tuple[dict[str, Any], ...],
        commander_context: _AgentCommanderContext | None,
    ) -> tuple[_CompletedAgentRun, SearchDebugSummary | None]:
        trace_enabled = self._debug_default_enabled or request.debug
        trace = AgentSearchTraceBuilder(
            {
                "query": request.q,
                "filters": request.filters.model_dump(mode="json"),
                "debug": request.debug,
                "round_number": round_number,
                "previous_tool_requests": list(previous_tool_requests),
                "commander_context": _commander_trace_payload(commander_context),
                "preview_candidates": [
                    _numbered_candidate_payload(
                        candidate_id,
                        card,
                        already_shown=True,
                    )
                    for candidate_id, card in enumerate(
                        [*already_shown, *selectable_preview],
                        start=1,
                    )
                ],
            }
        )
        try:
            completed = await self._run_agent(
                request,
                selectable_preview=selectable_preview,
                already_shown=already_shown,
                excluded_oracle_ids=excluded_oracle_ids,
                candidate_id_start=candidate_id_start,
                round_number=round_number,
                previous_tool_requests=previous_tool_requests,
                commander_context=commander_context,
                trace=trace,
            )
        except asyncio.CancelledError as exc:
            await self._persist_failed_trace(trace, exc, trace_enabled)
            raise
        except Exception as exc:
            debug = await self._persist_failed_trace(trace, exc, trace_enabled)
            if isinstance(exc, CardSearchQueryError):
                raise
            raise AgenticCardSearchUnavailable(
                debug,
                contract_error=isinstance(exc, AgentSearchContractError),
            ) from exc

        trace_record = trace.finish()
        log_written = False
        if trace_enabled:
            try:
                await self._trace_logger.write(trace_record)
                log_written = True
            except OSError:
                log_written = False
        debug = (
            _to_search_debug_summary(
                trace_record,
                log_path=self._trace_log_path,
                log_written=log_written,
                selected_tool=completed.tool.name,
                result_cards=completed.cards,
                interpretation=completed.output.interpretation,
            )
            if trace_enabled
            else None
        )
        return completed, debug

    async def _run_agent(
        self,
        request: AgenticCardSearchRequest,
        *,
        selectable_preview: list[CardSearchResult],
        already_shown: list[CardSearchResult],
        excluded_oracle_ids: frozenset[UUID],
        candidate_id_start: int,
        round_number: int,
        previous_tool_requests: tuple[dict[str, Any], ...],
        commander_context: _AgentCommanderContext | None,
        trace: AgentSearchTraceBuilder,
    ) -> _CompletedAgentRun:
        tools = _tool_definitions()
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": self._settings.system_prompt,
            },
            {
                "role": "user",
                "content": _render_agent_user_message(
                    request,
                    selectable_preview=selectable_preview,
                    already_shown=already_shown,
                    round_number=round_number,
                    previous_tool_requests=previous_tool_requests,
                    include_full_card_details=(
                        self._settings.continuation.include_full_card_details_in_prompt
                    ),
                    commander_context=commander_context,
                ),
            },
        ]
        initial_payload = {
            "model": self._settings.model,
            "messages": messages,
            "tools": tools,
            "tool_choice": "required",
            "temperature": 0,
            "reasoning": {"effort": "minimal", "exclude": False},
            "provider": {"require_parameters": True},
        }
        trace.add_stage("initial_model_request", initial_payload)
        if not self._settings.enabled or self._model_client is None:
            raise CardSearchUnavailable
        started = perf_counter()
        initial_response = await self._model_client.chat_completion(initial_payload)
        trace.add_stage(
            "initial_model_response",
            initial_response,
            duration_ms=_elapsed_ms(started),
        )
        assistant_message = _extract_message(initial_response)
        call_id, tool_call, raw_arguments, normalizations = _parse_single_tool_call(
            assistant_message
        )
        if tool_call.arguments.semantic_sort is None:
            tool_call = tool_call.model_copy(
                update={
                    "arguments": tool_call.arguments.model_copy(update={"semantic_sort": request.q})
                }
            )
            normalizations.append("semantic_sort defaulted to the user's request")
        trace.add_stage(
            "tool_call",
            {
                "tool_call_id": call_id,
                "name": tool_call.name,
                "raw_arguments": raw_arguments,
                "arguments": tool_call.arguments.model_dump(
                    mode="json",
                    exclude_none=True,
                ),
                "provider_boundary_normalizations": normalizations,
            },
        )

        started = perf_counter()
        if commander_context is not None and commander_context.edhrec_ranking is not None:
            executed = await self._local_tool.search(
                tool_call.arguments,
                immutable_filters=request.filters,
                excluded_oracle_ids=excluded_oracle_ids,
                edhrec_ranking=commander_context.edhrec_ranking,
            )
        else:
            executed = await self._local_tool.search(
                tool_call.arguments,
                immutable_filters=request.filters,
                excluded_oracle_ids=excluded_oracle_ids,
            )
        tool_duration_ms = _elapsed_ms(started)

        union = _candidate_union(selectable_preview, executed.candidates)
        preview_oracle_ids = {card.oracle_id for card in selectable_preview}
        semantic_scores = {
            candidate.card.oracle_id: candidate.semantic_score for candidate in executed.candidates
        }
        tool_candidates_by_oracle_id = {
            candidate.card.oracle_id: candidate for candidate in executed.candidates
        }
        numbered_cards = list(
            enumerate(
                union,
                start=candidate_id_start,
            )
        )
        numbered_candidates = [
            _numbered_candidate_payload(
                candidate_id,
                card,
                already_shown=card.oracle_id in preview_oracle_ids,
                semantic_score=semantic_scores.get(card.oracle_id),
                edhrec_association=(
                    (
                        commander_context.edhrec_ranking.associations.get(card.oracle_id)
                        if commander_context is not None
                        and commander_context.edhrec_ranking is not None
                        else None
                    )
                    or _candidate_edhrec_association(
                        tool_candidates_by_oracle_id.get(card.oracle_id)
                    )
                ),
            )
            for candidate_id, card in numbered_cards
        ]
        tool_message_content = _render_tool_result_message(
            executed,
            numbered_candidates,
        )
        trace.add_stage(
            "tool_result",
            {
                "tool": executed.name,
                "raw_tool_result": executed.payload,
                "message_to_agent": tool_message_content,
                "numbered_candidates": numbered_candidates,
            },
            duration_ms=tool_duration_ms,
        )
        final_messages = [
            *messages,
            _assistant_tool_call_message(assistant_message),
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": tool_message_content,
            },
        ]
        final_payload = {
            "model": self._settings.model,
            "messages": final_messages,
            "temperature": 0,
            "reasoning": {"effort": "minimal", "exclude": False},
            "provider": {"require_parameters": True},
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "ranked_card_search",
                    "strict": True,
                    "schema": AgentRankedSearchOutput.model_json_schema(),
                },
            },
        }
        trace.add_stage("final_model_request", final_payload)
        started = perf_counter()
        final_response = await self._model_client.chat_completion(final_payload)
        trace.add_stage(
            "final_model_response",
            final_response,
            duration_ms=_elapsed_ms(started),
        )
        output = _parse_final_output(final_response)
        candidates_by_id = dict(numbered_cards)
        candidate_ids = tuple(candidates_by_id)
        ranked_ids = validate_final_ranking(
            output,
            candidate_ids=candidate_ids,
            max_candidate_count=self._page_size + self._settings.max_tool_results,
        )
        ranked_cards = tuple(candidates_by_id[candidate_id] for candidate_id in ranked_ids)
        omitted_ids = sorted(set(candidate_ids) - set(ranked_ids))
        trace.add_stage(
            "validation",
            {
                "status": "accepted",
                "candidate_count": len(union),
                "ranked_ids": list(ranked_ids),
                "omitted_ids": omitted_ids,
                "ranked_ids_valid": True,
                "invented_ids": [],
            },
        )
        return _CompletedAgentRun(
            output=output,
            tool=executed,
            cards=ranked_cards,
            next_candidate_id=candidate_id_start + len(union),
        )

    async def _page_stored_search(
        self,
        request: AgenticCardSearchRequest,
    ) -> CardSearchPage:
        assert request.search_session_id is not None
        lock = self._session_locks.setdefault(
            request.search_session_id,
            asyncio.Lock(),
        )
        async with lock:
            return await self._page_stored_search_locked(request)

    async def _page_stored_search_locked(
        self,
        request: AgenticCardSearchRequest,
    ) -> CardSearchPage:
        assert request.search_session_id is not None
        stored = await self._sessions.get(request.search_session_id)
        if (
            stored is None
            or stored.query != request.q
            or stored.filters != request.filters
            or stored.commander_oracle_id != request.commander_oracle_id
            or stored.enhance_with_edhrec != request.enhance_with_edhrec
            or stored.edhrec_theme != request.edhrec_theme
        ):
            raise CardSearchQueryError
        if request.page in stored.page_batches:
            return _page_from_stored(stored, page=request.page)
        if request.page != max(stored.page_batches) + 1:
            raise CardSearchQueryError
        continuation = self._settings.continuation
        if not continuation.enabled:
            raise CardSearchQueryError
        if continuation.max_rounds is not None and stored.round_number >= continuation.max_rounds:
            raise CardSearchQueryError

        already_shown = list(
            await self._local_tool.cards_by_oracle_ids(request.already_shown_oracle_ids)
        )
        commander_context = await self._resolve_commander_context(request)
        completed, debug = await self._execute_agent_round(
            request,
            selectable_preview=[],
            already_shown=already_shown,
            excluded_oracle_ids=(
                (
                    stored.considered_oracle_ids
                    if continuation.exclude_previously_considered
                    else frozenset()
                )
                | (
                    frozenset(card.oracle_id for card in already_shown)
                    if continuation.exclude_already_shown
                    else frozenset()
                )
            ),
            candidate_id_start=stored.next_candidate_id,
            round_number=stored.round_number + 1,
            previous_tool_requests=stored.tool_request_history,
            commander_context=commander_context,
        )
        existing_ids = {
            *(card.oracle_id for card in already_shown),
            *(card.oracle_id for card in stored.cards),
        }
        new_cards = tuple(
            card
            for card in _deduplicate_cards(completed.cards)
            if card.oracle_id not in existing_ids
        )
        new_batches = _page_batches(
            new_cards,
            first_page=request.page,
            page_size=self._page_size,
        )
        new_scores = {card.scryfall_id: _card_title_scores(request.q, card) for card in new_cards}
        updated = replace(
            stored,
            cards=(*stored.cards, *new_cards),
            page_batches={**stored.page_batches, **new_batches},
            name_match_scores={
                **stored.name_match_scores,
                **{card.scryfall_id: new_scores[card.scryfall_id][0] for card in new_cards},
            },
            title_confidence_scores={
                **stored.title_confidence_scores,
                **{card.scryfall_id: new_scores[card.scryfall_id][1] for card in new_cards},
            },
            interpretation=completed.output.interpretation,
            warnings=(("No additional matches found in this pass.",) if not new_cards else ()),
            debug=debug,
            debug_runs=(
                *stored.debug_runs,
                *((debug,) if debug is not None else ()),
            ),
            debug_page=request.page,
            considered_oracle_ids=(
                stored.considered_oracle_ids
                | frozenset(candidate.card.oracle_id for candidate in completed.tool.candidates)
            ),
            tool_request_history=(
                *stored.tool_request_history,
                completed.tool.arguments,
            ),
            next_candidate_id=completed.next_candidate_id,
            round_number=stored.round_number + 1,
            edhrec=(
                commander_context.enhancement
                if commander_context is not None
                else EdhrecSearchEnhancement()
            ),
            created_at=monotonic(),
        )
        await self._sessions.put(updated)
        return _page_from_stored(updated, page=request.page)

    async def _persist_failed_trace(
        self,
        trace: AgentSearchTraceBuilder,
        error: BaseException,
        trace_enabled: bool,
    ) -> SearchDebugSummary | None:
        if not trace_enabled:
            return None
        error_payload: dict[str, Any] = {"error_type": type(error).__name__}
        if isinstance(error, OpenRouterError):
            error_payload.update(
                {
                    "status_code": error.status_code,
                    "provider_response": error.response_body,
                }
            )
        record = trace.finish(
            status="cancelled" if isinstance(error, asyncio.CancelledError) else "error",
            error=error_payload,
        )
        log_written = False
        try:
            await self._trace_logger.write(record)
            log_written = True
        except OSError:
            pass
        return _to_failed_search_debug_summary(
            record,
            log_path=self._trace_log_path,
            log_written=log_written,
        )


@dataclass(frozen=True)
class _CompletedAgentRun:
    output: AgentRankedSearchOutput
    tool: ExecutedSearchTool
    cards: tuple[CardSearchResult, ...]
    next_candidate_id: int


def _filter_local_candidates(
    entries: tuple[CatalogEntry, ...],
    request: LocalCardSearchRequest,
    immutable_filters: CardSearchFilters,
    excluded_oracle_ids: frozenset[UUID] = frozenset(),
    tag_oracle_ids: frozenset[UUID] | None = None,
) -> list[tuple[float, AgentSearchCandidate]]:
    matches: list[tuple[float, AgentSearchCandidate]] = []
    for entry in entries:
        card = entry.card
        if card.oracle_id in excluded_oracle_ids:
            continue
        if not matches_card_filters(
            card,
            immutable_filters,
            tag_oracle_ids=tag_oracle_ids,
        ):
            continue
        evidence: list[str] = []
        decisions: dict[str, bool] = {"immutable_ui_filters": True}
        if request.name is not None and request.name.query:
            normalized_query = normalize_card_title(request.name.query)
            if not normalized_query or not any(
                normalized_query in alias for alias in entry.aliases
            ):
                continue
            name_score = name_similarity_score(request.name.query, card.name)
            decisions["name"] = True
            evidence.append(f"name contains query; similarity {name_score:.3f}")
        else:
            name_score = 0
        if request.mana is not None:
            if (
                request.mana.value_minimum is not None
                and card.mana_value < request.mana.value_minimum
            ):
                continue
            if (
                request.mana.value_maximum is not None
                and card.mana_value > request.mana.value_maximum
            ):
                continue
            if not _matches_text_conditions(_card_mana_cost(card), request.mana):
                continue
            decisions["mana"] = True
            evidence.append("mana conditions matched")
        if request.types is not None:
            if not _matches_text_conditions(_card_type_line(card), request.types):
                continue
            decisions["types"] = True
            evidence.append("type conditions matched")
        if request.colors is not None:
            if not _matches_agent_colors(card, request.colors):
                continue
            decisions["colors"] = True
            evidence.append("color identity matched")
        if request.power is not None:
            if not _matches_numeric_characteristic(card, "power", request.power):
                continue
            decisions["power"] = True
            evidence.append("power range matched")
        if request.toughness is not None:
            if not _matches_numeric_characteristic(card, "toughness", request.toughness):
                continue
            decisions["toughness"] = True
            evidence.append("toughness range matched")
        if request.price_eur is not None:
            eur = card.prices.eur
            if not _decimal_in_range(
                eur,
                request.price_eur.minimum,
                request.price_eur.maximum,
            ):
                continue
            decisions["price_eur"] = True
            evidence.append("EUR price matched")
        if request.sets is not None and card.set_code.casefold() not in {
            value.casefold() for value in request.sets
        }:
            continue
        if request.rarities is not None and card.rarity.casefold() not in {
            value.casefold() for value in request.rarities
        }:
            continue
        matches.append(
            (
                name_score,
                AgentSearchCandidate(
                    card=card,
                    exact_match_evidence=evidence,
                    filter_decisions=decisions,
                ),
            )
        )
    return matches


def _rank_local_candidates(
    matches: list[tuple[float, AgentSearchCandidate]],
    *,
    request: LocalCardSearchRequest,
    immutable_filters: CardSearchFilters,
    excluded_oracle_ids: frozenset[UUID],
    limit: int,
    semantic_result: SemanticScoreResult | None,
    edhrec_ranking: EdhrecCommanderRanking | None,
) -> LocalCardSearchResult:
    sort_by = request.sort_by or "semantic"
    ranked: list[tuple[tuple[float, ...], AgentSearchCandidate]] = []
    for name_score, candidate in matches:
        semantic_score = (
            semantic_result.scores[candidate.card.oracle_id]
            if semantic_result is not None
            else None
        )
        if semantic_score is not None:
            candidate = candidate.model_copy(
                update={
                    "semantic_score": semantic_score,
                    "exact_match_evidence": [
                        *candidate.exact_match_evidence,
                        f"semantic sort score {semantic_score:.3f}",
                    ],
                }
            )
        association = (
            edhrec_ranking.associations.get(candidate.card.oracle_id)
            if edhrec_ranking is not None
            else None
        )
        if association is not None:
            candidate = candidate.model_copy(
                update={
                    "edhrec_inclusion": association.inclusion,
                    "edhrec_synergy": association.synergy,
                    "edhrec_num_decks": association.num_decks,
                    "edhrec_potential_decks": association.potential_decks,
                    "exact_match_evidence": [
                        *candidate.exact_match_evidence,
                        (
                            "EDHREC commander inclusion "
                            f"{association.inclusion:.3f}"
                        ),
                        *(
                            [f"EDHREC commander synergy {association.synergy:.3f}"]
                            if association.synergy is not None
                            else []
                        ),
                    ],
                }
            )
        if sort_by == "edhrec_inclusion":
            primary = (
                1 if association is not None else 0,
                association.inclusion if association is not None else 0,
                semantic_score or 0,
                name_score,
            )
        elif sort_by == "edhrec_synergy":
            primary = (
                1 if association is not None and association.synergy is not None else 0,
                (
                    association.synergy
                    if association is not None and association.synergy is not None
                    else 0
                ),
                semantic_score or 0,
                name_score,
            )
        else:
            primary = (
                semantic_score or 0,
                name_score,
            )
        ranked.append((primary, candidate))
    ranked.sort(
        key=lambda item: (
            *(-value for value in item[0]),
            item[1].card.name.casefold(),
        )
    )
    candidates = [candidate for _, candidate in ranked[:limit]]
    return LocalCardSearchResult(
        request=request,
        total_candidates=len(ranked),
        candidates=candidates,
        compiled_query={
            "engine": "local_sqlite_catalog",
            "semantic_sort": (
                {
                    "mode": "cosine",
                    "model": semantic_result.model,
                    "dimensions": semantic_result.dimensions,
                    "query": request.semantic_sort,
                    "score_scale": "normalized_cosine_0_to_1",
                    "minimum_score": None,
                    "scored_candidates": len(ranked),
                }
                if semantic_result is not None
                else {
                    "mode": "not_requested",
                    "minimum_score": None,
                }
            ),
            "primary_sort": sort_by,
            "edhrec": {
                "mode": (
                    "commander_theme"
                    if edhrec_ranking is not None
                    else "not_available"
                ),
                "known_card_count": (
                    len(edhrec_ranking.associations)
                    if edhrec_ranking is not None
                    else 0
                ),
                "minimum_inclusion": None,
                "minimum_synergy": None,
            },
            "immutable_filters": immutable_filters.model_dump(mode="json"),
            "excluded_oracle_card_count": len(excluded_oracle_ids),
            "result_limit": limit,
        },
    )


def _matches_text_conditions(value: str, conditions: Any) -> bool:
    haystack = value.casefold()
    required = Counter(item.casefold() for item in conditions.must_contain_all)
    if any(haystack.count(needle) < count for needle, count in required.items()):
        return False
    if conditions.must_contain_any and not any(
        needle.casefold() in haystack for needle in conditions.must_contain_any
    ):
        return False
    return not any(needle.casefold() in haystack for needle in conditions.must_not_contain)


def _card_oracle_text(card: CardSearchResult) -> str:
    return "\n".join(
        filter(
            None,
            [
                card.oracle_text,
                *(face.oracle_text for face in card.card_faces),
            ],
        )
    )


def _card_mana_cost(card: CardSearchResult) -> str:
    return " // ".join(
        filter(None, [card.mana_cost, *(face.mana_cost for face in card.card_faces)])
    )


def _card_type_line(card: CardSearchResult) -> str:
    return " // ".join(
        filter(None, [card.type_line, *(face.type_line for face in card.card_faces)])
    )


def _card_power_toughness(card: CardSearchResult) -> str:
    if card.card_faces:
        pairs = [
            f"{face.power or '?'}/{face.toughness or '?'}"
            for face in card.card_faces
            if face.power is not None or face.toughness is not None
        ]
    else:
        pairs = (
            [f"{card.power or '?'}/{card.toughness or '?'}"]
            if card.power is not None or card.toughness is not None
            else []
        )
    return " // ".join(pairs)


def _card_price_eur(card: CardSearchResult) -> str:
    return f"€{card.prices.eur}" if card.prices.eur is not None else "unavailable"


def _matches_agent_colors(card: CardSearchResult, search: Any) -> bool:
    selected = set(search.identity or [])
    identity = set(card.color_identity)
    if not selected:
        return search.include_colorless and not identity
    if not identity:
        return search.include_colorless
    return identity == selected if search.mode == "exact" else identity.issubset(selected)


def _matches_numeric_characteristic(
    card: CardSearchResult,
    field: str,
    search: Any,
) -> bool:
    raw_values = [
        getattr(card, field),
        *(getattr(face, field) for face in card.card_faces),
    ]
    values: list[float] = []
    for raw_value in raw_values:
        if raw_value is None:
            continue
        try:
            values.append(float(raw_value))
        except ValueError:
            continue
    return any(
        (search.minimum is None or value >= search.minimum)
        and (search.maximum is None or value <= search.maximum)
        for value in values
    )


def _decimal_in_range(
    value: Decimal | None,
    minimum: Decimal | None,
    maximum: Decimal | None,
) -> bool:
    if value is None:
        return minimum is None and maximum is None
    return not (
        (minimum is not None and value < minimum) or (maximum is not None and value > maximum)
    )


def _tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "search_local_cards",
                # One line only. All search logic lives in the system prompt, so
                # that this description can never contradict it.
                "description": (
                    "Filter and sort the complete local Magic card catalog."
                ),
                "parameters": LocalCardSearchRequest.model_json_schema(),
                "strict": True,
            },
        },
    ]


def _extract_message(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        raise AgentSearchContractError("model response must contain exactly one choice")
    choice = choices[0]
    if not isinstance(choice, dict) or not isinstance(choice.get("message"), dict):
        raise AgentSearchContractError("model response did not contain a message")
    return choice["message"]


def _parse_single_tool_call(
    message: dict[str, Any],
) -> tuple[str, AgentSearchToolCall, dict[str, Any], list[str]]:
    tool_calls = message.get("tool_calls")
    if not isinstance(tool_calls, list) or len(tool_calls) != 1:
        raise AgentSearchContractError("the agent must make exactly one tool call")
    raw_call = tool_calls[0]
    if not isinstance(raw_call, dict) or not isinstance(raw_call.get("function"), dict):
        raise AgentSearchContractError("the agent returned an invalid tool call")
    call_id = raw_call.get("id")
    function = raw_call["function"]
    raw_arguments = function.get("arguments")
    if not isinstance(call_id, str) or not isinstance(raw_arguments, str):
        raise AgentSearchContractError("the agent returned incomplete tool-call data")
    try:
        arguments = json.loads(raw_arguments)
        if not isinstance(arguments, dict):
            raise AgentSearchContractError("the agent returned non-object tool arguments")
        normalized_arguments, normalizations = _normalize_tool_arguments(
            function.get("name"),
            arguments,
        )
        tool_call = _TOOL_CALL_ADAPTER.validate_python(
            {
                "name": function.get("name"),
                "arguments": normalized_arguments,
            }
        )
    except (json.JSONDecodeError, ValidationError) as exc:
        raise AgentSearchContractError("the agent returned invalid tool arguments") from exc
    return call_id, tool_call, arguments, normalizations


def _normalize_tool_arguments(
    tool_name: object,
    arguments: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """Normalize obvious provider shorthands before strict domain validation."""

    if tool_name != "search_local_cards":
        return arguments, []
    normalized = dict(arguments)
    changes: list[str] = []

    for key, value in tuple(normalized.items()):
        if key != "semantic_sort" and isinstance(value, str) and value.strip() in {"...", "…"}:
            normalized.pop(key)
            changes.append(f"omitted placeholder {key}")

    for key in ("format", "legality"):
        if key in normalized:
            normalized.pop(key)
            changes.append(f"removed runtime-owned {key} filter")

    for key in _NESTED_TOOL_FIELDS:
        value = normalized.get(key)
        if not isinstance(value, str):
            continue
        stripped = value.strip()
        if not (stripped.startswith("{") and stripped.endswith("}")):
            continue
        try:
            decoded = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if isinstance(decoded, dict):
            normalized[key] = decoded
            changes.append(f"decoded JSON object string for {key}")

    name = normalized.get("name")
    if isinstance(name, str):
        normalized["name"] = {"query": name}
        changes.append("name string -> name.query")

    mana = normalized.get("mana")
    if isinstance(mana, str):
        normalized["mana"] = {"must_contain_all": [mana]}
        changes.append("mana string -> mana.must_contain_all")
    elif isinstance(mana, list) and mana and all(isinstance(item, str) for item in mana):
        normalized["mana"] = {"must_contain_all": mana}
        changes.append("mana list -> mana.must_contain_all")

    types = normalized.get("types")
    normalized_types, type_changes = _normalize_type_search(types)
    if normalized_types is not types:
        normalized["types"] = normalized_types
    changes.extend(type_changes)

    colors = normalized.get("colors")
    if isinstance(colors, str):
        normalized["colors"] = _normalize_color_search([colors])
        changes.append("colors string -> colors.identity")
    elif isinstance(colors, list) and all(isinstance(item, str) for item in colors):
        normalized["colors"] = _normalize_color_search(colors)
        changes.append("colors list -> colors.identity")
    elif isinstance(colors, dict):
        identity = colors.get("identity")
        if isinstance(identity, str):
            normalized["colors"] = {
                **colors,
                **_normalize_color_search([identity]),
            }
            changes.append("colors.identity string -> colors.identity list")
        elif isinstance(identity, list) and all(isinstance(item, str) for item in identity):
            normalized["colors"] = {
                **colors,
                **_normalize_color_search(identity),
            }

    for key in ("power", "toughness"):
        value = normalized.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            normalized[key] = {"minimum": value}
            changes.append(f"{key} number -> {key}.minimum")
        elif isinstance(value, str):
            try:
                minimum = float(value)
            except ValueError:
                continue
            normalized[key] = {"minimum": minimum}
            changes.append(f"{key} numeric string -> {key}.minimum")

    for key in ("sets", "rarities"):
        value = normalized.get(key)
        if isinstance(value, str):
            normalized[key] = [value]
            changes.append(f"{key} string -> {key} list")

    return normalized, changes


def _normalize_type_search(value: object) -> tuple[object, list[str]]:
    """Repair common type-filter shorthands without preserving impossible literals."""

    if isinstance(value, str):
        stripped = value.strip()
        abstract_alternatives = _ABSTRACT_TYPE_ALTERNATIVES.get(stripped.casefold())
        if abstract_alternatives is not None:
            return (
                {"must_contain_any": list(abstract_alternatives)},
                [f"abstract type {stripped} -> types.must_contain_any"],
            )
        alternatives = _comma_separated_major_types(stripped)
        if alternatives is not None:
            return (
                {"must_contain_any": alternatives},
                ["comma-separated types string -> types.must_contain_any"],
            )
        return {"must_contain_all": [stripped]}, ["types string -> types.must_contain_all"]

    if isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        return {"must_contain_all": value}, ["types list -> types.must_contain_all"]

    if not isinstance(value, dict):
        return value, []

    required = value.get("must_contain_all")
    if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
        return value, []

    rewritten_required: list[str] = []
    added_alternatives: list[str] = []
    changed = False
    for item in required:
        stripped = item.strip()
        abstract_alternatives = _ABSTRACT_TYPE_ALTERNATIVES.get(stripped.casefold())
        if abstract_alternatives is not None:
            added_alternatives.extend(abstract_alternatives)
            changed = True
            continue
        comma_separated = _comma_separated_major_types(stripped)
        if comma_separated is not None:
            if len(comma_separated) >= 3:
                added_alternatives.extend(comma_separated)
            else:
                rewritten_required.extend(comma_separated)
            changed = True
            continue
        rewritten_required.append(stripped)

    if not changed:
        return value, []

    rewritten = dict(value)
    rewritten["must_contain_all"] = rewritten_required
    if added_alternatives:
        existing_alternatives = rewritten.get("must_contain_any")
        combined = (
            list(existing_alternatives)
            if isinstance(existing_alternatives, list)
            and all(isinstance(item, str) for item in existing_alternatives)
            else []
        )
        for alternative in added_alternatives:
            if alternative not in combined:
                combined.append(alternative)
        rewritten["must_contain_any"] = combined
    return rewritten, ["repaired non-literal or comma-joined type conditions"]


def _comma_separated_major_types(value: str) -> list[str] | None:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) < 2 or any(not part for part in parts):
        return None
    if not all(part.casefold() in _MAJOR_CARD_TYPES for part in parts):
        return None
    return parts


def _normalize_magic_color(value: str) -> str:
    aliases = {
        "white": "W",
        "blue": "U",
        "black": "B",
        "red": "R",
        "green": "G",
    }
    return aliases.get(value.strip().casefold(), value.strip().upper())


def _normalize_color_search(values: list[str]) -> dict[str, Any]:
    identity: list[str] = []
    include_colorless = False
    for value in values:
        stripped = value.strip()
        if stripped.casefold() in {"c", "colorless"}:
            include_colorless = True
            continue
        compact = "".join(
            character
            for character in stripped.upper()
            if character not in {" ", ",", "/", "-", "+"}
        )
        normalized_values = (
            list(compact)
            if compact and all(character in "WUBRG" for character in compact)
            else [_normalize_magic_color(stripped)]
        )
        for color in normalized_values:
            if color not in identity:
                identity.append(color)
    result: dict[str, Any] = {"identity": identity}
    if include_colorless:
        result["include_colorless"] = True
    return result


def _assistant_tool_call_message(message: dict[str, Any]) -> dict[str, Any]:
    preserved = {
        "role": "assistant",
        "content": message.get("content"),
        "tool_calls": message.get("tool_calls"),
    }
    if "reasoning_details" in message:
        preserved["reasoning_details"] = message["reasoning_details"]
    return preserved


def _parse_final_output(response: dict[str, Any]) -> AgentRankedSearchOutput:
    message = _extract_message(response)
    content = message.get("content")
    if not isinstance(content, str):
        raise AgentSearchContractError("the final model response was not JSON text")
    try:
        return AgentRankedSearchOutput.model_validate_json(content)
    except ValidationError as exc:
        raise AgentSearchContractError(
            "the final model response failed structured validation"
        ) from exc


def _candidate_union(
    preview_cards: list[CardSearchResult],
    tool_candidates: tuple[AgentSearchCandidate, ...],
) -> tuple[CardSearchResult, ...]:
    cards: list[CardSearchResult] = []
    seen_oracle_ids: set[UUID] = set()
    for card in [*preview_cards, *(candidate.card for candidate in tool_candidates)]:
        if card.oracle_id in seen_oracle_ids:
            continue
        seen_oracle_ids.add(card.oracle_id)
        cards.append(card)
    return tuple(cards)


def _numbered_candidate_payload(
    candidate_id: int,
    card: CardSearchResult,
    *,
    already_shown: bool,
    semantic_score: float | None = None,
    edhrec_association: EdhrecAssociation | None = None,
) -> dict[str, Any]:
    """Build the compact, URL-free card shape used in agent messages and traces."""

    return {
        "id": candidate_id,
        "already_shown": already_shown,
        "semantic_score": semantic_score,
        "edhrec_inclusion": (
            edhrec_association.inclusion
            if edhrec_association is not None
            else None
        ),
        "edhrec_synergy": (
            edhrec_association.synergy
            if edhrec_association is not None
            else None
        ),
        "edhrec_num_decks": (
            edhrec_association.num_decks
            if edhrec_association is not None
            else None
        ),
        "edhrec_potential_decks": (
            edhrec_association.potential_decks
            if edhrec_association is not None
            else None
        ),
        "card": {
            "name": card.name,
            "mana_cost": _card_mana_cost(card) or None,
            "mana_value": card.mana_value,
            "type_line": _card_type_line(card),
            "oracle_text": _card_oracle_text(card) or None,
            "power_toughness": _card_power_toughness(card) or None,
            "price_eur": str(card.prices.eur) if card.prices.eur is not None else None,
            "color_identity": card.color_identity,
        },
    }


def _candidate_edhrec_association(
    candidate: AgentSearchCandidate | None,
) -> EdhrecAssociation | None:
    if (
        candidate is None
        or candidate.edhrec_inclusion is None
        or candidate.edhrec_num_decks is None
        or candidate.edhrec_potential_decks is None
    ):
        return None
    return EdhrecAssociation(
        oracle_id=candidate.card.oracle_id,
        num_decks=candidate.edhrec_num_decks,
        potential_decks=candidate.edhrec_potential_decks,
        synergy=candidate.edhrec_synergy,
    )


def _commander_trace_payload(
    context: _AgentCommanderContext | None,
) -> dict[str, Any] | None:
    if context is None:
        return None
    return {
        "oracle_id": str(context.card.oracle_id),
        "name": context.card.name,
        "type_line": context.card.type_line,
        "color_identity": context.card.color_identity,
        "edhrec": context.enhancement.model_dump(mode="json"),
        "selected_theme": {
            "slug": context.selected_theme_slug,
            "name": context.selected_theme_name,
        },
        "available_themes": [
            {
                "slug": theme.slug,
                "name": theme.name,
                "deck_count": theme.deck_count,
            }
            for theme in (
                context.edhrec_context.themes
                if context.edhrec_context is not None
                else ()
            )
        ],
    }


def _render_commander_context(
    context: _AgentCommanderContext | None,
) -> list[str]:
    """Render commander facts only. The system prompt owns how to use them."""

    if context is None:
        return []
    card = context.card
    identity = "".join(card.color_identity) or "colorless"
    lines = [
        f"Name: {card.name}",
        f"Mana: {_card_mana_cost(card) or 'no mana cost'}",
        f"Type: {_card_type_line(card)}",
        f"Color identity: {identity}",
        f"Oracle text: {_card_oracle_text(card) or 'No Oracle text'}",
    ]
    if context.enhancement.status == "unavailable":
        lines.append("EDHREC evidence: unavailable")
        return lines
    if context.edhrec_context is None or context.edhrec_ranking is None:
        lines.append("EDHREC evidence: disabled")
        return lines

    lines.append("EDHREC evidence: available")
    if context.selected_theme_name is not None:
        lines.append(
            "Selected theme: "
            f"{context.selected_theme_name} ({context.selected_theme_slug})"
        )
    else:
        lines.append("Selected theme: All commander decks")
    themes = ", ".join(theme.name for theme in context.edhrec_context.themes[:10])
    lines.append(f"Advertised themes: {themes or 'None'}")
    return lines


def _render_agent_user_message(
    request: AgenticCardSearchRequest,
    *,
    selectable_preview: list[CardSearchResult],
    already_shown: list[CardSearchResult],
    round_number: int,
    previous_tool_requests: tuple[dict[str, Any], ...],
    include_full_card_details: bool,
    commander_context: _AgentCommanderContext | None,
) -> str:
    """Render the user message as labelled data sections only.

    Carries no instructions: every rule the model needs lives in the system
    prompt, so this message cannot contradict it.
    """

    is_continuation = request.page != 1 or round_number > 1
    lines = ["## Request", request.q, "", "## Interface filters"]
    lines.extend(_render_filter_lines(request.filters))

    commander_lines = _render_commander_context(commander_context)
    if commander_lines:
        lines.extend(["", "## Commander", *commander_lines])

    if is_continuation:
        if previous_tool_requests:
            lines.extend(["", "## Previous tool searches"])
            for search_round, arguments in enumerate(previous_tool_requests, start=1):
                lines.append(f"Round {search_round}:")
                lines.append(
                    json.dumps(arguments, ensure_ascii=False, indent=2, sort_keys=True)
                )
        lines.extend(["", "## Already showing"])
        if already_shown:
            for candidate_id, card in enumerate(already_shown, start=1):
                if include_full_card_details:
                    lines.extend(_render_preview_candidate(candidate_id, card))
                else:
                    lines.append(f"{candidate_id}. {card.name} — {_card_type_line(card)}")
        else:
            lines.append("None")
        lines.extend(["", "## Round", str(round_number)])
    elif selectable_preview:
        lines.extend(["", "## Fuzzy matches already shown"])
        for candidate_id, card in enumerate(selectable_preview, start=1):
            lines.extend(_render_preview_candidate(candidate_id, card))
    else:
        lines.extend(["", "## Fuzzy matches already shown", "None"])

    return "\n".join(lines).rstrip() + "\n"


def _render_preview_candidate(
    candidate_id: int,
    card: CardSearchResult,
) -> list[str]:
    return [
        f"ID {candidate_id} [ALREADY SHOWN]",
        f"Name: {card.name}",
        (f"Mana: {_card_mana_cost(card) or 'no mana cost'} (mana value {card.mana_value:g})"),
        f"Type: {_card_type_line(card)}",
        f"Power/Toughness: {_card_power_toughness(card) or 'not applicable'}",
        f"EUR price estimate: {_card_price_eur(card)}",
        f"Oracle text: {_card_oracle_text(card) or 'No Oracle text'}",
        "",
    ]


def _render_filter_lines(filters: CardSearchFilters) -> list[str]:
    lines: list[str] = [
        (
            "- Commander legality: non-legal cards may be included"
            if filters.include_non_commander_legal
            else "- Commander legality: legal cards only"
        ),
    ]
    if filters.commander_color_identity is not None:
        identity = "".join(filters.commander_color_identity) or "colorless"
        lines.append(
            f"- Deck commander identity: {identity}; cards outside it may be included"
            if filters.include_outside_commander_color_identity
            else f"- Deck commander identity: {identity}; cards must stay within it"
        )
    if filters.tags:
        lines.append(
            "- Required card tags (immutable; the tool cannot remove or change these): "
            + ", ".join(tag.name for tag in filters.tags)
        )
    if filters.card_types:
        lines.append(
            "- Required card types (immutable; every value must match): "
            + ", ".join(filters.card_types)
        )
    if filters.subtypes:
        lines.append(
            "- Required card subtypes (immutable; every value must match): "
            + ", ".join(filters.subtypes)
        )
    if filters.colors:
        mode = "exactly" if filters.color_mode == "exact" else "can include"
        lines.append(f"- Color identity {mode}: {', '.join(filters.colors)}")
    if filters.include_colorless:
        lines.append("- Colorless cards may be included")
    if filters.mana_value_min is not None or filters.mana_value_max is not None:
        lines.append(
            "- Mana value: " + _format_range(filters.mana_value_min, filters.mana_value_max)
        )
    if filters.price_eur_min is not None or filters.price_eur_max is not None:
        lines.append("- EUR price: " + _format_range(filters.price_eur_min, filters.price_eur_max))
    return lines


def _format_range(minimum: object | None, maximum: object | None) -> str:
    if minimum is not None and maximum is not None:
        return f"{minimum} to {maximum}"
    if minimum is not None:
        return f"at least {minimum}"
    return f"at most {maximum}"


def _render_tool_result_message(
    executed: ExecutedSearchTool,
    candidates: list[dict[str, Any]],
) -> str:
    """Return the tool message as labelled data sections only.

    Carries no instructions: the system prompt explains how to read these
    fields, so this message cannot contradict it.
    """

    lines = [
        "## Search",
        f"Semantic sort intent: {executed.arguments.get('semantic_sort', 'not requested')}",
        f"Primary sort: {executed.arguments.get('sort_by', 'semantic')}",
        "",
        f"## Candidates ({len(candidates)})",
    ]
    for candidate in candidates:
        card = candidate["card"]
        shown = " [ALREADY SHOWN]" if candidate["already_shown"] else ""
        colors = ", ".join(card["color_identity"]) or "colorless"
        semantic_score = candidate["semantic_score"]
        semantic_closeness = (
            f"{semantic_score:.4f} (0-1)"
            if semantic_score is not None
            else "not scored (fuzzy title preview only)"
        )
        edhrec_inclusion = candidate["edhrec_inclusion"]
        edhrec_synergy = candidate["edhrec_synergy"]
        edhrec_decks = candidate["edhrec_num_decks"]
        edhrec_potential = candidate["edhrec_potential_decks"]
        if edhrec_inclusion is None:
            commander_fit = "not listed for the selected commander/theme"
        else:
            synergy = (
                f"{edhrec_synergy:.4f}"
                if edhrec_synergy is not None
                else "unavailable"
            )
            commander_fit = (
                f"inclusion {edhrec_inclusion:.4f} "
                f"({edhrec_decks}/{edhrec_potential} decks); "
                f"synergy {synergy}"
            )
        lines.extend(
            [
                f"ID {candidate['id']}{shown}",
                f"Name: {card['name']}",
                f"Semantic closeness: {semantic_closeness}",
                f"EDHREC commander fit: {commander_fit}",
                (
                    f"Mana: {card['mana_cost'] or 'no mana cost'} "
                    f"(mana value {card['mana_value']:g})"
                ),
                f"Type: {card['type_line']}",
                f"Power/Toughness: {card['power_toughness'] or 'not applicable'}",
                (
                    "EUR price estimate: "
                    + (f"€{card['price_eur']}" if card["price_eur"] else "unavailable")
                ),
                f"Color identity: {colors}",
                f"Rules: {card['oracle_text'] or 'No rules text'}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def _card_title_scores(
    query: str,
    card: CardSearchResult,
) -> tuple[float, float]:
    """Match agent results against the same title aliases as fuzzy previews."""

    aliases = card_title_aliases(card)
    return (
        max(name_similarity_score(query, alias) for alias in aliases),
        max(preview_confidence_score(query, alias) for alias in aliases),
    )


def _deduplicate_cards(
    cards: tuple[CardSearchResult, ...],
) -> tuple[CardSearchResult, ...]:
    unique: list[CardSearchResult] = []
    seen: set[UUID] = set()
    for card in cards:
        if card.oracle_id in seen:
            continue
        seen.add(card.oracle_id)
        unique.append(card)
    return tuple(unique)


def _page_batches(
    cards: tuple[CardSearchResult, ...],
    *,
    first_page: int,
    page_size: int,
) -> dict[int, tuple[CardSearchResult, ...]]:
    if not cards:
        return {first_page: ()}
    return {
        first_page + offset // page_size: cards[offset : offset + page_size]
        for offset in range(0, len(cards), page_size)
    }


def _page_from_stored(
    stored: _StoredAgentSearch,
    *,
    page: int,
) -> CardSearchPage:
    try:
        cards = list(stored.page_batches[page])
    except KeyError as exc:
        raise CardSearchQueryError from exc
    return CardSearchPage(
        query=stored.query,
        page=page,
        total_results=stored.prefix_count + len(stored.cards),
        has_more=(page + 1) in stored.page_batches,
        cards=cards,
        name_match_scores={
            card.scryfall_id: stored.name_match_scores[card.scryfall_id] for card in cards
        },
        title_confidence_scores={
            card.scryfall_id: stored.title_confidence_scores[card.scryfall_id] for card in cards
        },
        warnings=list(stored.warnings),
        strategy="agentic",
        interpretation=stored.interpretation,
        reranked=True,
        search_session_id=stored.session_id,
        edhrec=stored.edhrec,
        debug=stored.debug if page == stored.debug_page else None,
        debug_runs=list(stored.debug_runs),
    )


def _to_search_debug_summary(
    trace: AgentSearchTraceRecord,
    *,
    log_path: str,
    log_written: bool,
    selected_tool: str,
    result_cards: tuple[CardSearchResult, ...],
    interpretation: str,
) -> SearchDebugSummary:
    total_duration_ms = max(
        (trace.completed_at - trace.started_at).total_seconds() * 1_000,
        0,
    )
    stages = _agent_trace_presentation_stages(
        trace,
        result_cards=result_cards,
        interpretation=interpretation,
    )
    record = {
        "schema_version": trace.schema_version,
        "trace_id": str(trace.trace_id),
        "started_at": trace.started_at.isoformat(),
        "completed_at": trace.completed_at.isoformat(),
        "total_duration_ms": round(total_duration_ms, 3),
        "request": trace.stages[0].payload,
        "configuration": {"workflow": "one_tool_then_final", "model_calls": 2},
        "decision": {
            "strategy": "agentic",
            "input_kind": "card_search_query",
            "selected_tool": selected_tool,
            "tool_call_count": 1,
        },
        "stages": stages,
        "result": {
            "status": "ok",
            "strategy": "agentic",
            "interpretation": interpretation,
            "total_results": len(result_cards),
            "returned": {
                "count": len(result_cards),
                "top": [
                    {
                        "rank": rank,
                        "scryfall_id": str(card.scryfall_id),
                        "name": card.name,
                    }
                    for rank, card in enumerate(result_cards, start=1)
                ],
            },
        },
    }
    return SearchDebugSummary(
        trace_id=trace.trace_id,
        log_path=log_path,
        log_written=log_written,
        total_duration_ms=round(total_duration_ms, 3),
        stages=[
            SearchDebugStage(
                name=str(stage["name"]),
                status="ok",
                duration_ms=float(stage["duration_ms"]),
            )
            for stage in stages
        ],
        trace=record,
    )


def _to_failed_search_debug_summary(
    trace: AgentSearchTraceRecord,
    *,
    log_path: str,
    log_written: bool,
) -> SearchDebugSummary:
    """Project a partial internal run into the same seven visible trace steps."""

    total_duration_ms = max(
        (trace.completed_at - trace.started_at).total_seconds() * 1_000,
        0,
    )
    stages = _failed_agent_trace_presentation_stages(trace)
    failed_stage = next(
        (str(stage["name"]) for stage in stages if stage["status"] == "error"),
        "unknown",
    )
    record = {
        "schema_version": trace.schema_version,
        "trace_id": str(trace.trace_id),
        "started_at": trace.started_at.isoformat(),
        "completed_at": trace.completed_at.isoformat(),
        "total_duration_ms": round(total_duration_ms, 3),
        "request": trace.stages[0].payload,
        "configuration": {"workflow": "one_tool_then_final", "model_calls": 2},
        "decision": {
            "strategy": "agentic",
            "input_kind": "card_search_query",
            "failed_stage": failed_stage,
        },
        "stages": stages,
        "result": {
            "status": trace.status,
            "strategy": "agentic",
            "failed_stage": failed_stage,
            "error": trace.error or {},
        },
    }
    return SearchDebugSummary(
        trace_id=trace.trace_id,
        log_path=log_path,
        log_written=log_written,
        total_duration_ms=round(total_duration_ms, 3),
        stages=[
            SearchDebugStage(
                name=str(stage["name"]),
                status=stage["status"],
                duration_ms=float(stage["duration_ms"]),
            )
            for stage in stages
        ],
        trace=record,
    )


def _failed_agent_trace_presentation_stages(
    trace: AgentSearchTraceRecord,
) -> list[dict[str, Any]]:
    """Show completed work, the exact failure point, and later skipped steps."""

    by_name = {stage.name: stage for stage in trace.stages}
    initial_request = by_name.get("initial_model_request")
    initial_response = by_name.get("initial_model_response")
    tool_call = by_name.get("tool_call")
    tool_result = by_name.get("tool_result")
    final_response = by_name.get("final_model_response")
    validation = by_name.get("validation")
    messages = initial_request.payload.get("messages") if initial_request is not None else None
    model_messages = messages if isinstance(messages, list) else []
    error_details = trace.error or {"error_type": "UnknownAgenticSearchError"}
    failure_duration_ms = max(
        (trace.completed_at - trace.started_at).total_seconds() * 1_000,
        0,
    )

    if initial_request is None:
        failed_index = 0
    elif initial_response is None:
        failed_index = 2
    elif tool_call is None:
        failed_index = 3
    elif tool_result is None:
        failed_index = 4
    elif final_response is None:
        failed_index = 5
    elif validation is None:
        failed_index = 6
    else:
        failed_index = 6

    final_message = (
        _trace_response_message(final_response.payload) if final_response is not None else {}
    )
    final_content = final_message.get("content")
    stage_specs: list[tuple[str, dict[str, Any], float | None, bool]] = [
        (
            "system_prompt",
            {"content": _message_content(model_messages, "system")},
            None,
            initial_request is not None,
        ),
        (
            "user_input_prompt",
            {"content": _message_content(model_messages, "user")},
            None,
            initial_request is not None,
        ),
        (
            "thinking",
            (
                _thinking_trace_payload(
                    initial_response.payload,
                    phase="tool_selection",
                )
                if initial_response is not None
                else {"phase": "tool_selection"}
            ),
            initial_response.duration_ms if initial_response is not None else None,
            initial_response is not None,
        ),
        (
            "tool_call",
            tool_call.payload if tool_call is not None else {},
            tool_call.duration_ms if tool_call is not None else None,
            tool_call is not None,
        ),
        (
            "tool_response",
            tool_result.payload if tool_result is not None else {},
            tool_result.duration_ms if tool_result is not None else None,
            tool_result is not None,
        ),
        (
            "thinking",
            (
                _thinking_trace_payload(
                    final_response.payload,
                    phase="final_ranking",
                )
                if final_response is not None
                else {"phase": "final_ranking"}
            ),
            final_response.duration_ms if final_response is not None else None,
            final_response is not None,
        ),
        (
            "output_response",
            {
                "content": final_content if isinstance(final_content, str) else "",
                "ranked_ids": (
                    validation.payload.get("ranked_ids") if validation is not None else []
                ),
                "ranked_cards": [],
            },
            validation.duration_ms if validation is not None else None,
            validation is not None,
        ),
    ]

    stages: list[dict[str, Any]] = []
    for index, (name, details, duration_ms, completed) in enumerate(stage_specs):
        if completed:
            status = "ok"
        elif index == failed_index:
            status = "error"
            details = {**details, **error_details}
            duration_ms = duration_ms or failure_duration_ms
        else:
            status = "skipped"
            details = {"reason": "Not reached because an earlier agentic-search step failed."}
        stages.append(
            _presentation_stage(
                name,
                details,
                duration_ms=duration_ms,
                status=status,
            )
        )
    return stages


def _agent_trace_presentation_stages(
    trace: AgentSearchTraceRecord,
    *,
    result_cards: tuple[CardSearchResult, ...],
    interpretation: str,
) -> list[dict[str, Any]]:
    """Project the internal execution log into the seven user-facing agent steps."""

    by_name = {stage.name: stage for stage in trace.stages}
    initial_request = by_name["initial_model_request"]
    initial_response = by_name["initial_model_response"]
    tool_call = by_name["tool_call"]
    tool_result = by_name["tool_result"]
    final_response = by_name["final_model_response"]
    validation = by_name["validation"]

    messages = initial_request.payload.get("messages")
    model_messages = messages if isinstance(messages, list) else []
    system_prompt = _message_content(model_messages, "system")
    user_prompt = _message_content(model_messages, "user")
    final_message = _trace_response_message(final_response.payload)
    final_content = final_message.get("content")
    ranked_ids = validation.payload.get("ranked_ids")

    return [
        _presentation_stage(
            "system_prompt",
            {"content": system_prompt},
        ),
        _presentation_stage(
            "user_input_prompt",
            {"content": user_prompt},
        ),
        _presentation_stage(
            "thinking",
            _thinking_trace_payload(initial_response.payload, phase="tool_selection"),
            duration_ms=initial_response.duration_ms,
        ),
        _presentation_stage(
            "tool_call",
            tool_call.payload,
            duration_ms=tool_call.duration_ms,
        ),
        _presentation_stage(
            "tool_response",
            tool_result.payload,
            duration_ms=tool_result.duration_ms,
        ),
        _presentation_stage(
            "thinking",
            _thinking_trace_payload(final_response.payload, phase="final_ranking"),
            duration_ms=final_response.duration_ms,
        ),
        _presentation_stage(
            "output_response",
            {
                "content": final_content if isinstance(final_content, str) else "",
                "interpretation": interpretation,
                "ranked_ids": ranked_ids if isinstance(ranked_ids, list) else [],
                "ranked_cards": [
                    {
                        "rank": rank,
                        "name": card.name,
                    }
                    for rank, card in enumerate(result_cards, start=1)
                ],
            },
        ),
    ]


def _presentation_stage(
    name: str,
    details: dict[str, Any],
    *,
    duration_ms: float | None = None,
    status: str = "ok",
) -> dict[str, Any]:
    return {
        "name": name,
        "status": status,
        "duration_ms": duration_ms or 0,
        "details": details,
    }


def _message_content(messages: list[object], role: str) -> str:
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != role:
            continue
        content = message.get("content")
        return content if isinstance(content, str) else ""
    return ""


def _trace_response_message(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return {}
    message = choices[0].get("message")
    return message if isinstance(message, dict) else {}


def _thinking_trace_payload(
    response: dict[str, Any],
    *,
    phase: str,
) -> dict[str, Any]:
    message = _trace_response_message(response)
    return {
        "phase": phase,
        "reasoning": message.get("reasoning"),
        "reasoning_details": message.get("reasoning_details"),
    }


def _elapsed_ms(started: float) -> float:
    return round(max((perf_counter() - started) * 1_000, 0), 3)
