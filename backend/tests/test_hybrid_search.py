import asyncio
import json
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import httpx2

from mtg_deck_builder.domain import (
    CardPrices,
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
)
from mtg_deck_builder.providers import FuzzyNameCandidate
from mtg_deck_builder.search import (
    HybridCardSearchProvider,
    OpenRouterCardReranker,
    card_matches_filters,
    compile_filter_query,
    compile_intent,
)
from mtg_deck_builder.search_debug import JsonlSearchDebugLogger


def make_card(
    name: str = "Forest",
    *,
    scryfall_id: str = "d5d41bfc-6f17-42b5-b82e-3d99dbd608bd",
    colors: list[str] | None = None,
    mana_value: float = 0,
    price_eur: str | None = "0.12",
) -> CardSearchResult:
    identity = colors or []
    return CardSearchResult(
        oracle_id=UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f"),
        scryfall_id=UUID(scryfall_id),
        name=name,
        layout="normal",
        mana_cost=None,
        mana_value=mana_value,
        type_line="Basic Land — Forest",
        oracle_text="({T}: Add {G}.)",
        colors=identity,
        color_identity=identity,
        image_uris=None,
        card_faces=[],
        set_code="fdn",
        set_name="Foundations",
        collector_number="281",
        rarity="common",
        prices=CardPrices(eur=Decimal(price_eur) if price_eur else None),
        legalities={"commander": "legal"},
        finishes=["nonfoil"],
        scryfall_url="https://scryfall.com/card/fdn/281/forest",
    )


class StubScryfall:
    def __init__(
        self,
        pages: list[CardSearchPage],
        fuzzy_candidates: list[FuzzyNameCandidate] | None = None,
    ) -> None:
        self.pages = pages
        self.fuzzy_candidates = fuzzy_candidates or []
        self.search_calls: list[CardSearchQuery] = []
        self.fuzzy_calls: list[str] = []

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        self.search_calls.append(query)
        return self.pages.pop(0)

    async def rank_fuzzy_names(
        self,
        name: str,
        *,
        limit: int,
    ) -> list[FuzzyNameCandidate]:
        self.fuzzy_calls.append(name)
        return self.fuzzy_candidates[:limit]


class ReverseRanker:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[str]]] = []

    async def rank(
        self,
        query: str,
        cards: list[CardSearchResult],
    ) -> list[CardSearchResult]:
        self.calls.append((query, [card.name for card in cards]))
        return list(reversed(cards))


def empty_page(query: str = "unused") -> CardSearchPage:
    return CardSearchPage(
        query=query,
        page=1,
        total_results=0,
        has_more=False,
        cards=[],
    )


def test_structured_filters_compile_to_scryfall_clauses() -> None:
    filters = CardSearchFilters(
        colors=["U", "R"],
        include_colorless=True,
        color_mode="exact",
        mana_value_min=2,
        mana_value_max=5,
        price_eur_min=Decimal("0.25"),
        price_eur_max=Decimal("12.00"),
    )

    assert compile_filter_query(filters) == (
        "(id=ur OR id=c) mv>=2 mv<=5 eur>=0.25 eur<=12"
    )

    subset = filters.model_copy(
        update={"color_mode": "subset", "include_colorless": False}
    )
    assert compile_filter_query(subset).startswith("id<=ur -id=c")


def test_fuzzy_filtering_uses_color_mana_value_and_eur_price() -> None:
    card = make_card(colors=["G"], mana_value=3, price_eur="1.25")
    assert card_matches_filters(
        card,
        CardSearchFilters(
            colors=["G"],
            color_mode="exact",
            mana_value_min=2,
            mana_value_max=4,
            price_eur_min=Decimal("1"),
            price_eur_max=Decimal("2"),
        ),
    )
    assert not card_matches_filters(
        card,
        CardSearchFilters(colors=["U"], color_mode="exact"),
    )


def test_example_intents_compile_to_broad_candidate_queries() -> None:
    examples = {
        "blue/colorless ramp": ("o:", "id<=u"),
        "red card draw": ("draw", "id<=r"),
        "cheap dinosaurs": ("t:dinosaur", "mv<=3"),
        "game enders": ("win the game", "each opponent"),
        "things which let me untap my elves": ("o:untap",),
        "doubling +1 +1": ('o:"+1/+1 counter"', "o:double"),
    }

    for query, expected_fragments in examples.items():
        plan = compile_intent(query)
        assert plan is not None, query
        assert all(
            fragment in plan.scryfall_query for fragment in expected_fragments
        ), query


def test_exact_name_layer_returns_and_scores_contained_names() -> None:
    forest = make_card(colors=["G"])
    forest_bear = make_card(
        "Forest Bear",
        scryfall_id="3e3f0bcd-0796-494d-bf51-94b33c1671e9",
        colors=["G"],
    )
    scryfall = StubScryfall(
        [
            CardSearchPage(
                query="name:/forest/",
                page=1,
                total_results=2,
                has_more=False,
                cards=[forest_bear, forest],
            )
        ]
    )
    provider = HybridCardSearchProvider(scryfall)  # type: ignore[arg-type]

    result = asyncio.run(provider.search(CardSearchQuery(q="forest")))

    assert scryfall.search_calls[0].q == "name:/forest/ game:paper"
    assert scryfall.fuzzy_calls == []
    assert result.cards == [forest, forest_bear]
    assert result.strategy == "exact"
    assert result.interpretation == 'Name contains "forest"'
    assert result.name_match_scores[forest.scryfall_id] == 1
    assert result.name_match_scores[forest_bear.scryfall_id] == 0.705882


def test_hybrid_search_returns_multiple_fuzzy_names_above_cutoff() -> None:
    forest = make_card(colors=["G"])
    forest_bear = make_card(
        "Forest Bear",
        scryfall_id="3e3f0bcd-0796-494d-bf51-94b33c1671e9",
        colors=["G"],
    )
    scryfall = StubScryfall(
        [
            empty_page(),
            CardSearchPage(
                query="fuzzy candidates",
                page=1,
                total_results=2,
                has_more=False,
                cards=[forest_bear, forest],
            ),
        ],
        fuzzy_candidates=[
            FuzzyNameCandidate(
                name="Forest",
                matched_alias="forest",
                score=0.909091,
            ),
            FuzzyNameCandidate(
                name="Forest Bear",
                matched_alias="forest bear",
                score=0.625,
            ),
            FuzzyNameCandidate(
                name="Frost",
                matched_alias="frost",
                score=0.4,
            ),
        ],
    )
    provider = HybridCardSearchProvider(  # type: ignore[arg-type]
        scryfall,
        fuzzy_min_score=0.45,
    )

    result = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="foret",
                filters=CardSearchFilters(
                    colors=["G"],
                    include_colorless=False,
                ),
            )
        )
    )

    assert scryfall.search_calls[0].q == (
        "name:/foret/ game:paper id<=g -id=c"
    )
    assert scryfall.search_calls[1].q == (
        '(!"Forest" OR !"Forest Bear") game:paper id<=g -id=c'
    )
    assert scryfall.fuzzy_calls == ["foret"]
    assert result.cards == [forest, forest_bear]
    assert result.strategy == "fuzzy"
    assert result.interpretation == "Closest card names above 0.450"
    assert result.name_match_scores == {
        forest.scryfall_id: 0.909091,
        forest_bear.scryfall_id: 0.625,
    }


def test_contained_partial_does_not_block_stronger_fuzzy_layer() -> None:
    forest = make_card()
    as_foretold = make_card(
        "As Foretold",
        scryfall_id="3e3f0bcd-0796-494d-bf51-94b33c1671e9",
    )
    scryfall = StubScryfall(
        [
            CardSearchPage(
                query="name:/foret/",
                page=1,
                total_results=1,
                has_more=False,
                cards=[as_foretold],
            ),
            CardSearchPage(
                query="fuzzy candidates",
                page=1,
                total_results=1,
                has_more=False,
                cards=[forest],
            ),
        ],
        fuzzy_candidates=[
            FuzzyNameCandidate(
                name="Forest",
                matched_alias="forest",
                score=0.909091,
            ),
        ],
    )
    provider = HybridCardSearchProvider(scryfall)  # type: ignore[arg-type]

    result = asyncio.run(provider.search(CardSearchQuery(q="foret")))

    assert result.strategy == "fuzzy"
    assert result.cards == [forest]
    assert result.name_match_scores[forest.scryfall_id] == 0.909091


def test_intent_results_are_locally_ranked() -> None:
    first = make_card("Mana Rock")
    second = make_card(
        "Cultivate",
        scryfall_id="3e3f0bcd-0796-494d-bf51-94b33c1671e9",
        colors=["G"],
        mana_value=3,
    )
    scryfall = StubScryfall(
        [
            CardSearchPage(
                query="provider query",
                page=1,
                total_results=2,
                has_more=False,
                cards=[first, second],
            )
        ]
    )
    ranker = ReverseRanker()
    provider = HybridCardSearchProvider(  # type: ignore[arg-type]
        scryfall,
        semantic_ranker=ranker,
    )

    result = asyncio.run(provider.search(CardSearchQuery(q="green ramp")))

    assert "o:" in scryfall.search_calls[0].q
    assert "id<=g" in scryfall.search_calls[0].q
    assert "game:paper" in scryfall.search_calls[0].q
    assert scryfall.search_calls[0].order == "edhrec"
    assert [card.name for card in result.cards] == ["Cultivate", "Mana Rock"]
    assert result.strategy == "intent"
    assert result.reranked is True
    assert ranker.calls == [("green ramp", ["Mana Rock", "Cultivate"])]


def test_debug_mode_returns_summary_and_writes_layer_ordering(
    tmp_path: Path,
) -> None:
    first = make_card("Mana Rock")
    second = make_card(
        "Cultivate",
        scryfall_id="3e3f0bcd-0796-494d-bf51-94b33c1671e9",
        colors=["G"],
        mana_value=3,
    )
    log_path = tmp_path / "search-debug.jsonl"
    scryfall = StubScryfall(
        [
            CardSearchPage(
                query="provider query",
                page=1,
                total_results=2,
                has_more=False,
                cards=[first, second],
            )
        ]
    )
    provider = HybridCardSearchProvider(  # type: ignore[arg-type]
        scryfall,
        semantic_ranker=ReverseRanker(),
        debug_logger=JsonlSearchDebugLogger(log_path, result_limit=10),
    )

    result = asyncio.run(provider.search(CardSearchQuery(q="green ramp")))

    assert result.debug is not None
    assert result.debug.log_written is True
    assert result.debug.log_path == str(log_path)
    assert [stage.name for stage in result.debug.stages] == [
        "Intent compilation",
        "Scryfall intent candidates",
        "Local semantic ranking",
        "OpenRouter ranking",
    ]
    assert result.debug.stages[2].input_count == 2
    assert result.debug.stages[2].output_count == 2
    assert result.debug.stages[3].status == "skipped"

    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert result.debug.trace == record
    assert record["trace_id"] == str(result.debug.trace_id)
    assert record["request"]["query"] == "green ramp"
    assert record["decision"]["strategy"] == "intent"
    assert record["stages"][1]["details"]["provider_order"] == "edhrec"
    semantic_stage = record["stages"][2]
    assert [card["name"] for card in semantic_stage["input"]["top"]] == [
        "Mana Rock",
        "Cultivate",
    ]
    assert [card["name"] for card in semantic_stage["output"]["top"]] == [
        "Cultivate",
        "Mana Rock",
    ]
    assert semantic_stage["rank_changes"][0] == {
        "scryfall_id": str(second.scryfall_id),
        "name": "Cultivate",
        "before_rank": 2,
        "after_rank": 1,
        "delta": 1,
    }
    assert record["result"]["returned"]["top"][0]["name"] == "Cultivate"
    assert "api_key" not in lines[0].casefold()
    assert "authorization" not in lines[0].casefold()


def test_debug_mode_logs_exact_and_fuzzy_layer_decisions(tmp_path: Path) -> None:
    forest = make_card(colors=["G"])
    log_path = tmp_path / "search-debug.jsonl"
    scryfall = StubScryfall(
        [
            empty_page(),
            CardSearchPage(
                query="fuzzy candidates",
                page=1,
                total_results=1,
                has_more=False,
                cards=[forest],
            ),
        ],
        fuzzy_candidates=[
            FuzzyNameCandidate(
                name="Forest",
                matched_alias="forest",
                score=0.909091,
            ),
            FuzzyNameCandidate(
                name="Frost",
                matched_alias="frost",
                score=0.4,
            ),
        ],
    )
    provider = HybridCardSearchProvider(  # type: ignore[arg-type]
        scryfall,
        debug_logger=JsonlSearchDebugLogger(log_path),
    )

    result = asyncio.run(provider.search(CardSearchQuery(q="foret")))

    assert result.debug is not None
    records = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(records) == 1
    assert records[0]["decision"]["input_kind"] == "card_name"
    assert records[0]["decision"]["strategy"] == "fuzzy"
    assert records[0]["decision"]["fuzzy_cutoff"] == 0.45
    assert records[0]["decision"]["fuzzy_routing_signal"] == (
        "accept_name_match"
    )
    assert [stage["name"] for stage in records[0]["stages"]] == [
        "Intent compilation",
        "Contained name lookup",
        "Fuzzy name lookup",
    ]
    fuzzy_details = records[0]["stages"][2]["details"]
    assert fuzzy_details["fuzzy_cutoff"] == 0.45
    assert fuzzy_details["top_score"] == 0.909091
    assert fuzzy_details["routing_signal"] == "accept_name_match"
    assert fuzzy_details["fuzzy_candidates"] == [
        {
            "name": "Forest",
            "matched_alias": "forest",
            "score": 0.909091,
            "accepted_by_score": True,
            "returned_after_filters": True,
        },
        {
            "name": "Frost",
            "matched_alias": "frost",
            "score": 0.4,
            "accepted_by_score": False,
            "returned_after_filters": False,
        },
    ]


def test_search_debug_can_be_enabled_for_one_request(tmp_path: Path) -> None:
    log_path = tmp_path / "search-debug.jsonl"
    scryfall = StubScryfall([empty_page(), empty_page()])
    provider = HybridCardSearchProvider(  # type: ignore[arg-type]
        scryfall,
        debug_logger=JsonlSearchDebugLogger(log_path),
        debug_default_enabled=False,
    )

    async def run() -> tuple[CardSearchPage, CardSearchPage]:
        plain = await provider.search(CardSearchQuery(q="green ramp"))
        traced = await provider.search(
            CardSearchQuery(q="green ramp", debug=True)
        )
        return plain, traced

    plain, traced = asyncio.run(run())

    assert plain.debug is None
    assert traced.debug is not None
    records = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
    ]
    assert len(records) == 1
    assert records[0]["request"]["debug"] is True


def test_openrouter_reranker_uses_configured_routing_and_validates_order() -> None:
    first = make_card("Mana Rock")
    second = make_card(
        "Cultivate",
        scryfall_id="3e3f0bcd-0796-494d-bf51-94b33c1671e9",
        colors=["G"],
        mana_value=3,
    )

    def handler(request: httpx2.Request) -> httpx2.Response:
        payload = json.loads(request.content)
        assert payload["model"] == "google/gemini-3.5-flash"
        assert payload["reasoning"] == {"effort": "low", "exclude": True}
        assert payload["provider"] == {
            "only": ["Cerebras"],
            "allow_fallbacks": False,
            "require_parameters": True,
        }
        assert payload["max_tokens"] == 1_800
        ordered = [str(second.scryfall_id), str(first.scryfall_id)]
        return httpx2.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(
                {"ordered_scryfall_ids": ordered}
            )}}]},
        )

    async def run() -> list[CardSearchResult]:
        async with httpx2.AsyncClient(
            base_url="https://openrouter.test/api/v1",
            transport=httpx2.MockTransport(handler),
        ) as client:
            ranker = OpenRouterCardReranker(
                client,
                model="google/gemini-3.5-flash",
                provider="Cerebras",
                reasoning_effort="low",
                max_tokens=1_800,
            )
            return await ranker.rank("green ramp", [first, second])

    ranked = asyncio.run(run())
    assert [card.name for card in ranked] == ["Cultivate", "Mana Rock"]


def test_openrouter_debug_trace_contains_full_request_and_response(
    tmp_path: Path,
) -> None:
    first = make_card("Mana Rock")
    second = make_card(
        "Cultivate",
        scryfall_id="3e3f0bcd-0796-494d-bf51-94b33c1671e9",
        colors=["G"],
        mana_value=3,
    )
    ordered = [str(second.scryfall_id), str(first.scryfall_id)]
    openrouter_response = {
        "id": "generation-123",
        "model": "openai/gpt-oss-120b",
        "provider": "Cerebras",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": json.dumps({"ordered_scryfall_ids": ordered}),
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 250,
            "completion_tokens": 35,
            "total_tokens": 285,
        },
    }

    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=openrouter_response)

    async def run() -> CardSearchPage:
        scryfall = StubScryfall(
            [
                CardSearchPage(
                    query="provider query",
                    page=1,
                    total_results=2,
                    has_more=False,
                    cards=[first, second],
                )
            ]
        )
        async with httpx2.AsyncClient(
            base_url="https://openrouter.test/api/v1",
            transport=httpx2.MockTransport(handler),
        ) as client:
            return await HybridCardSearchProvider(  # type: ignore[arg-type]
                scryfall,
                llm_ranker=OpenRouterCardReranker(
                    client,
                    model="openai/gpt-oss-120b",
                    provider="Cerebras",
                    reasoning_effort="low",
                ),
                debug_logger=JsonlSearchDebugLogger(
                    tmp_path / "search-debug.jsonl"
                ),
            ).search(CardSearchQuery(q="green ramp"))

    result = asyncio.run(run())
    assert result.debug is not None
    record = json.loads(
        (tmp_path / "search-debug.jsonl").read_text(encoding="utf-8")
    )
    llm_stage = next(
        stage
        for stage in record["stages"]
        if stage["name"] == "OpenRouter ranking"
    )
    exchange = llm_stage["details"]["exchange"]
    request = exchange["request"]
    response = exchange["response"]

    assert request["method"] == "POST"
    assert request["path"] == "/chat/completions"
    assert json.loads(request["raw_body"]) == request["body"]
    assert request["body"]["model"] == "openai/gpt-oss-120b"
    assert request["body"]["reasoning"]["effort"] == "low"
    assert request["body"]["provider"]["only"] == ["Cerebras"]
    sent_prompt = json.loads(request["body"]["messages"][1]["content"])
    assert sent_prompt["intent"] == "green ramp"
    assert [card["name"] for card in sent_prompt["cards"]] == [
        "Mana Rock",
        "Cultivate",
    ]
    assert response["status_code"] == 200
    assert json.loads(response["raw_body"]) == response["body"]
    assert response["body"] == openrouter_response
    serialized = json.dumps(record).casefold()
    assert "authorization" not in serialized
    assert "api_key" not in serialized
