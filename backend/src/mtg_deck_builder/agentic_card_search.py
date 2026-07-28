"""Progressive one-tool agentic card search."""

from __future__ import annotations

import asyncio
import json
from collections import Counter
from dataclasses import dataclass
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
    SearchDebugStage,
    SearchDebugSummary,
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
)

_TOOL_CALL_ADAPTER = TypeAdapter(AgentSearchToolCall)


@dataclass(frozen=True)
class ExecutedSearchTool:
    """One bounded tool result ready to return to the final model call."""

    name: str
    arguments: dict[str, Any]
    candidates: tuple[AgentSearchCandidate, ...]
    payload: dict[str, Any]


class AgenticCardSearchUnavailable(CardSearchUnavailable):
    """An agentic failure with an optional sanitized trace for debug clients."""

    def __init__(self, debug: SearchDebugSummary | None = None) -> None:
        super().__init__()
        self.debug = debug


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
            raise AgentSearchContractError("semantic Oracle-text retrieval is not enabled")
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
        self._sessions = sessions or AgenticSearchSessionStore()

    async def search(self, request: AgenticCardSearchRequest) -> CardSearchPage:
        """Start a new agent run or page through a stored completed ranking."""

        if request.search_session_id is not None:
            return await self._page_stored_search(request)
        if request.page != 1:
            raise CardSearchQueryError

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
                "preview_candidates": [
                    _numbered_candidate_payload(
                        candidate_id,
                        card,
                        already_shown=True,
                    )
                    for candidate_id, card in enumerate(preview.cards, start=1)
                ],
            }
        )
        try:
            completed = await self._run_agent(request, preview, trace)
        except asyncio.CancelledError as exc:
            await self._persist_failed_trace(trace, exc, trace_enabled)
            raise
        except Exception as exc:
            debug = await self._persist_failed_trace(trace, exc, trace_enabled)
            if isinstance(exc, CardSearchQueryError):
                raise
            raise AgenticCardSearchUnavailable(debug) from exc

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
            warnings=(),
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
        tools = _tool_definitions()
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    self._settings.system_prompt
                    + "\n\nIMPORTANT RUNTIME CAPABILITIES: semantic embeddings are "
                    "disabled. Do not use semantic_query. search_local_cards is the "
                    "only available tool. It supports structured name, Oracle text, "
                    "mana, type, color, power, toughness, price, format, set, and "
                    'rarity filters. "types" and "colors" are nested objects, never '
                    "strings."
                ),
            },
            {
                "role": "user",
                "content": _render_initial_user_message(request, preview.cards),
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
        executed = await self._local_tool.search(
            tool_call.arguments,
            immutable_filters=request.filters,
        )
        tool_duration_ms = _elapsed_ms(started)

        union = _candidate_union(preview.cards, executed.candidates)
        preview_oracle_ids = {card.oracle_id for card in preview.cards}
        numbered_candidates = [
            _numbered_candidate_payload(
                candidate_id,
                card,
                already_shown=card.oracle_id in preview_oracle_ids,
            )
            for candidate_id, card in enumerate(union, start=1)
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
        ranked_ids = validate_final_ranking(
            output,
            candidate_ids=range(1, len(union) + 1),
            max_candidate_count=self._page_size + self._settings.max_tool_results,
        )
        ranked_cards = tuple(union[candidate_id - 1] for candidate_id in ranked_ids)
        omitted_ids = sorted(set(range(1, len(union) + 1)) - set(ranked_ids))
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
                "description": (
                    "Search the complete local MTG catalog with exact structured "
                    "conditions. All fields are optional. Duplicate exact values "
                    "to require multiple occurrences. Use numeric power and "
                    "toughness ranges for descriptions such as big, large, or "
                    "high power. Semantic Oracle-text search is unavailable while "
                    "embeddings are disabled; use exact Oracle-text conditions. "
                    "types and colors must be nested objects, never strings."
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


def _numbered_candidate_payload(
    candidate_id: int,
    card: CardSearchResult,
    *,
    already_shown: bool,
) -> dict[str, Any]:
    """Build the compact, URL-free card shape used in agent messages and traces."""

    return {
        "id": candidate_id,
        "already_shown": already_shown,
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


def _render_initial_user_message(
    request: AgenticCardSearchRequest,
    preview_cards: list[CardSearchResult],
) -> str:
    """Render the user's search as short natural text without provider fields."""

    lines = [
        "Please find Magic: The Gathering cards for this request:",
        f'"{request.q}"',
        "",
        "Filters already chosen in the interface:",
        *_render_filter_lines(request.filters),
        "",
    ]
    if preview_cards:
        lines.append("The fuzzy title search has already shown these selectable cards to the user:")
        for candidate_id, card in enumerate(preview_cards, start=1):
            lines.extend(_render_preview_candidate(candidate_id, card))
        lines.extend(
            [
                (
                    "These IDs are already valid final choices, even if the tool "
                    "does not return the cards again."
                ),
                (
                    "New tool results receive later, non-overlapping IDs. If the "
                    "tool returns the exact same Oracle card, it keeps the existing "
                    "ID instead of becoming a duplicate."
                ),
            ]
        )
    else:
        lines.append("No fuzzy title matches have been shown to the user yet.")
    lines.extend(
        [
            "",
            (
                "Call exactly one search tool now. Wait for its result before "
                "producing the final ranking."
            ),
        ]
    )
    return "\n".join(lines)


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
    lines: list[str] = []
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
    return lines or ["- None"]


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
    """Return the exact concise plain-text tool message sent to the final model."""

    lines = [
        "The search tool has finished.",
        f"Tool used: {executed.name}",
        f"Candidate count: {len(candidates)}",
        (
            "Candidate IDs are temporary numbers for this search only. Cards marked "
            "ALREADY SHOWN were visible to the user before this tool finished."
        ),
        "",
    ]
    for candidate in candidates:
        card = candidate["card"]
        shown = " [ALREADY SHOWN]" if candidate["already_shown"] else ""
        colors = ", ".join(card["color_identity"]) or "colorless"
        lines.extend(
            [
                f"ID {candidate['id']}{shown}",
                f"Name: {card['name']}",
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
    lines.extend(
        [
            (
                "Return the relevant candidate IDs in best-first order. You may "
                "omit any candidate that does not meaningfully match the request."
            ),
            "Never invent an ID.",
        ]
    )
    return "\n".join(lines)


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
    messages = (
        initial_request.payload.get("messages")
        if initial_request is not None
        else None
    )
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
        _trace_response_message(final_response.payload)
        if final_response is not None
        else {}
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
                    validation.payload.get("ranked_ids")
                    if validation is not None
                    else []
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
            details = {
                "reason": "Not reached because an earlier agentic-search step failed."
            }
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
