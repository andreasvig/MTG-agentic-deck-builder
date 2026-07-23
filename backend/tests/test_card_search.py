import asyncio
from collections.abc import Callable
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient

from mtg_deck_builder.api.cards import get_card_search_provider
from mtg_deck_builder.domain import CardSearchFilters, CardSearchPage, CardSearchQuery
from mtg_deck_builder.main import create_app
from mtg_deck_builder.providers import (
    CardSearchQueryError,
    CardSearchUnavailable,
    ScryfallCardSearchProvider,
)

SCRYFALL_ID = "d5d41bfc-6f17-42b5-b82e-3d99dbd608bd"
ORACLE_ID = "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f"
REVERSIBLE_SCRYFALL_ID = "3e3f0bcd-0796-494d-bf51-94b33c1671e9"
PROPAGANDA_ORACLE_ID = "6bb7d0df-7a9f-4e17-8c31-7628c4b12356"


def make_card_payload() -> dict[str, Any]:
    return {
        "object": "card",
        "id": SCRYFALL_ID,
        "oracle_id": ORACLE_ID,
        "name": "Delver of Secrets // Insectile Aberration",
        "layout": "transform",
        "mana_cost": None,
        "cmc": 1.0,
        "type_line": "Creature — Human Wizard // Creature — Human Insect",
        "oracle_text": None,
        "colors": ["U"],
        "color_identity": ["U"],
        "image_uris": None,
        "card_faces": [
            {
                "name": "Delver of Secrets",
                "mana_cost": "{U}",
                "type_line": "Creature — Human Wizard",
                "oracle_text": "At the beginning of your upkeep, look at the top card.",
                "colors": ["U"],
                "image_uris": {
                    "small": "https://cards.scryfall.io/small/front/example.jpg",
                    "normal": "https://cards.scryfall.io/normal/front/example.jpg",
                },
            },
            {
                "name": "Insectile Aberration",
                "mana_cost": "",
                "type_line": "Creature — Human Insect",
                "oracle_text": "Flying",
                "colors": ["U"],
                "image_uris": {
                    "small": "https://cards.scryfall.io/small/back/example.jpg",
                    "normal": "https://cards.scryfall.io/normal/back/example.jpg",
                },
            },
        ],
        "set": "mid",
        "set_name": "Innistrad: Midnight Hunt",
        "collector_number": "47",
        "rarity": "uncommon",
        "prices": {
            "usd": "0.15",
            "usd_foil": "0.25",
            "usd_etched": None,
            "eur": "0.12",
            "eur_foil": "0.20",
            "tix": "0.01",
        },
        "legalities": {
            "commander": "legal",
            "modern": "legal",
            "standard": "not_legal",
        },
        "finishes": ["nonfoil", "foil"],
        "scryfall_uri": "https://scryfall.com/card/mid/47/delver-of-secrets",
        "purchase_uris": {
            "cardmarket": "https://www.cardmarket.com/en/Magic/Products/Search?searchString=Delver",
        },
    }


def make_reversible_card_payload() -> dict[str, Any]:
    payload = make_card_payload()
    for face_only_field in (
        "oracle_id",
        "mana_cost",
        "cmc",
        "type_line",
        "oracle_text",
        "colors",
        "image_uris",
    ):
        payload.pop(face_only_field)

    payload.update(
        {
            "id": REVERSIBLE_SCRYFALL_ID,
            "name": "Propaganda // Propaganda",
            "layout": "reversible_card",
            "set": "sld",
            "set_name": "Secret Lair Drop",
            "collector_number": "279",
            "card_faces": [
                {
                    "oracle_id": PROPAGANDA_ORACLE_ID,
                    "name": "Propaganda",
                    "mana_cost": "{2}{U}",
                    "cmc": 3.0,
                    "type_line": "Enchantment",
                    "oracle_text": (
                        "Creatures can't attack you unless their controller pays {2} "
                        "for each creature they control that's attacking you."
                    ),
                    "colors": ["U"],
                    "image_uris": {
                        "small": "https://cards.scryfall.io/small/front/propaganda.jpg",
                        "normal": "https://cards.scryfall.io/normal/front/propaganda.jpg",
                    },
                },
                {
                    "oracle_id": PROPAGANDA_ORACLE_ID,
                    "name": "Propaganda",
                    "mana_cost": "{2}{U}",
                    "cmc": 3.0,
                    "type_line": "Enchantment",
                    "oracle_text": (
                        "Creatures can't attack you unless their controller pays {2} "
                        "for each creature they control that's attacking you."
                    ),
                    "colors": ["U"],
                    "image_uris": {
                        "small": "https://cards.scryfall.io/small/back/propaganda.jpg",
                        "normal": "https://cards.scryfall.io/normal/back/propaganda.jpg",
                    },
                },
            ],
        }
    )
    return payload


async def run_provider_search(
    handler: Callable[[httpx2.Request], httpx2.Response],
    query: CardSearchQuery | None = None,
) -> CardSearchPage:
    transport = httpx2.MockTransport(handler)
    async with httpx2.AsyncClient(
        base_url="https://api.scryfall.test",
        headers={
            "Accept": "application/json;q=0.9,*/*;q=0.8",
            "User-Agent": "MTG-Agentic-Deck-Builder/test",
        },
        transport=transport,
    ) as client:
        provider = ScryfallCardSearchProvider(client)
        return await provider.search(query or CardSearchQuery(q="delver", page=2))


def test_scryfall_provider_maps_printing_and_face_data() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/cards/search"
        assert request.url.params["q"] == "delver"
        assert request.url.params["page"] == "2"
        assert request.url.params["unique"] == "cards"
        assert request.url.params["order"] == "name"
        assert request.url.params["include_extras"] == "false"
        assert request.url.params["include_multilingual"] == "false"
        assert request.headers["accept"] == "application/json;q=0.9,*/*;q=0.8"
        assert request.headers["user-agent"] == "MTG-Agentic-Deck-Builder/test"
        return httpx2.Response(
            200,
            json={
                "object": "list",
                "total_cards": 201,
                "has_more": True,
                "data": [make_card_payload()],
                "warnings": ["The search included a deprecated alias."],
            },
        )

    result = asyncio.run(run_provider_search(handler))
    card = result.cards[0]

    assert result.query == "delver"
    assert result.page == 2
    assert result.total_results == 201
    assert result.has_more is True
    assert result.warnings == ["The search included a deprecated alias."]
    assert str(card.scryfall_id) == SCRYFALL_ID
    assert str(card.oracle_id) == ORACLE_ID
    assert card.set_code == "mid"
    assert card.collector_number == "47"
    assert str(card.prices.eur) == "0.12"
    assert card.legalities["commander"] == "legal"
    assert card.finishes == ["nonfoil", "foil"]
    assert card.image_uris is None
    assert len(card.card_faces) == 2
    assert str(card.card_faces[0].image_uris.normal).endswith("/front/example.jpg")
    assert str(card.cardmarket_url).startswith("https://www.cardmarket.com/")


def test_scryfall_provider_normalizes_reversible_card_from_first_face() -> None:
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            json={
                "object": "list",
                "total_cards": 1,
                "has_more": False,
                "data": [make_reversible_card_payload()],
            },
        )

    result = asyncio.run(
        run_provider_search(handler, CardSearchQuery(q="layout:reversible_card", page=1))
    )
    card = result.cards[0]

    assert str(card.scryfall_id) == REVERSIBLE_SCRYFALL_ID
    assert str(card.oracle_id) == PROPAGANDA_ORACLE_ID
    assert card.mana_cost == "{2}{U}"
    assert card.mana_value == 3.0
    assert card.type_line == "Enchantment"
    assert card.oracle_text.startswith("Creatures can't attack you")
    assert card.colors == ["U"]
    assert len(card.card_faces) == 2
    assert str(card.card_faces[0].image_uris.normal).endswith("/front/propaganda.jpg")
    assert str(card.card_faces[1].image_uris.normal).endswith("/back/propaganda.jpg")


def test_scryfall_not_found_becomes_empty_search_page() -> None:
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            404,
            json={
                "object": "error",
                "code": "not_found",
                "status": 404,
                "details": "Your query didn't match any cards.",
            },
        )

    result = asyncio.run(run_provider_search(handler, CardSearchQuery(q="no-such-card", page=1)))

    assert result == CardSearchPage(
        query="no-such-card",
        page=1,
        total_results=0,
        has_more=False,
        cards=[],
    )


@pytest.mark.parametrize("status_code", [400, 422])
def test_scryfall_bad_query_has_a_distinct_provider_error(status_code: int) -> None:
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            status_code,
            json={"object": "error", "code": "bad_request"},
        )

    with pytest.raises(CardSearchQueryError):
        asyncio.run(run_provider_search(handler))


@pytest.mark.parametrize("status_code", [403, 429, 500])
def test_scryfall_http_failure_is_provider_unavailable(status_code: int) -> None:
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status_code, json={"object": "error"})

    with pytest.raises(CardSearchUnavailable):
        asyncio.run(run_provider_search(handler))


def test_scryfall_timeout_is_provider_unavailable() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("Scryfall timed out", request=request)

    with pytest.raises(CardSearchUnavailable):
        asyncio.run(run_provider_search(handler))


def test_scryfall_malformed_success_is_provider_unavailable() -> None:
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"object": "list", "data": "not-a-list"})

    with pytest.raises(CardSearchUnavailable):
        asyncio.run(run_provider_search(handler))


class StubProvider:
    def __init__(self, outcome: CardSearchPage | Exception) -> None:
        self.outcome = outcome
        self.calls: list[CardSearchQuery] = []

    async def search(self, query: CardSearchQuery) -> CardSearchPage:
        self.calls.append(query)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def make_client(provider: StubProvider) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_card_search_provider] = lambda: provider
    return TestClient(app)


def test_search_endpoint_returns_typed_page() -> None:
    page = asyncio.run(
        run_provider_search(
            lambda _: httpx2.Response(
                200,
                json={
                    "object": "list",
                    "total_cards": 1,
                    "has_more": False,
                    "data": [make_card_payload()],
                },
            ),
            CardSearchQuery(q="delver", page=1),
        )
    )
    provider = StubProvider(page)

    with make_client(provider) as client:
        response = client.get("/api/v1/cards/search", params={"q": " delver ", "page": 1})

    assert response.status_code == 200
    assert response.json()["cards"][0]["scryfall_id"] == SCRYFALL_ID
    assert response.json()["cards"][0]["prices"]["eur"] == "0.12"
    assert provider.calls == [CardSearchQuery(q="delver", page=1)]


def test_search_endpoint_passes_structured_filters_to_provider() -> None:
    provider = StubProvider(
        CardSearchPage(
            query="red draw",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
        )
    )

    with make_client(provider) as client:
        response = client.get(
            "/api/v1/cards/search",
            params=[
                ("q", "red draw"),
                ("color", "R"),
                ("color", "B"),
                ("include_colorless", "true"),
                ("color_mode", "exact"),
                ("mana_min", "2"),
                ("mana_max", "5"),
                ("price_min", "0.25"),
                ("price_max", "12"),
            ],
        )

    assert response.status_code == 200
    assert provider.calls == [
        CardSearchQuery(
            q="red draw",
            page=1,
            filters=CardSearchFilters(
                colors=["R", "B"],
                include_colorless=True,
                color_mode="exact",
                mana_value_min=2,
                mana_value_max=5,
                price_eur_min="0.25",
                price_eur_max="12",
            ),
        )
    ]


@pytest.mark.parametrize(
    ("outcome", "expected_status", "expected_detail"),
    [
        (
            CardSearchQueryError(),
            400,
            {
                "code": "invalid_card_search",
                "message": "The card search query is not valid.",
            },
        ),
        (
            CardSearchUnavailable(),
            503,
            {
                "code": "card_search_unavailable",
                "message": "Card search is temporarily unavailable.",
            },
        ),
    ],
)
def test_search_endpoint_maps_provider_errors(
    outcome: Exception,
    expected_status: int,
    expected_detail: dict[str, str],
) -> None:
    with make_client(StubProvider(outcome)) as client:
        response = client.get("/api/v1/cards/search", params={"q": "bad query"})

    assert response.status_code == expected_status
    assert response.json() == {"detail": expected_detail}


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"q": ""},
        {"q": "   "},
        {"q": "x" * 501},
        {"q": "sol ring", "page": 0},
        {"q": "sol ring", "page": 1001},
        {"q": "sol ring", "mana_min": 4, "mana_max": 2},
        {"q": "sol ring", "price_min": 4, "price_max": 2},
    ],
)
def test_search_endpoint_validates_query_and_page(params: dict[str, str | int]) -> None:
    provider = StubProvider(
        CardSearchPage(
            query="unused",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
        )
    )

    with make_client(provider) as client:
        response = client.get("/api/v1/cards/search", params=params)

    assert response.status_code == 422
    assert provider.calls == []
