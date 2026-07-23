import asyncio
import json
from decimal import Decimal
from uuid import UUID

import httpx2

from mtg_deck_builder.domain import (
    CardPrices,
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardSearchResult,
)
from mtg_deck_builder.search import (
    HybridCardSearchProvider,
    OpenRouterCardReranker,
    card_matches_filters,
    compile_filter_query,
    compile_intent,
)


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
        fuzzy_card: CardSearchResult | None = None,
    ) -> None:
        self.pages = pages
        self.fuzzy_card = fuzzy_card
        self.search_calls: list[CardSearchQuery] = []
        self.fuzzy_calls: list[str] = []

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        self.search_calls.append(query)
        return self.pages.pop(0)

    async def find_fuzzy(self, name: str) -> CardSearchResult | None:
        self.fuzzy_calls.append(name)
        return self.fuzzy_card


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


def test_hybrid_search_uses_exact_then_fuzzy_name_layers() -> None:
    forest = make_card(colors=["G"])
    scryfall = StubScryfall([empty_page()], fuzzy_card=forest)
    provider = HybridCardSearchProvider(scryfall)  # type: ignore[arg-type]

    result = asyncio.run(
        provider.search(
            CardSearchQuery(
                q="foret",
                filters=CardSearchFilters(colors=["G"], include_colorless=False),
            )
        )
    )

    assert scryfall.search_calls[0].q == '!"foret" game:paper id<=g -id=c'
    assert scryfall.fuzzy_calls == ["foret"]
    assert result.cards == [forest]
    assert result.strategy == "fuzzy"
    assert result.interpretation == "Closest card name: Forest"


def test_scryfall_corrected_exact_result_is_reported_as_fuzzy() -> None:
    forest = make_card(colors=["G"])
    scryfall = StubScryfall(
        [
            CardSearchPage(
                query='!"foret"',
                page=1,
                total_results=1,
                has_more=False,
                cards=[forest],
            )
        ]
    )
    provider = HybridCardSearchProvider(scryfall)  # type: ignore[arg-type]

    result = asyncio.run(provider.search(CardSearchQuery(q="foret")))

    assert scryfall.fuzzy_calls == []
    assert result.strategy == "fuzzy"
    assert result.interpretation == "Closest card name: Forest"


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


def test_openrouter_reranker_uses_minimal_reasoning_and_validates_order() -> None:
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
        assert payload["reasoning"] == {"effort": "minimal", "exclude": True}
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
            )
            return await ranker.rank("green ramp", [first, second])

    ranked = asyncio.run(run())
    assert [card.name for card in ranked] == ["Cultivate", "Mana Rock"]
