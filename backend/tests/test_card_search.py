from typing import Any

import pytest
from fastapi.testclient import TestClient

from mtg_deck_builder.api.cards import get_card_search_provider
from mtg_deck_builder.domain import CardSearchFilters, CardSearchPage, CardSearchQuery
from mtg_deck_builder.main import create_app
from mtg_deck_builder.providers import (
    CardSearchQueryError,
    CardSearchUnavailable,
    map_scryfall_card,
    name_similarity_score,
)

SCRYFALL_ID = "d5d41bfc-6f17-42b5-b82e-3d99dbd608bd"
ORACLE_ID = "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f"
REVERSIBLE_SCRYFALL_ID = "3e3f0bcd-0796-494d-bf51-94b33c1671e9"
PROPAGANDA_ORACLE_ID = "6bb7d0df-7a9f-4e17-8c31-7628c4b12356"


def test_title_similarity_covers_exact_partial_segment_and_typo_matches() -> None:
    assert name_similarity_score("forest", "Forest") == 1.0
    assert name_similarity_score("forest", "Forest Bear") == 0.9
    assert name_similarity_score("forest", "Forestfolk") == 0.9
    assert name_similarity_score("forest", "Misty Rainforest") == 0.9
    assert name_similarity_score("galta", "Ghalta") == 0.909091


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
                "power": "1",
                "toughness": "1",
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
                "power": "3",
                "toughness": "2",
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
            "cardmarket": (
                "https://www.cardmarket.com/en/Magic/Products/Search?searchString=Delver"
            ),
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

    face = {
        "oracle_id": PROPAGANDA_ORACLE_ID,
        "name": "Propaganda",
        "mana_cost": "{2}{U}",
        "cmc": 3.0,
        "type_line": "Enchantment",
        "oracle_text": (
            "Creatures can't attack you unless their controller pays {2} "
            "for each attacking creature."
        ),
        "colors": ["U"],
        "image_uris": {
            "small": "https://cards.scryfall.io/small/front/propaganda.jpg",
            "normal": "https://cards.scryfall.io/normal/front/propaganda.jpg",
        },
    }
    payload.update(
        {
            "id": REVERSIBLE_SCRYFALL_ID,
            "name": "Propaganda // Propaganda",
            "layout": "reversible_card",
            "set": "sld",
            "set_name": "Secret Lair Drop",
            "collector_number": "279",
            "card_faces": [face, face],
        }
    )
    return payload


def test_scryfall_card_mapper_preserves_printing_and_face_data() -> None:
    card = map_scryfall_card(make_card_payload())

    assert str(card.scryfall_id) == SCRYFALL_ID
    assert str(card.oracle_id) == ORACLE_ID
    assert card.set_code == "mid"
    assert card.collector_number == "47"
    assert str(card.prices.eur) == "0.12"
    assert card.legalities["commander"] == "legal"
    assert card.finishes == ["nonfoil", "foil"]
    assert card.image_uris is None
    assert len(card.card_faces) == 2
    assert card.power == "1"
    assert card.toughness == "1"
    assert card.card_faces[1].power == "3"
    assert card.card_faces[1].toughness == "2"
    assert str(card.card_faces[0].image_uris.normal).endswith("/front/example.jpg")
    assert str(card.cardmarket_url).startswith("https://www.cardmarket.com/")


def test_scryfall_card_mapper_normalizes_reversible_card_from_first_face() -> None:
    card = map_scryfall_card(make_reversible_card_payload())

    assert str(card.scryfall_id) == REVERSIBLE_SCRYFALL_ID
    assert str(card.oracle_id) == PROPAGANDA_ORACLE_ID
    assert card.mana_cost == "{2}{U}"
    assert card.mana_value == 3.0
    assert card.type_line == "Enchantment"
    assert card.oracle_text.startswith("Creatures can't attack you")
    assert card.colors == ["U"]
    assert len(card.card_faces) == 2


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
    card = map_scryfall_card(make_card_payload())
    provider = StubProvider(
        CardSearchPage(
            query="delver",
            page=1,
            total_results=1,
            has_more=False,
            cards=[card],
        )
    )

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
                ("debug", "true"),
            ],
        )

    assert response.status_code == 200
    assert provider.calls == [
        CardSearchQuery(
            q="red draw",
            page=1,
            debug=True,
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
                "message": "The card title could not be searched.",
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
