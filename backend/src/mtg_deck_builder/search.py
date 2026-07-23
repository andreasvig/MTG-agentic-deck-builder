"""Layered exact, fuzzy, semantic, and optional LLM-ranked card search."""

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass
from decimal import Decimal
from threading import Lock
from typing import Any, Protocol
from uuid import UUID

import httpx2

from mtg_deck_builder.domain import (
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
)
from mtg_deck_builder.providers import (
    FuzzyNameCandidate,
    ScryfallCardSearchProvider,
    name_similarity_score,
)
from mtg_deck_builder.search_debug import (
    JsonlSearchDebugLogger,
    SearchDebugTrace,
    stage_elapsed_ms,
    stage_started,
)

_LOGGER = logging.getLogger(__name__)
_SCRYFALL_SYNTAX = re.compile(
    r"(?:^|\s)[a-z][a-z0-9_-]*\s*(?::|[<>=])|"
    r"(?:^|\s)(?:OR|AND|NOT)(?:\s|$)|[()!]",
    re.IGNORECASE,
)
_COLOR_WORDS = {
    "white": "w",
    "blue": "u",
    "black": "b",
    "red": "r",
    "green": "g",
}
_TYPE_WORDS = {
    "artifact": "artifact",
    "artifacts": "artifact",
    "dinosaur": "dinosaur",
    "dinosaurs": "dinosaur",
    "dragon": "dragon",
    "dragons": "dragon",
    "elf": "elf",
    "elves": "elf",
    "enchantment": "enchantment",
    "enchantments": "enchantment",
    "instant": "instant",
    "instants": "instant",
    "land": "land",
    "lands": "land",
    "sorcery": "sorcery",
    "sorceries": "sorcery",
    "vampire": "vampire",
    "vampires": "vampire",
    "zombie": "zombie",
    "zombies": "zombie",
}


class CardRanker(Protocol):
    """Reorder a bounded candidate list for a natural-language query."""

    async def rank(
        self,
        query: str,
        cards: list[CardSearchResult],
    ) -> list[CardSearchResult]:
        """Return all candidates in relevance order."""


@dataclass(frozen=True)
class IntentPlan:
    """A deterministic candidate query and its user-facing interpretation."""

    scryfall_query: str
    interpretation: str


@dataclass(frozen=True)
class OpenRouterRankOutcome:
    """A completed ranking plus the full header-free HTTP exchange."""

    cards: list[CardSearchResult]
    exchange: dict[str, Any]


class OpenRouterRankError(RuntimeError):
    """Keep a failed OpenRouter exchange available to debug tracing."""

    def __init__(
        self,
        *,
        exchange: dict[str, Any],
        cause: BaseException,
    ) -> None:
        super().__init__("OpenRouter ranking failed")
        self.exchange = exchange
        self.cause_type = type(cause).__name__


class FastEmbedCardRanker:
    """Rank candidates with a Hugging Face embedding model running locally."""

    def __init__(self, model_name: str) -> None:
        self._model_name = model_name
        self._model: object | None = None
        self._model_lock = Lock()

    @property
    def model_name(self) -> str:
        return self._model_name

    async def rank(
        self,
        query: str,
        cards: list[CardSearchResult],
    ) -> list[CardSearchResult]:
        if len(cards) < 2:
            return cards
        return await asyncio.to_thread(self._rank_sync, query, cards)

    def _rank_sync(
        self,
        query: str,
        cards: list[CardSearchResult],
    ) -> list[CardSearchResult]:
        model = self._get_model()
        documents = [_card_search_document(card) for card in cards]
        vectors = list(model.embed([query, *documents]))  # type: ignore[attr-defined]
        query_vector = vectors[0]
        scores = [
            _cosine_similarity(query_vector, card_vector)
            for card_vector in vectors[1:]
        ]
        indexed = list(enumerate(cards))
        indexed.sort(key=lambda item: (-scores[item[0]], item[0]))
        return [card for _, card in indexed]

    def _get_model(self) -> object:
        with self._model_lock:
            if self._model is None:
                from fastembed import TextEmbedding

                self._model = TextEmbedding(model_name=self._model_name)
            return self._model


class OpenRouterCardReranker:
    """Use an OpenRouter chat model for a final bounded relevance pass."""

    def __init__(
        self,
        client: httpx2.AsyncClient,
        *,
        model: str,
        candidate_limit: int = 16,
        provider: str | None = None,
        reasoning_effort: str = "minimal",
        max_tokens: int = 900,
    ) -> None:
        self._client = client
        self._model = model
        self._candidate_limit = candidate_limit
        self._provider = provider
        self._reasoning_effort = reasoning_effort
        self._max_tokens = max_tokens

    @property
    def model_name(self) -> str:
        return self._model

    @property
    def candidate_limit(self) -> int:
        return self._candidate_limit

    @property
    def provider(self) -> str | None:
        return self._provider

    @property
    def reasoning_effort(self) -> str:
        return self._reasoning_effort

    @property
    def max_tokens(self) -> int:
        return self._max_tokens

    async def rank(
        self,
        query: str,
        cards: list[CardSearchResult],
    ) -> list[CardSearchResult]:
        return (await self.rank_with_trace(query, cards)).cards

    async def rank_with_trace(
        self,
        query: str,
        cards: list[CardSearchResult],
    ) -> OpenRouterRankOutcome:
        candidates = cards[: self._candidate_limit]
        if len(candidates) < 2:
            return OpenRouterRankOutcome(
                cards=cards,
                exchange={
                    "request": None,
                    "response": None,
                    "reason": "Fewer than two candidates.",
                },
            )

        request_body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Rank Magic: The Gathering cards for the user's deck-building "
                        "intent. Prefer direct mechanical relevance, then efficiency. "
                        "Return every supplied scryfall_id exactly once."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "intent": query,
                            "cards": [
                                {
                                    "scryfall_id": str(card.scryfall_id),
                                    "name": card.name,
                                    "mana_value": card.mana_value,
                                    "type_line": card.type_line,
                                    "oracle_text": card.oracle_text,
                                    "color_identity": card.color_identity,
                                    "price_eur": (
                                        str(card.prices.eur)
                                        if card.prices.eur is not None
                                        else None
                                    ),
                                }
                                for card in candidates
                            ],
                        },
                        ensure_ascii=True,
                        separators=(",", ":"),
                    ),
                },
            ],
            "reasoning": {
                "effort": self._reasoning_effort,
                "exclude": True,
            },
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "card_ranking",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {
                            "ordered_scryfall_ids": {
                                "type": "array",
                                "items": {"type": "string"},
                            }
                        },
                        "required": ["ordered_scryfall_ids"],
                        "additionalProperties": False,
                    },
                },
            },
            "temperature": 0,
            "max_tokens": self._max_tokens,
        }
        if self._provider is not None:
            request_body["provider"] = {
                "only": [self._provider],
                "allow_fallbacks": False,
                "require_parameters": True,
            }

        request_raw_body = json.dumps(
            request_body,
            ensure_ascii=True,
            separators=(",", ":"),
        )
        exchange: dict[str, Any] = {
            "request": {
                "method": "POST",
                "path": "/chat/completions",
                "body": request_body,
                "raw_body": request_raw_body,
            },
            "response": None,
        }
        try:
            response = await self._client.post(
                "/chat/completions",
                content=request_raw_body,
                headers={"Content-Type": "application/json"},
            )
            response_raw_body = response.text
            try:
                response_body: Any = response.json()
            except ValueError:
                response_body = None
            exchange["response"] = {
                "status_code": response.status_code,
                "body": response_body,
                "raw_body": response_raw_body,
            }
            response.raise_for_status()
            content = response_body["choices"][0]["message"]["content"]
            ranking = json.loads(content)["ordered_scryfall_ids"]

            by_id = {str(card.scryfall_id): card for card in candidates}
            ordered_ids = list(
                dict.fromkeys(card_id for card_id in ranking if card_id in by_id)
            )
            if not ordered_ids:
                raise ValueError("OpenRouter returned no recognized card identities")
            missing_ids = [card_id for card_id in by_id if card_id not in ordered_ids]
            ranked_cards = (
                [by_id[card_id] for card_id in [*ordered_ids, *missing_ids]]
                + cards[len(candidates) :]
            )
        except Exception as exc:
            if exchange["response"] is None:
                exchange["response"] = {
                    "status_code": None,
                    "body": None,
                    "raw_body": None,
                    "error_type": type(exc).__name__,
                }
            raise OpenRouterRankError(exchange=exchange, cause=exc) from exc

        return OpenRouterRankOutcome(cards=ranked_cards, exchange=exchange)


class HybridCardSearchProvider:
    """Choose a search layer and keep all transport details behind one boundary."""

    def __init__(
        self,
        scryfall: ScryfallCardSearchProvider,
        *,
        semantic_ranker: CardRanker | None = None,
        llm_ranker: CardRanker | None = None,
        debug_logger: JsonlSearchDebugLogger | None = None,
        debug_default_enabled: bool = True,
        fuzzy_candidate_limit: int = 12,
        fuzzy_min_score: float = 0.45,
    ) -> None:
        if fuzzy_candidate_limit < 2:
            raise ValueError("fuzzy_candidate_limit must be at least 2")
        if not 0 <= fuzzy_min_score <= 1:
            raise ValueError("fuzzy_min_score must be between 0 and 1")
        self._scryfall = scryfall
        self._semantic_ranker = semantic_ranker
        self._llm_ranker = llm_ranker
        self._debug_logger = debug_logger
        self._debug_default_enabled = debug_default_enabled
        self._fuzzy_candidate_limit = fuzzy_candidate_limit
        self._fuzzy_min_score = fuzzy_min_score

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        trace = (
            self._debug_logger.new_trace(
                query,
                configuration={
                    "semantic_ranker": _ranker_name(self._semantic_ranker),
                    "llm_ranker": _ranker_name(self._llm_ranker),
                    "llm_candidate_limit": getattr(
                        self._llm_ranker,
                        "candidate_limit",
                        None,
                    ),
                    "llm_provider": getattr(
                        self._llm_ranker,
                        "provider",
                        None,
                    ),
                    "llm_reasoning_effort": getattr(
                        self._llm_ranker,
                        "reasoning_effort",
                        None,
                    ),
                    "llm_max_tokens": getattr(
                        self._llm_ranker,
                        "max_tokens",
                        None,
                    ),
                    "fuzzy_candidate_limit": self._fuzzy_candidate_limit,
                    "fuzzy_min_score": self._fuzzy_min_score,
                },
            )
            if self._debug_logger is not None
            and (self._debug_default_enabled or query.debug)
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
        return page.model_copy(
            update={"debug": trace.summary(log_written=log_written)}
        )

    async def _search(
        self,
        query: CardSearchQuery,
        trace: SearchDebugTrace | None,
    ) -> CardSearchPage:
        if _is_scryfall_syntax(query.q):
            if trace is not None:
                trace.set_decision(input_kind="scryfall_syntax")
            return await self._search_syntax(query, trace)

        intent_started = stage_started()
        intent = compile_intent(query.q)
        if intent is not None:
            if trace is not None:
                trace.add_stage(
                    "Intent compilation",
                    status="ok",
                    duration_ms=stage_elapsed_ms(intent_started),
                    details={
                        "candidate_query": intent.scryfall_query,
                        "interpretation": intent.interpretation,
                    },
                )
                trace.set_decision(
                    input_kind="natural_language_intent",
                    candidate_query=intent.scryfall_query,
                )
            return await self._search_intent(query, intent, trace)

        if trace is not None:
            trace.add_stage(
                "Intent compilation",
                status="skipped",
                duration_ms=stage_elapsed_ms(intent_started),
                details={"reason": "No supported deck-building intent detected."},
            )
            trace.set_decision(input_kind="card_name")

        provider_query = CardSearchQuery(
            q=_join_query(
                _contained_name_query(query.q),
                "game:paper",
                compile_filter_query(query.filters),
            ),
            page=query.page,
        )
        exact_started = stage_started()
        provider_exact_page = await self._scryfall.search(provider_query)
        exact_cards = _sort_cards_by_name_score(
            provider_exact_page.cards,
            query.q,
        )
        exact_scores = _name_match_scores(exact_cards, query.q)
        exact_page = provider_exact_page.model_copy(
            update={
                "cards": exact_cards,
                "name_match_scores": exact_scores,
            }
        )
        has_full_name_match = any(
            _card_has_exact_name(card, query.q)
            for card in exact_page.cards
        )
        if trace is not None:
            trace.add_stage(
                "Contained name lookup",
                status="ok",
                duration_ms=stage_elapsed_ms(exact_started),
                output_cards=exact_page.cards,
                details={
                    "provider_query": provider_query.q,
                    "provider_order": provider_query.order,
                    "provider_total_results": exact_page.total_results,
                    "has_more": exact_page.has_more,
                    "full_name_found": has_full_name_match,
                    "name_matches": _name_match_details(
                        exact_page.cards,
                        exact_scores,
                        query.q,
                    ),
                },
            )
        if has_full_name_match or query.page > 1:
            if trace is not None:
                trace.set_decision(
                    strategy="exact",
                    name_match_kind=(
                        "full_name"
                        if has_full_name_match
                        else "contained_name"
                    ),
                    top_name_score=(
                        exact_scores.get(exact_page.cards[0].scryfall_id)
                        if exact_page.cards
                        else None
                    ),
                )
            return exact_page.model_copy(
                update={
                    "query": query.q,
                    "strategy": "exact",
                    "interpretation": f'Name contains "{query.q}"',
                }
            )

        fuzzy_started = stage_started()
        fuzzy_candidates = await self._scryfall.rank_fuzzy_names(
            query.q,
            limit=self._fuzzy_candidate_limit,
        )
        accepted_candidates = [
            candidate
            for candidate in fuzzy_candidates
            if candidate.score >= self._fuzzy_min_score
        ]
        fuzzy_page = await self._fetch_fuzzy_candidates(
            query,
            accepted_candidates,
        )
        candidate_by_name = {
            candidate.name.casefold(): candidate
            for candidate in accepted_candidates
        }
        fuzzy_cards = sorted(
            fuzzy_page.cards,
            key=lambda card: _fuzzy_card_order(card, candidate_by_name),
        )
        fuzzy_scores = {
            card.scryfall_id: candidate.score
            for card in fuzzy_cards
            if (
                candidate := candidate_by_name.get(card.name.casefold())
            )
            is not None
        }
        returned_names = {card.name.casefold() for card in fuzzy_cards}
        fuzzy_details = [
            {
                "name": candidate.name,
                "matched_alias": candidate.matched_alias,
                "score": candidate.score,
                "accepted_by_score": candidate.score >= self._fuzzy_min_score,
                "returned_after_filters": candidate.name.casefold()
                in returned_names,
            }
            for candidate in fuzzy_candidates
        ]
        top_score = (
            fuzzy_candidates[0].score if fuzzy_candidates else None
        )
        routing_signal = (
            "accept_name_match"
            if accepted_candidates
            else "intent_candidate"
        )
        if trace is not None:
            trace.add_stage(
                "Fuzzy name lookup",
                status="ok",
                duration_ms=stage_elapsed_ms(fuzzy_started),
                output_cards=fuzzy_cards,
                details={
                    "provider_query": (
                        fuzzy_page.query if accepted_candidates else None
                    ),
                    "candidate_limit": self._fuzzy_candidate_limit,
                    "fuzzy_cutoff": self._fuzzy_min_score,
                    "top_score": top_score,
                    "routing_signal": routing_signal,
                    "fuzzy_candidates": fuzzy_details,
                },
            )
            trace.set_decision(
                strategy="fuzzy",
                fuzzy_cutoff=self._fuzzy_min_score,
                fuzzy_top_score=top_score,
                fuzzy_routing_signal=routing_signal,
            )
        return CardSearchPage(
            query=query.q,
            page=1,
            total_results=len(fuzzy_cards),
            has_more=False,
            cards=fuzzy_cards,
            name_match_scores=fuzzy_scores,
            warnings=fuzzy_page.warnings,
            strategy="fuzzy",
            interpretation=(
                f"Closest card names above {self._fuzzy_min_score:.3f}"
                if accepted_candidates
                else None
            ),
        )

    async def _fetch_fuzzy_candidates(
        self,
        query: CardSearchQuery,
        candidates: list[FuzzyNameCandidate],
    ) -> CardSearchPage:
        if not candidates:
            return CardSearchPage(
                query=query.q,
                page=1,
                total_results=0,
                has_more=False,
                cards=[],
            )

        exact_names = " OR ".join(
            _exact_name_query(candidate.name)
            for candidate in candidates
        )
        provider_query = CardSearchQuery(
            q=_join_query(
                f"({exact_names})",
                "game:paper",
                compile_filter_query(query.filters),
            ),
            page=1,
        )
        return await self._scryfall.search(provider_query)

    async def _search_syntax(
        self,
        query: CardSearchQuery,
        trace: SearchDebugTrace | None,
    ) -> CardSearchPage:
        provider_query = CardSearchQuery(
            q=_join_query(query.q, compile_filter_query(query.filters)),
            page=query.page,
        )
        search_started = stage_started()
        page = await self._scryfall.search(provider_query)
        if trace is not None:
            trace.add_stage(
                "Scryfall syntax lookup",
                status="ok",
                duration_ms=stage_elapsed_ms(search_started),
                output_cards=page.cards,
                details={
                    "provider_query": provider_query.q,
                    "provider_order": provider_query.order,
                    "provider_total_results": page.total_results,
                    "has_more": page.has_more,
                },
            )
            trace.set_decision(strategy="syntax")
        return page.model_copy(
            update={
                "query": query.q,
                "strategy": "syntax",
                "interpretation": "Scryfall syntax",
            }
        )

    async def _search_intent(
        self,
        query: CardSearchQuery,
        intent: IntentPlan,
        trace: SearchDebugTrace | None,
    ) -> CardSearchPage:
        provider_query = CardSearchQuery(
            q=_join_query(
                intent.scryfall_query,
                "game:paper",
                compile_filter_query(query.filters),
            ),
            page=query.page,
            order="edhrec",
        )
        candidates_started = stage_started()
        page = await self._scryfall.search(provider_query)
        if trace is not None:
            trace.add_stage(
                "Scryfall intent candidates",
                status="ok",
                duration_ms=stage_elapsed_ms(candidates_started),
                output_cards=page.cards,
                details={
                    "provider_query": provider_query.q,
                    "provider_order": provider_query.order,
                    "provider_total_results": page.total_results,
                    "has_more": page.has_more,
                },
            )
        cards = page.cards
        warnings = list(page.warnings)
        reranked = False

        if cards and self._semantic_ranker is not None:
            semantic_input = cards
            semantic_started = stage_started()
            try:
                cards = await self._semantic_ranker.rank(query.q, cards)
                reranked = len(cards) > 1
                if trace is not None:
                    trace.add_stage(
                        "Local semantic ranking",
                        status="ok",
                        duration_ms=stage_elapsed_ms(semantic_started),
                        input_cards=semantic_input,
                        output_cards=cards,
                        details={"model": _ranker_name(self._semantic_ranker)},
                    )
            except Exception as exc:
                _LOGGER.warning(
                    "Local semantic ranking failed (%s): %s",
                    type(exc).__name__,
                    exc,
                )
                if trace is not None:
                    trace.add_stage(
                        "Local semantic ranking",
                        status="error",
                        duration_ms=stage_elapsed_ms(semantic_started),
                        input_cards=semantic_input,
                        output_cards=semantic_input,
                        details={"error_type": type(exc).__name__},
                    )
                warnings.append(
                    "Local semantic ranking was unavailable; results use Scryfall order."
                )
        elif trace is not None:
            trace.add_stage(
                "Local semantic ranking",
                status="skipped",
                duration_ms=0,
                input_cards=cards,
                output_cards=cards,
                details={
                    "reason": "No candidates."
                    if not cards
                    else "No semantic ranker configured."
                },
            )

        if cards and self._llm_ranker is not None:
            llm_input = cards
            llm_started = stage_started()
            try:
                exchange = None
                if isinstance(self._llm_ranker, OpenRouterCardReranker):
                    outcome = await self._llm_ranker.rank_with_trace(query.q, cards)
                    cards = outcome.cards
                    exchange = outcome.exchange
                else:
                    cards = await self._llm_ranker.rank(query.q, cards)
                reranked = len(cards) > 1
                if trace is not None:
                    trace.add_stage(
                        "OpenRouter ranking",
                        status="ok",
                        duration_ms=stage_elapsed_ms(llm_started),
                        input_cards=llm_input,
                        output_cards=cards,
                        details={
                            "model": _ranker_name(self._llm_ranker),
                            "candidate_limit": getattr(
                                self._llm_ranker,
                                "candidate_limit",
                                None,
                            ),
                            "provider": getattr(
                                self._llm_ranker,
                                "provider",
                                None,
                            ),
                            "reasoning_effort": getattr(
                                self._llm_ranker,
                                "reasoning_effort",
                                None,
                            ),
                            "max_tokens": getattr(
                                self._llm_ranker,
                                "max_tokens",
                                None,
                            ),
                            "exchange": exchange,
                        },
                    )
            except Exception as exc:
                _LOGGER.warning(
                    "OpenRouter reranking failed (%s): %s",
                    type(exc).__name__,
                    exc,
                )
                if trace is not None:
                    details: dict[str, Any] = {
                        "error_type": (
                            exc.cause_type
                            if isinstance(exc, OpenRouterRankError)
                            else type(exc).__name__
                        )
                    }
                    if isinstance(exc, OpenRouterRankError):
                        details["exchange"] = exc.exchange
                    trace.add_stage(
                        "OpenRouter ranking",
                        status="error",
                        duration_ms=stage_elapsed_ms(llm_started),
                        input_cards=llm_input,
                        output_cards=llm_input,
                        details=details,
                    )
                warnings.append(
                    "The optional AI reranker was unavailable; local results are shown."
                )
        elif trace is not None:
            trace.add_stage(
                "OpenRouter ranking",
                status="skipped",
                duration_ms=0,
                input_cards=cards,
                output_cards=cards,
                details={
                    "reason": "No candidates."
                    if not cards
                    else "No OpenRouter ranker configured."
                },
            )

        if trace is not None:
            trace.set_decision(strategy="intent")
        return page.model_copy(
            update={
                "query": query.q,
                "cards": cards,
                "warnings": warnings,
                "strategy": "intent",
                "interpretation": intent.interpretation,
                "reranked": reranked,
            }
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


def compile_filter_query(filters: CardSearchFilters) -> str:
    """Translate structured UI filters into composable Scryfall clauses."""

    clauses: list[str] = []
    color_code = "".join(color.lower() for color in filters.colors)
    if filters.color_mode == "exact":
        identities = []
        if color_code:
            identities.append(f"id={color_code}")
        if filters.include_colorless:
            identities.append("id=c")
        if identities:
            clauses.append(
                identities[0] if len(identities) == 1 else f"({' OR '.join(identities)})"
            )
    elif color_code:
        clauses.append(f"id<={color_code}")
        if not filters.include_colorless:
            clauses.append("-id=c")
    elif filters.include_colorless:
        clauses.append("id=c")

    if filters.mana_value_min is not None:
        clauses.append(f"mv>={filters.mana_value_min:g}")
    if filters.mana_value_max is not None:
        clauses.append(f"mv<={filters.mana_value_max:g}")
    if filters.price_eur_min is not None:
        clauses.append(f"eur>={_format_decimal(filters.price_eur_min)}")
    if filters.price_eur_max is not None:
        clauses.append(f"eur<={_format_decimal(filters.price_eur_max)}")
    return " ".join(clauses)


def compile_intent(query: str) -> IntentPlan | None:
    """Compile common deck-building language into a broad candidate query."""

    normalized = query.casefold()
    clauses: list[str] = []
    labels: list[str] = []

    if "ramp" in normalized:
        clauses.append(
            '(o:"add" OR o:"search your library for a land" OR o:"put a land card")'
        )
        labels.append("mana acceleration")
    if "draw" in normalized or "card advantage" in normalized:
        clauses.append(
            '(o:"draw a card" OR o:"draw two cards" OR o:"exile the top card")'
        )
        labels.append("card advantage")
    if "game ender" in normalized or "finisher" in normalized:
        clauses.append(
            '(o:"win the game" OR o:"loses the game" OR '
            'o:"each opponent loses" OR o:"damage to each opponent")'
        )
        labels.append("game-ending effects")
    if "untap" in normalized:
        clauses.append("o:untap")
        labels.append("untap effects")
    if (
        "+1/+1" in normalized
        or re.search(r"\+?1\s+\+?1", normalized)
        or ("counter" in normalized and ("double" in normalized or "doubl" in normalized))
    ):
        clauses.append(
            '(o:"+1/+1 counter" AND (o:twice OR o:double OR o:additional))'
        )
        labels.append("+1/+1 counter multiplication")

    words = set(re.findall(r"[a-z]+", normalized))
    matched_type = next(
        (
            (word, card_type)
            for word, card_type in _TYPE_WORDS.items()
            if word in words
        ),
        None,
    )
    card_type = matched_type[1] if matched_type is not None else None
    refers_to_owned_type = (
        matched_type is not None and f"my {matched_type[0]}" in normalized
    )
    if card_type is not None and not refers_to_owned_type:
        clauses.append(f"t:{card_type}")
        labels.append(f"{card_type} cards")
    if "cheap" in words or ("low" in words and "cost" in words):
        clauses.append("mv<=3")
        labels.append("mana value 3 or less")

    colors = [code for name, code in _COLOR_WORDS.items() if name in words]
    if colors:
        color_code = "".join(colors)
        clauses.append(f"id<={color_code}")
        if "colorless" not in words:
            clauses.append("-id=c")
        color_labels = [name for name in _COLOR_WORDS if name in words]
        if "colorless" in words:
            color_labels.append("colorless")
        labels.append("/".join(color_labels) + " identity")
    elif "colorless" in words:
        clauses.append("id=c")
        labels.append("colorless identity")

    functional_intent = any(
        marker in labels
        for marker in (
            "mana acceleration",
            "card advantage",
            "game-ending effects",
            "untap effects",
            "+1/+1 counter multiplication",
        )
    )
    if not labels or (
        not functional_intent and not ("cheap" in words and card_type is not None)
    ):
        return None

    return IntentPlan(
        scryfall_query=" ".join(clauses),
        interpretation=", ".join(dict.fromkeys(labels)).capitalize(),
    )


def card_matches_filters(card: CardSearchResult, filters: CardSearchFilters) -> bool:
    """Apply structured filters to the single-card fuzzy fallback."""

    identity = set(card.color_identity)
    allowed = set(filters.colors)
    if allowed or filters.include_colorless:
        if filters.color_mode == "exact":
            valid_identity = identity == allowed or (
                filters.include_colorless and not identity
            )
        else:
            valid_identity = identity.issubset(allowed) and (
                bool(identity) or filters.include_colorless
            )
        if not valid_identity:
            return False

    if filters.mana_value_min is not None and card.mana_value < filters.mana_value_min:
        return False
    if filters.mana_value_max is not None and card.mana_value > filters.mana_value_max:
        return False

    price = card.prices.eur
    if filters.price_eur_min is not None and (
        price is None or price < filters.price_eur_min
    ):
        return False
    return not (
        filters.price_eur_max is not None
        and (price is None or price > filters.price_eur_max)
    )


def _is_scryfall_syntax(query: str) -> bool:
    return bool(_SCRYFALL_SYNTAX.search(query))


def _contained_name_query(query: str) -> str:
    escaped = re.escape(query).replace("/", r"\/")
    return f"name:/{escaped}/"


def _exact_name_query(query: str) -> str:
    escaped = query.replace("\\", "\\\\").replace('"', '\\"')
    return f'!"{escaped}"'


def _card_name_score(card: CardSearchResult, query: str) -> float:
    names = [card.name, *(face.name for face in card.card_faces)]
    return max(name_similarity_score(query, name) for name in names)


def _sort_cards_by_name_score(
    cards: list[CardSearchResult],
    query: str,
) -> list[CardSearchResult]:
    return sorted(
        cards,
        key=lambda card: (
            -_card_name_score(card, query),
            card.name.casefold(),
        ),
    )


def _name_match_scores(
    cards: list[CardSearchResult],
    query: str,
) -> dict[UUID, float]:
    return {
        card.scryfall_id: _card_name_score(card, query)
        for card in cards
    }


def _name_match_details(
    cards: list[CardSearchResult],
    scores: dict[UUID, float],
    query: str,
) -> list[dict[str, Any]]:
    return [
        {
            "name": card.name,
            "score": scores[card.scryfall_id],
            "match_kind": (
                "full_name"
                if _card_has_exact_name(card, query)
                else "contained_name"
            ),
        }
        for card in cards
    ]


def _fuzzy_card_order(
    card: CardSearchResult,
    candidates: dict[str, FuzzyNameCandidate],
) -> tuple[int, float, str]:
    candidate = candidates.get(card.name.casefold())
    if candidate is None:
        return (1, 0, card.name.casefold())
    return (0, -candidate.score, card.name.casefold())


def _card_has_exact_name(card: CardSearchResult, query: str) -> bool:
    expected = query.casefold()
    names = [card.name, *(face.name for face in card.card_faces)]
    return any(name.casefold() == expected for name in names)


def _join_query(*parts: str) -> str:
    return " ".join(part for part in parts if part)


def _ranker_name(ranker: CardRanker | None) -> str | None:
    if ranker is None:
        return None
    return str(getattr(ranker, "model_name", type(ranker).__name__))


def _format_decimal(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _card_search_document(card: CardSearchResult) -> str:
    tags: list[str] = []
    oracle_text = card.oracle_text or " ".join(
        face.oracle_text or "" for face in card.card_faces
    )
    oracle_lower = oracle_text.casefold()
    if card.mana_value <= 3:
        tags.append("cheap low mana value")
    if "draw" in oracle_lower or "exile the top card" in oracle_lower:
        tags.append("card draw card advantage")
    if "add {" in oracle_lower or "search your library for a land" in oracle_lower:
        tags.append("mana ramp acceleration")
    if "untap" in oracle_lower:
        tags.append("untap synergy")
    if "+1/+1 counter" in oracle_lower:
        tags.append("+1/+1 counter synergy")
    if (
        "win the game" in oracle_lower
        or "loses the game" in oracle_lower
        or "each opponent" in oracle_lower
    ):
        tags.append("game ender finisher")
    colors = " ".join(
        name for name, code in _COLOR_WORDS.items() if code.upper() in card.color_identity
    )
    if not colors:
        colors = "colorless"
    return " | ".join(
        [
            card.name,
            colors,
            f"mana value {card.mana_value:g}",
            card.type_line,
            oracle_text,
            " ".join(tags),
        ]
    )


def _cosine_similarity(left: object, right: object) -> float:
    left_values = [float(value) for value in left]  # type: ignore[union-attr]
    right_values = [float(value) for value in right]  # type: ignore[union-attr]
    dot = sum(a * b for a, b in zip(left_values, right_values, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left_values))
    right_norm = math.sqrt(sum(value * value for value in right_values))
    if left_norm == 0 or right_norm == 0:
        return 0
    return dot / (left_norm * right_norm)
