from typing import Any

import pytest
from fastapi.testclient import TestClient

from mtg_deck_builder.agentic_card_search import AgenticCardSearchUnavailable
from mtg_deck_builder.api.cards import (
    get_card_catalog,
    get_card_search_provider,
    get_edhrec_service,
    get_tagger_catalog,
)
from mtg_deck_builder.card_catalog import CatalogEntry, card_title_aliases
from mtg_deck_builder.domain import (
    AgenticCardSearchRequest,
    CardSearchFilters,
    CardSearchPage,
    CardSearchQuery,
    CardTagFilter,
    EdhrecCommanderContext,
    SearchDebugSummary,
)
from mtg_deck_builder.edhrec_catalog import (
    EdhrecCommanderContext as InternalEdhrecCommanderContext,
)
from mtg_deck_builder.main import create_app
from mtg_deck_builder.providers import (
    CardSearchQueryError,
    CardSearchUnavailable,
    map_scryfall_card,
    name_similarity_score,
)
from mtg_deck_builder.providers.edhrec import EdhrecDeckTheme

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


class FailingAgenticSearch:
    def __init__(
        self,
        debug: SearchDebugSummary,
        *,
        contract_error: bool = False,
    ) -> None:
        self.debug = debug
        self.contract_error = contract_error

    async def search(self, _request: object) -> CardSearchPage:
        raise AgenticCardSearchUnavailable(
            self.debug,
            contract_error=self.contract_error,
        )


class CapturingAgenticSearch:
    def __init__(self) -> None:
        self.calls: list[AgenticCardSearchRequest] = []

    async def search(self, request: AgenticCardSearchRequest) -> CardSearchPage:
        self.calls.append(request)
        return CardSearchPage(
            query=request.q,
            page=request.page,
            total_results=0,
            has_more=False,
            cards=[],
            strategy="agentic",
        )


class StubTaggerFilters:
    def tag_filters(self, tag_ids: list[str]) -> list[CardTagFilter]:
        assert tag_ids == ["tag-elf"]
        return [CardTagFilter(id="tag-elf", name="elf typal")]


class StubCardCatalog:
    def __init__(self, entries: tuple[CatalogEntry, ...]) -> None:
        self._entries = entries

    async def entries(self) -> tuple[CatalogEntry, ...]:
        return self._entries


def make_client(
    provider: StubProvider,
    *,
    tagger_catalog: object | None = None,
) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_card_search_provider] = lambda: provider
    if tagger_catalog is not None:
        app.dependency_overrides[get_tagger_catalog] = lambda: tagger_catalog
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
                ("include_non_commander_legal", "true"),
                ("include_outside_commander_identity", "true"),
                ("commander_color", "R"),
                ("commander_color", "B"),
                ("commander_identity_known", "true"),
                ("card_type", "Artifact"),
                ("card_type", "Creature"),
                ("subtype", "Human"),
                ("subtype", "Wizard"),
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
                include_non_commander_legal=True,
                include_outside_commander_color_identity=True,
                commander_color_identity=["R", "B"],
                card_types=["Artifact", "Creature"],
                subtypes=["Human", "Wizard"],
                mana_value_min=2,
                mana_value_max=5,
                price_eur_min="0.25",
                price_eur_max="12",
            ),
        )
    ]


def test_search_endpoint_preserves_a_colorless_commander_identity() -> None:
    provider = StubProvider(
        CardSearchPage(
            query="artifact",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
        )
    )

    with make_client(provider) as client:
        response = client.get(
            "/api/v1/cards/search",
            params={
                "q": "artifact",
                "commander_identity_known": "true",
            },
        )

    assert response.status_code == 200
    assert provider.calls == [
        CardSearchQuery(
            q="artifact",
            filters=CardSearchFilters(commander_color_identity=[]),
        )
    ]


def test_search_endpoint_passes_edhrec_enhancement_context_to_provider() -> None:
    provider = StubProvider(
        CardSearchPage(
            query="",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
        )
    )

    with make_client(provider) as client:
        response = client.get(
            "/api/v1/cards/search",
            params={
                "q": "",
                "commander_oracle_id": ORACLE_ID,
                "enhance_with_edhrec": "true",
                "edhrec_theme": "tokens",
            },
        )

    assert response.status_code == 200
    assert provider.calls == [
        CardSearchQuery(
            q="",
            commander_oracle_id=ORACLE_ID,
            enhance_with_edhrec=True,
            edhrec_theme="tokens",
        )
    ]
    assert response.json()["edhrec"] == {
        "status": "not_requested",
        "source": None,
        "message": None,
    }


def test_commander_edhrec_endpoint_returns_available_theme_choices() -> None:
    class StubEdhrecContextService:
        async def context_for(self, _oracle_id: object) -> InternalEdhrecCommanderContext:
            return InternalEdhrecCommanderContext(
                commander_oracle_id=ORACLE_ID,  # type: ignore[arg-type]
                commander_name="Ghalta, Primal Hunger",
                themes=(
                    EdhrecDeckTheme(slug="stompy", name="Stompy", deck_count=239),
                    EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=12),
                ),
                source="cache",
            )

    provider = StubProvider(
        CardSearchPage(
            query="",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
        )
    )
    app = create_app()
    app.dependency_overrides[get_card_search_provider] = lambda: provider
    app.dependency_overrides[get_edhrec_service] = lambda: StubEdhrecContextService()

    with TestClient(app) as client:
        response = client.get(f"/api/v1/cards/{ORACLE_ID}/edhrec")

    assert response.status_code == 200
    context = EdhrecCommanderContext.model_validate(response.json())
    assert context.status == "applied"
    assert context.commander_name == "Ghalta, Primal Hunger"
    assert [(theme.slug, theme.deck_count) for theme in context.themes] == [
        ("stompy", 239),
        ("tokens", 12),
    ]


def test_search_endpoint_resolves_selected_tags_to_immutable_filters() -> None:
    provider = StubProvider(
        CardSearchPage(
            query="elves",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
        )
    )

    with make_client(provider, tagger_catalog=StubTaggerFilters()) as client:
        response = client.get(
            "/api/v1/cards/search",
            params={"q": "elves", "tag": "tag-elf"},
        )

    assert response.status_code == 200
    assert provider.calls == [
        CardSearchQuery(
            q="elves",
            filters=CardSearchFilters(
                tags=[CardTagFilter(id="tag-elf", name="elf typal")],
            ),
        )
    ]


def test_agentic_endpoint_canonicalizes_immutable_tag_filters() -> None:
    app = create_app()
    service = CapturingAgenticSearch()
    app.dependency_overrides[get_tagger_catalog] = StubTaggerFilters

    with TestClient(app) as client:
        client.app.state.agentic_card_search = service
        response = client.post(
            "/api/v1/cards/search/agentic",
            json={
                "q": "untapping elves",
                "filters": {
                    "include_non_commander_legal": False,
                    "include_outside_commander_color_identity": False,
                    "commander_color_identity": ["G"],
                    "tags": [{"id": "tag-elf", "name": "untrusted label"}],
                    "card_types": ["Creature"],
                    "subtypes": ["Elf", "Druid"],
                },
            },
        )

    assert response.status_code == 200, response.text
    assert service.calls[0].filters == CardSearchFilters(
        commander_color_identity=["G"],
        tags=[CardTagFilter(id="tag-elf", name="elf typal")],
        card_types=["Creature"],
        subtypes=["Elf", "Druid"],
    )


def test_subtype_endpoint_fuzzy_ranks_local_printed_subtypes() -> None:
    app = create_app()
    card = map_scryfall_card(make_card_payload())
    app.dependency_overrides[get_card_catalog] = lambda: StubCardCatalog(
        (
            CatalogEntry(
                card=card,
                aliases=card_title_aliases(card),
            ),
        )
    )

    with TestClient(app) as client:
        response = client.get(
            "/api/v1/cards/subtypes/search",
            params={"q": "wizrd"},
        )

    assert response.status_code == 200, response.text
    assert response.json()[0] == {
        "name": "Wizard",
        "match_score": pytest.approx(0.909091),
    }


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


def test_agentic_error_response_includes_the_failed_trace_in_debug_mode() -> None:
    debug = SearchDebugSummary(
        trace_id=SCRYFALL_ID,
        log_path="local-data/search-debug.jsonl",
        log_written=True,
        total_duration_ms=12.5,
        stages=[],
        trace={"result": {"status": "error"}},
    )
    app = create_app()
    with TestClient(app) as client:
        client.app.state.agentic_card_search = FailingAgenticSearch(debug)
        response = client.post(
            "/api/v1/cards/search/agentic",
            json={"q": "green big creatures", "debug": True},
        )

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == "agentic_search_unavailable"
    assert detail["message"] == "Agentic card search is temporarily unavailable."
    assert detail["debug"]["trace_id"] == SCRYFALL_ID
    assert detail["debug"]["trace"]["result"]["status"] == "error"


def test_agentic_contract_error_has_truthful_public_message() -> None:
    debug = SearchDebugSummary(
        trace_id=SCRYFALL_ID,
        log_path="local-data/search-debug.jsonl",
        log_written=True,
        total_duration_ms=12.5,
        stages=[],
        trace={"result": {"status": "error"}},
    )
    app = create_app()
    with TestClient(app) as client:
        client.app.state.agentic_card_search = FailingAgenticSearch(
            debug,
            contract_error=True,
        )
        response = client.post(
            "/api/v1/cards/search/agentic",
            json={"q": "forest liek cards", "debug": True},
        )

    assert response.status_code == 502
    detail = response.json()["detail"]
    assert detail["code"] == "agentic_search_contract_error"
    assert detail["message"] == (
        "The search agent returned invalid search parameters. Please try again."
    )
    assert detail["debug"]["trace_id"] == SCRYFALL_ID


@pytest.mark.parametrize(
    "params",
    [
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


@pytest.mark.parametrize("params", [{}, {"q": ""}, {"q": "   "}])
def test_search_endpoint_accepts_blank_titles_for_filter_only_searches(
    params: dict[str, str],
) -> None:
    provider = StubProvider(
        CardSearchPage(
            query="",
            page=1,
            total_results=0,
            has_more=False,
            cards=[],
        )
    )

    with make_client(provider) as client:
        response = client.get("/api/v1/cards/search", params=params)

    assert response.status_code == 200
    assert provider.calls == [CardSearchQuery(q="", page=1)]
