from uuid import UUID

from fastapi.testclient import TestClient

from mtg_deck_builder.api.cards import get_card_catalog, get_tagger_catalog
from mtg_deck_builder.domain import (
    CardEnrichment,
    CardPrices,
    CardSearchResult,
    CardTag,
    CardTagMatch,
    RelatedOracleCard,
)
from mtg_deck_builder.main import create_app
from mtg_deck_builder.providers import CardSearchUnavailable
from mtg_deck_builder.tagger_catalog import TaggerCatalogUnavailable

CITY_ID = UUID("f25351e3-539b-4bbc-b92d-6480acf4d722")
MANA_ID = UUID("ad45e515-4f39-4188-9b2e-f8cfef7ac0d0")


class StubTaggerCatalog:
    def card_enrichment(self, oracle_id: UUID) -> CardEnrichment:
        return CardEnrichment(
            oracle_id=oracle_id,
            tags=[
                CardTag(
                    id="tag-rainbow",
                    name="rainbow land",
                    slug="rainbow-land",
                    description="Lands that make any color.",
                ),
            ],
            similar_cards=[
                RelatedOracleCard(oracle_id=MANA_ID, name="Mana Confluence"),
            ],
        )

    def search_tags(self, query: str, *, limit: int) -> list[CardTagMatch]:
        assert query == "rainbo"
        assert limit == 5
        return [
            CardTagMatch(
                id="tag-rainbow",
                name="rainbow land",
                slug="rainbow-land",
                description="Lands that make any color.",
                match_score=0.94,
            )
        ]


class UnavailableTaggerCatalog:
    def card_enrichment(self, oracle_id: UUID) -> CardEnrichment:
        raise TaggerCatalogUnavailable(str(oracle_id))


def make_card() -> CardSearchResult:
    return CardSearchResult(
        oracle_id=MANA_ID,
        scryfall_id=UUID("c3c5d5eb-925f-4d32-9b8f-3451c6284c4f"),
        name="Mana Confluence",
        layout="normal",
        mana_cost="",
        mana_value=0,
        type_line="Land",
        oracle_text="{T}, Pay 1 life: Add one mana of any color.",
        power=None,
        toughness=None,
        colors=[],
        color_identity=["W", "U", "B", "R", "G"],
        image_uris=None,
        card_faces=[],
        set_code="jou",
        set_name="Journey into Nyx",
        collector_number="163",
        rarity="rare",
        prices=CardPrices(eur="18.00"),
        legalities={"commander": "legal"},
        finishes=["nonfoil"],
        scryfall_url="https://scryfall.com/card/jou/163/mana-confluence",
    )


class StubCardCatalog:
    async def card_by_oracle_id(self, oracle_id: str) -> CardSearchResult | None:
        return make_card() if oracle_id == str(MANA_ID) else None


class UnavailableCardCatalog:
    async def card_by_oracle_id(self, oracle_id: str) -> CardSearchResult | None:
        raise CardSearchUnavailable(oracle_id)


def test_card_enrichment_endpoint_returns_grouped_local_tagger_data() -> None:
    app = create_app()
    app.dependency_overrides[get_tagger_catalog] = StubTaggerCatalog

    with TestClient(app) as client:
        response = client.get(f"/api/v1/cards/{CITY_ID}/enrichment")

    assert response.status_code == 200
    assert response.json() == {
        "oracle_id": str(CITY_ID),
        "tags": [
            {
                "id": "tag-rainbow",
                "name": "rainbow land",
                "slug": "rainbow-land",
                "description": "Lands that make any color.",
            },
        ],
        "similar_cards": [
            {"oracle_id": str(MANA_ID), "name": "Mana Confluence"},
        ],
        "references": [],
        "referenced_by": [],
    }


def test_card_enrichment_endpoint_has_a_stable_unavailable_response() -> None:
    app = create_app()
    app.dependency_overrides[get_tagger_catalog] = UnavailableTaggerCatalog

    with TestClient(app) as client:
        response = client.get(f"/api/v1/cards/{CITY_ID}/enrichment")

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "card_enrichment_unavailable",
        "message": "Card tags and relationships are not available yet.",
    }


def test_tag_search_endpoint_returns_fuzzy_local_matches() -> None:
    app = create_app()
    app.dependency_overrides[get_tagger_catalog] = StubTaggerCatalog

    with TestClient(app) as client:
        response = client.get(
            "/api/v1/cards/tags/search",
            params={"q": "rainbo", "limit": 5},
        )

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": "tag-rainbow",
            "name": "rainbow land",
            "slug": "rainbow-land",
            "description": "Lands that make any color.",
            "match_score": 0.94,
        }
    ]


def test_canonical_card_endpoint_supports_related_card_navigation() -> None:
    app = create_app()
    app.dependency_overrides[get_card_catalog] = StubCardCatalog

    with TestClient(app) as client:
        found = client.get(f"/api/v1/cards/{MANA_ID}")
        missing = client.get(f"/api/v1/cards/{CITY_ID}")

    assert found.status_code == 200
    assert found.json()["name"] == "Mana Confluence"
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "card_not_found"


def test_canonical_card_endpoint_maps_catalog_unavailability() -> None:
    app = create_app()
    app.dependency_overrides[get_card_catalog] = UnavailableCardCatalog

    with TestClient(app) as client:
        response = client.get(f"/api/v1/cards/{MANA_ID}")

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "card_search_unavailable",
        "message": "Card search is temporarily unavailable.",
    }
