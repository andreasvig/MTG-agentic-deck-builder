"""Progressive one-tool agentic card search."""

from __future__ import annotations

import asyncio
import json
import re
from collections import Counter
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from decimal import Decimal
from time import monotonic, perf_counter
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
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
    LocalCardSearchRequest,
    LocalCardSearchResult,
    ScryfallCardSearchRequest,
    SearchDebugStage,
    SearchDebugSummary,
)
from mtg_deck_builder.providers import (
    CardSearchQueryError,
    CardSearchUnavailable,
    map_scryfall_card,
    name_similarity_score,
)
from mtg_deck_builder.providers.openrouter import OpenRouterClient, OpenRouterError
from mtg_deck_builder.search import (
    FuzzyTitleSearchProvider,
    matches_card_filters,
    preview_confidence_score,
)

_TOOL_CALL_ADAPTER = TypeAdapter(AgentSearchToolCall)


@dataclass(frozen=True)
class ExecutedSearchTool:
    """One bounded tool result ready to return to the final model call."""

    name: str
    arguments: dict[str, Any]
    candidates: tuple[AgentSearchCandidate, ...]
    payload: dict[str, Any]


@dataclass(frozen=True)
class _StoredAgentSearch:
    session_id: UUID
    query: str
    filters: CardSearchFilters
    cards: tuple[CardSearchResult, ...]
    name_match_scores: dict[UUID, float]
    title_confidence_scores: dict[UUID, float]
    interpretation: str
    warnings: tuple[str, ...]
    debug: SearchDebugSummary | None
    created_at: float


class AgenticSearchSessionStore:
    """Keep a completed ranking so Load more never starts another model run."""

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
        semantic_enabled: bool,
    ) -> None:
        self._catalog = catalog
        self._default_max_results = default_max_results
        self._hard_max_results = hard_max_results
        self._semantic_enabled = semantic_enabled

    async def search(
        self,
        request: LocalCardSearchRequest,
        *,
        immutable_filters: CardSearchFilters,
    ) -> ExecutedSearchTool:
        limit = resolve_local_tool_limit(
            request,
            immutable_filters=immutable_filters,
            default_max_results=self._default_max_results,
            hard_max_results=self._hard_max_results,
        )
        if (
            request.oracle_text is not None
            and request.oracle_text.semantic_query
            and not self._semantic_enabled
        ):
            raise AgentSearchContractError(
                "semantic Oracle-text retrieval is not enabled; use search_scryfall"
            )
        if request.power is not None or request.toughness is not None:
            raise AgentSearchContractError(
                "power and toughness are not indexed locally; use search_scryfall"
            )
        if request.legality is not None and request.format is None:
            raise AgentSearchContractError("legality requires a format")

        entries = await self._catalog.entries()
        result = await asyncio.to_thread(
            _execute_local_search,
            entries,
            request,
            immutable_filters,
            limit,
        )
        return ExecutedSearchTool(
            name="search_local_cards",
            arguments=request.model_dump(mode="json", exclude_none=True),
            candidates=tuple(result.candidates),
            payload=result.model_dump(mode="json"),
        )


class ScryfallCardSearchTool:
    """Execute one bounded live Scryfall search selected by the agent."""

    def __init__(
        self,
        *,
        base_url: str,
        user_agent: str,
        timeout_seconds: float,
        request_interval_seconds: float,
        default_max_results: int,
        hard_max_results: int,
        open_url: Callable[..., Any] = urlopen,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._user_agent = user_agent
        self._timeout_seconds = timeout_seconds
        self._request_interval_seconds = request_interval_seconds
        self._default_max_results = default_max_results
        self._hard_max_results = hard_max_results
        self._open_url = open_url

    async def search(
        self,
        request: ScryfallCardSearchRequest,
        *,
        immutable_filters: CardSearchFilters,
    ) -> ExecutedSearchTool:
        limit = request.max_results or self._default_max_results
        if limit > self._hard_max_results:
            raise AgentSearchContractError("Scryfall max_results exceeds the hard maximum")
        return await asyncio.to_thread(
            self._search_sync,
            request,
            immutable_filters,
            limit,
        )

    def _search_sync(
        self,
        request: ScryfallCardSearchRequest,
        immutable_filters: CardSearchFilters,
        limit: int,
    ) -> ExecutedSearchTool:
        compiled_query = _ensure_paper_query(request.query)
        next_url: str | None = f"{self._base_url}/cards/search?" + urlencode(
            {
                "q": compiled_query,
                "unique": "cards",
                "order": "edhrec",
                "dir": "asc",
            }
        )
        candidates: list[AgentSearchCandidate] = []
        seen_oracle_ids: set[UUID] = set()
        provider_pages = 0
        provider_total: int | None = None

        while next_url is not None and len(candidates) < limit:
            if provider_pages and self._request_interval_seconds:
                import time

                time.sleep(self._request_interval_seconds)
            payload = self._get_page(next_url)
            provider_pages += 1
            provider_total_value = payload.get("total_cards")
            if isinstance(provider_total_value, int):
                provider_total = provider_total_value
            data = payload.get("data")
            if not isinstance(data, list):
                raise CardSearchUnavailable
            for raw_card in data:
                try:
                    card = map_scryfall_card(raw_card)
                except (ValidationError, ValueError, TypeError):
                    continue
                if card.oracle_id in seen_oracle_ids:
                    continue
                seen_oracle_ids.add(card.oracle_id)
                if not matches_card_filters(card, immutable_filters):
                    continue
                candidates.append(
                    AgentSearchCandidate(
                        card=card,
                        exact_match_evidence=[f"Scryfall query: {compiled_query}"],
                        filter_decisions={"immutable_ui_filters": True},
                    )
                )
                if len(candidates) >= limit:
                    break
            next_page = payload.get("next_page")
            next_url = next_page if isinstance(next_page, str) else None

        tool_payload = {
            "request": request.model_dump(mode="json"),
            "compiled_query": compiled_query,
            "provider": "scryfall",
            "provider_pages": provider_pages,
            "provider_total_cards": provider_total,
            "returned_candidates": len(candidates),
            "candidates": [candidate.model_dump(mode="json") for candidate in candidates],
        }
        return ExecutedSearchTool(
            name="search_scryfall",
            arguments=request.model_dump(mode="json", exclude_none=True),
            candidates=tuple(candidates),
            payload=tool_payload,
        )

    def _get_page(self, url: str) -> dict[str, Any]:
        request = Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": self._user_agent,
            },
        )
        try:
            with self._open_url(request, timeout=self._timeout_seconds) as response:
                payload = json.loads(response.read())
        except HTTPError as exc:
            body = _load_json_response(exc.read())
            if exc.code == 404:
                return {"data": [], "has_more": False, "provider_error": body}
            if exc.code == 400:
                raise CardSearchQueryError from exc
            raise CardSearchUnavailable from exc
        except (OSError, URLError, json.JSONDecodeError) as exc:
            raise CardSearchUnavailable from exc
        if not isinstance(payload, dict):
            raise CardSearchUnavailable
        return payload


class AgenticCardSearchService:
    """Coordinate fuzzy preview, one model-selected tool, and final ranking."""

    def __init__(
        self,
        *,
        fuzzy_provider: FuzzyTitleSearchProvider,
        local_tool: LocalCardSearchTool,
        scryfall_tool: ScryfallCardSearchTool,
        model_client: OpenRouterClient | None,
        settings: AgenticSearchSettings,
        page_size: int,
        trace_logger: JsonlAgentSearchTraceLogger,
        trace_log_path: str,
        debug_default_enabled: bool,
        sessions: AgenticSearchSessionStore | None = None,
    ) -> None:
        self._fuzzy_provider = fuzzy_provider
        self._local_tool = local_tool
        self._scryfall_tool = scryfall_tool
        self._model_client = model_client
        self._settings = settings
        self._page_size = page_size
        self._trace_logger = trace_logger
        self._trace_log_path = trace_log_path
        self._debug_default_enabled = debug_default_enabled
        self._sessions = sessions or AgenticSearchSessionStore()

    async def search(self, request: AgenticCardSearchRequest) -> CardSearchPage:
        """Start a new agent run or page through a stored completed ranking."""

        if request.search_session_id is not None:
            return await self._page_stored_search(request)
        if request.page != 1:
            raise CardSearchQueryError
        if not self._settings.enabled or self._model_client is None:
            raise CardSearchUnavailable

        preview = await self._fuzzy_provider.search(
            CardSearchQuery(
                q=request.q,
                filters=request.filters,
                debug=False,
            )
        )
        trace_enabled = self._debug_default_enabled or request.debug
        trace = AgentSearchTraceBuilder(
            {
                "query": request.q,
                "filters": request.filters.model_dump(mode="json"),
                "debug": request.debug,
                "preview_candidates": [card.model_dump(mode="json") for card in preview.cards],
            }
        )
        try:
            completed = await self._run_agent(request, preview, trace)
        except asyncio.CancelledError as exc:
            await self._persist_failed_trace(trace, exc, trace_enabled)
            raise
        except Exception as exc:
            await self._persist_failed_trace(trace, exc, trace_enabled)
            if isinstance(exc, CardSearchQueryError):
                raise
            raise CardSearchUnavailable from exc

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
        session_id = uuid4()
        title_scores = {
            card.scryfall_id: _card_title_scores(request.q, card) for card in completed.cards
        }
        stored = _StoredAgentSearch(
            session_id=session_id,
            query=request.q,
            filters=request.filters,
            cards=completed.cards,
            name_match_scores={
                card.scryfall_id: title_scores[card.scryfall_id][0] for card in completed.cards
            },
            title_confidence_scores={
                card.scryfall_id: title_scores[card.scryfall_id][1] for card in completed.cards
            },
            interpretation=completed.output.interpretation,
            warnings=(
                ("Agent used live Scryfall search.",)
                if completed.tool.name == "search_scryfall"
                else ()
            ),
            debug=debug,
            created_at=monotonic(),
        )
        await self._sessions.put(stored)
        return _page_from_stored(stored, page=1, page_size=self._page_size)

    async def _run_agent(
        self,
        request: AgenticCardSearchRequest,
        preview: CardSearchPage,
        trace: AgentSearchTraceBuilder,
    ) -> _CompletedAgentRun:
        assert self._model_client is not None
        tools = _tool_definitions()
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    self._settings.system_prompt
                    + "\n\nIMPORTANT RUNTIME CAPABILITIES: semantic embeddings are "
                    "disabled. Do not use semantic_query. The local catalog cannot "
                    "filter power or toughness. You MUST use search_scryfall for "
                    'descriptions such as "big", "large", or "high power"; encode '
                    'them with Scryfall syntax such as pow>=4. Local "types" and '
                    '"colors" are nested objects, never strings.'
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "search_query": request.q,
                        "immutable_ui_filters": request.filters.model_dump(mode="json"),
                        "confident_fuzzy_title_preview": [
                            card.model_dump(mode="json") for card in preview.cards
                        ],
                        "required_workflow": (
                            "Call exactly one tool. After its result, rank every "
                            "candidate from the preview/tool union."
                        ),
                    },
                    ensure_ascii=True,
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
        if tool_call.name == "search_local_cards":
            executed = await self._local_tool.search(
                tool_call.arguments,
                immutable_filters=request.filters,
            )
        else:
            executed = await self._scryfall_tool.search(
                tool_call.arguments,
                immutable_filters=request.filters,
            )
        trace.add_stage(
            "tool_result",
            executed.payload,
            duration_ms=_elapsed_ms(started),
        )

        union = _candidate_union(preview.cards, executed.candidates)
        tool_message_content = {
            **executed.payload,
            "required_candidate_union_ids": [str(card.scryfall_id) for card in union],
            "required_candidate_union": [_compact_card_for_model(card) for card in union],
        }
        final_messages = [
            *messages,
            _assistant_tool_call_message(assistant_message),
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": json.dumps(tool_message_content, ensure_ascii=True),
            },
        ]
        final_payload = {
            "model": self._settings.model,
            "messages": final_messages,
            "tools": tools,
            "tool_choice": "none",
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
        ranked_ids = validate_final_ranking(
            output,
            preview_ids=(),
            tool_candidate_ids=(card.scryfall_id for card in union),
            max_candidate_count=self._page_size + self._settings.max_tool_results,
        )
        by_id = {card.scryfall_id: card for card in union}
        ranked_cards = tuple(by_id[card_id] for card_id in ranked_ids)
        trace.add_stage(
            "validation",
            {
                "status": "accepted",
                "candidate_count": len(union),
                "ranked_ids": [str(card_id) for card_id in ranked_ids],
                "all_candidates_ranked": True,
                "invented_ids": [],
            },
        )
        return _CompletedAgentRun(
            output=output,
            tool=executed,
            cards=ranked_cards,
        )

    async def _page_stored_search(
        self,
        request: AgenticCardSearchRequest,
    ) -> CardSearchPage:
        assert request.search_session_id is not None
        stored = await self._sessions.get(request.search_session_id)
        if stored is None or stored.query != request.q or stored.filters != request.filters:
            raise CardSearchQueryError
        return _page_from_stored(stored, page=request.page, page_size=self._page_size)

    async def _persist_failed_trace(
        self,
        trace: AgentSearchTraceBuilder,
        error: BaseException,
        trace_enabled: bool,
    ) -> None:
        if not trace_enabled:
            return
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
        with suppress(OSError):
            await self._trace_logger.write(record)


@dataclass(frozen=True)
class _CompletedAgentRun:
    output: AgentRankedSearchOutput
    tool: ExecutedSearchTool
    cards: tuple[CardSearchResult, ...]


def _execute_local_search(
    entries: tuple[CatalogEntry, ...],
    request: LocalCardSearchRequest,
    immutable_filters: CardSearchFilters,
    limit: int,
) -> LocalCardSearchResult:
    matches: list[tuple[float, AgentSearchCandidate]] = []
    for entry in entries:
        card = entry.card
        if not matches_card_filters(card, immutable_filters):
            continue
        evidence: list[str] = []
        decisions: dict[str, bool] = {"immutable_ui_filters": True}
        if request.name is not None and request.name.query:
            name_score = name_similarity_score(request.name.query, card.name)
            decisions["name"] = name_score > 0
            evidence.append(f"name similarity {name_score:.3f}")
        else:
            name_score = 0
        if request.oracle_text is not None:
            oracle_text = _card_oracle_text(card)
            if not _matches_text_conditions(oracle_text, request.oracle_text):
                continue
            decisions["oracle_text"] = True
            evidence.append("Oracle-text conditions matched")
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
        if request.format is not None:
            expected = request.legality or "legal"
            if card.legalities.get(request.format.casefold()) != expected:
                continue
            decisions["format"] = True
            evidence.append(f"{request.format} legality matched")
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
    matches.sort(
        key=lambda item: (
            -item[0],
            item[1].card.name.casefold(),
        )
    )
    candidates = [candidate for _, candidate in matches[:limit]]
    return LocalCardSearchResult(
        request=request,
        total_candidates=len(matches),
        candidates=candidates,
        compiled_query={
            "engine": "local_sqlite_catalog",
            "semantic_mode": "disabled",
            "immutable_filters": immutable_filters.model_dump(mode="json"),
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


def _matches_agent_colors(card: CardSearchResult, search: Any) -> bool:
    selected = set(search.identity or [])
    identity = set(card.color_identity)
    if not selected:
        return search.include_colorless and not identity
    if not identity:
        return search.include_colorless
    return identity == selected if search.mode == "exact" else identity.issubset(selected)


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


def _ensure_paper_query(query: str) -> str:
    stripped = query.strip()
    if re.search(r"(?:^|\s)game\s*:\s*paper(?:\s|$)", stripped, re.IGNORECASE):
        return stripped
    return f"({stripped}) game:paper"


def _tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "search_local_cards",
                "description": (
                    "Search the complete local MTG catalog with exact structured "
                    "conditions. All fields are optional. Duplicate exact values "
                    "to require multiple occurrences. Do not use this tool for "
                    "power, toughness, big/large creatures, or semantic meaning "
                    "while embeddings are disabled. types and colors must be "
                    "nested objects, never strings."
                ),
                "parameters": LocalCardSearchRequest.model_json_schema(),
                "strict": True,
            },
        },
        {
            "type": "function",
            "function": {
                "name": "search_scryfall",
                "description": (
                    "Run one bounded Scryfall syntax query. Use this for power, "
                    "toughness, big/large creatures and other descriptive searches "
                    "while embeddings are disabled, or live Scryfall-only "
                    "capabilities. Example: id:g t:creature pow>=4."
                ),
                "parameters": ScryfallCardSearchRequest.model_json_schema(),
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

    name = normalized.get("name")
    if isinstance(name, str):
        normalized["name"] = {"query": name}
        changes.append("name string -> name.query")

    for key in ("mana", "types"):
        value = normalized.get(key)
        if isinstance(value, str):
            normalized[key] = {"must_contain_all": [value]}
            changes.append(f"{key} string -> {key}.must_contain_all")
        elif isinstance(value, list) and value and all(isinstance(item, str) for item in value):
            normalized[key] = {"must_contain_all": value}
            changes.append(f"{key} list -> {key}.must_contain_all")

    oracle_text = normalized.get("oracle_text")
    if isinstance(oracle_text, str):
        normalized["oracle_text"] = {"semantic_query": oracle_text}
        changes.append("oracle_text string -> oracle_text.semantic_query")

    colors = normalized.get("colors")
    if isinstance(colors, str):
        normalized["colors"] = {"identity": [_normalize_magic_color(colors)]}
        changes.append("colors string -> colors.identity")
    elif isinstance(colors, list) and all(isinstance(item, str) for item in colors):
        normalized["colors"] = {"identity": [_normalize_magic_color(item) for item in colors]}
        changes.append("colors list -> colors.identity")

    for key in ("sets", "rarities"):
        value = normalized.get(key)
        if isinstance(value, str):
            normalized[key] = [value]
            changes.append(f"{key} string -> {key} list")

    return normalized, changes


def _normalize_magic_color(value: str) -> str:
    aliases = {
        "white": "W",
        "blue": "U",
        "black": "B",
        "red": "R",
        "green": "G",
    }
    return aliases.get(value.strip().casefold(), value.strip().upper())


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


def _compact_card_for_model(card: CardSearchResult) -> dict[str, Any]:
    return {
        "scryfall_id": str(card.scryfall_id),
        "name": card.name,
        "mana_cost": card.mana_cost,
        "mana_value": card.mana_value,
        "type_line": card.type_line,
        "oracle_text": card.oracle_text,
        "color_identity": card.color_identity,
    }


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


def _page_from_stored(
    stored: _StoredAgentSearch,
    *,
    page: int,
    page_size: int,
) -> CardSearchPage:
    start = (page - 1) * page_size
    end = min(start + page_size, len(stored.cards))
    cards = list(stored.cards[start:end])
    return CardSearchPage(
        query=stored.query,
        page=page,
        total_results=len(stored.cards),
        has_more=end < len(stored.cards),
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
        debug=stored.debug if page == 1 else None,
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
    stages = [
        {
            "name": stage.name,
            "status": "ok",
            "duration_ms": stage.duration_ms or 0,
            "details": stage.payload,
        }
        for stage in trace.stages
    ]
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
                name=stage.name,
                status="ok",
                duration_ms=stage.duration_ms or 0,
            )
            for stage in trace.stages
        ],
        trace=record,
    )


def _load_json_response(body: bytes) -> object:
    try:
        return json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return body.decode("utf-8", errors="replace")


def _elapsed_ms(started: float) -> float:
    return round(max((perf_counter() - started) * 1_000, 0), 3)
