"""Layered exact, fuzzy, semantic, and optional LLM-ranked card search."""

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass
from decimal import Decimal
from threading import Lock
from typing import Protocol

import httpx2

from mtg_deck_builder.domain import (
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
)
from mtg_deck_builder.providers import ScryfallCardSearchProvider

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


class FastEmbedCardRanker:
    """Rank candidates with a Hugging Face embedding model running locally."""

    def __init__(self, model_name: str) -> None:
        self._model_name = model_name
        self._model: object | None = None
        self._model_lock = Lock()

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
    ) -> None:
        self._client = client
        self._model = model
        self._candidate_limit = candidate_limit

    async def rank(
        self,
        query: str,
        cards: list[CardSearchResult],
    ) -> list[CardSearchResult]:
        candidates = cards[: self._candidate_limit]
        if len(candidates) < 2:
            return cards

        response = await self._client.post(
            "/chat/completions",
            json={
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
                            }
                        ),
                    },
                ],
                "reasoning": {"effort": "minimal", "exclude": True},
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
                "max_tokens": 900,
            },
        )
        response.raise_for_status()
        payload = response.json()
        content = payload["choices"][0]["message"]["content"]
        ranking = json.loads(content)["ordered_scryfall_ids"]

        by_id = {str(card.scryfall_id): card for card in candidates}
        ordered_ids = list(
            dict.fromkeys(card_id for card_id in ranking if card_id in by_id)
        )
        if not ordered_ids:
            raise ValueError("OpenRouter returned no recognized card identities")
        missing_ids = [card_id for card_id in by_id if card_id not in ordered_ids]
        return (
            [by_id[card_id] for card_id in [*ordered_ids, *missing_ids]]
            + cards[len(candidates) :]
        )


class HybridCardSearchProvider:
    """Choose a search layer and keep all transport details behind one boundary."""

    def __init__(
        self,
        scryfall: ScryfallCardSearchProvider,
        *,
        semantic_ranker: CardRanker | None = None,
        llm_ranker: CardRanker | None = None,
    ) -> None:
        self._scryfall = scryfall
        self._semantic_ranker = semantic_ranker
        self._llm_ranker = llm_ranker

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        if _is_scryfall_syntax(query.q):
            return await self._search_syntax(query)

        intent = compile_intent(query.q)
        if intent is not None:
            return await self._search_intent(query, intent)

        exact_page = await self._scryfall.search(
            CardSearchQuery(
                q=_join_query(
                    _exact_name_query(query.q),
                    "game:paper",
                    compile_filter_query(query.filters),
                ),
                page=query.page,
            )
        )
        if exact_page.cards or query.page > 1:
            corrected_name = (
                exact_page.cards[0].name
                if exact_page.cards
                and not any(
                    _card_has_exact_name(card, query.q)
                    for card in exact_page.cards
                )
                else None
            )
            return exact_page.model_copy(
                update={
                    "query": query.q,
                    "strategy": "fuzzy" if corrected_name else "exact",
                    "interpretation": (
                        f"Closest card name: {corrected_name}"
                        if corrected_name
                        else "Exact card name"
                    ),
                }
            )

        fuzzy_card = await self._scryfall.find_fuzzy(query.q)
        fuzzy_cards = (
            [fuzzy_card]
            if fuzzy_card is not None and card_matches_filters(fuzzy_card, query.filters)
            else []
        )
        return CardSearchPage(
            query=query.q,
            page=1,
            total_results=len(fuzzy_cards),
            has_more=False,
            cards=fuzzy_cards,
            strategy="fuzzy",
            interpretation=(
                f"Closest card name: {fuzzy_card.name}" if fuzzy_card is not None else None
            ),
        )

    async def _search_syntax(self, query: CardSearchQuery) -> CardSearchPage:
        page = await self._scryfall.search(
            CardSearchQuery(
                q=_join_query(query.q, compile_filter_query(query.filters)),
                page=query.page,
            )
        )
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
    ) -> CardSearchPage:
        page = await self._scryfall.search(
            CardSearchQuery(
                q=_join_query(
                    intent.scryfall_query,
                    "game:paper",
                    compile_filter_query(query.filters),
                ),
                page=query.page,
                order="edhrec",
            )
        )
        cards = page.cards
        warnings = list(page.warnings)
        reranked = False

        if cards and self._semantic_ranker is not None:
            try:
                cards = await self._semantic_ranker.rank(query.q, cards)
                reranked = len(cards) > 1
            except Exception as exc:
                _LOGGER.warning(
                    "Local semantic ranking failed (%s): %s",
                    type(exc).__name__,
                    exc,
                )
                warnings.append(
                    "Local semantic ranking was unavailable; results use Scryfall order."
                )

        if cards and self._llm_ranker is not None:
            try:
                cards = await self._llm_ranker.rank(query.q, cards)
                reranked = len(cards) > 1
            except Exception as exc:
                _LOGGER.warning(
                    "OpenRouter reranking failed (%s): %s",
                    type(exc).__name__,
                    exc,
                )
                warnings.append(
                    "The optional AI reranker was unavailable; local results are shown."
                )

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


def _exact_name_query(query: str) -> str:
    escaped = query.replace("\\", "\\\\").replace('"', '\\"')
    return f'!"{escaped}"'


def _card_has_exact_name(card: CardSearchResult, query: str) -> bool:
    expected = query.casefold()
    names = [card.name, *(face.name for face in card.card_faces)]
    return any(name.casefold() == expected for name in names)


def _join_query(*parts: str) -> str:
    return " ".join(part for part in parts if part)


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
