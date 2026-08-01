import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from mtg_deck_builder.domain import CardPrices, CardSearchResult
from mtg_deck_builder.edhrec_catalog import (
    EdhrecAssociation,
    EdhrecCommanderService,
    EdhrecSimilarSuggestion,
    SQLiteEdhrecCatalog,
)
from mtg_deck_builder.providers.edhrec import (
    EdhrecCardMetric,
    EdhrecCardPage,
    EdhrecCommanderPage,
    EdhrecDeckTheme,
    EdhrecJsonClient,
    EdhrecUnavailable,
    edhrec_slug,
)


def make_card(name: str, oracle_id: UUID, scryfall_id: UUID) -> CardSearchResult:
    return CardSearchResult(
        oracle_id=oracle_id,
        scryfall_id=scryfall_id,
        name=name,
        layout="normal",
        mana_value=2,
        type_line="Legendary Creature — Test",
        colors=["G"],
        color_identity=["G"],
        set_code="tst",
        set_name="Test",
        collector_number="1",
        rarity="rare",
        prices=CardPrices(),
        legalities={"commander": "legal"},
        finishes=["nonfoil"],
        scryfall_url="https://scryfall.com/card/tst/1/test",
    )


class FakeResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self._body = json.dumps(payload).encode()
        self.headers: dict[str, str] = {}

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        return self._body


def test_edhrec_client_reads_and_deduplicates_commander_cardviews() -> None:
    printing_id = uuid4()
    payload = {
        "panels": {
            "taglinks": [
                {"slug": "tokens", "value": "Tokens", "count": 42},
                {"slug": "ramp", "value": "Ramp", "count": 100},
            ]
        },
        "container": {
            "json_dict": {
                "cardlists": [
                    {
                        "header": "High Synergy Cards",
                        "cardviews": [
                            {
                                "id": str(printing_id),
                                "name": "Elvish Mystic",
                                "num_decks": 80,
                                "potential_decks": 100,
                                "synergy": 0.42,
                            }
                        ],
                    },
                    {
                        "header": "Top Cards",
                        "cardviews": [
                            {
                                "id": str(printing_id),
                                "name": "Elvish Mystic",
                                "num_decks": 80,
                                "potential_decks": 100,
                                "synergy": 0.42,
                            }
                        ],
                    },
                ]
            }
        },
    }
    client = EdhrecJsonClient(
        base_url="https://json.example",
        user_agent="test",
        timeout_seconds=2,
        open_url=lambda *_args, **_kwargs: FakeResponse(payload),
    )

    page = client.fetch_commander("test-commander")

    assert len(page.cards) == 1
    assert page.cards[0].scryfall_id == printing_id
    assert page.cards[0].num_decks == 80
    assert page.themes == (
        EdhrecDeckTheme(slug="ramp", name="Ramp", deck_count=100),
        EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=42),
    )
    assert json.loads(page.raw_json) == payload


class StubCardCatalog:
    def __init__(
        self,
        commander: CardSearchResult,
        mapping: dict[UUID, UUID],
    ) -> None:
        self.commander = commander
        self.mapping = mapping
        self.names: dict[str, UUID] = {}

    async def card_by_oracle_id(self, _oracle_id: str) -> CardSearchResult:
        return self.commander

    async def oracle_ids_by_scryfall_ids(
        self,
        _scryfall_ids: list[UUID],
    ) -> dict[UUID, UUID]:
        return self.mapping

    async def oracle_ids_by_names(self, names: list[str]) -> dict[str, UUID]:
        return {
            name.casefold(): self.names[name.casefold()]
            for name in names
            if name.casefold() in self.names
        }


class StubClient:
    def __init__(
        self,
        page: EdhrecCommanderPage,
        themed_page: EdhrecCommanderPage | None = None,
        card_page: EdhrecCardPage | None = None,
    ) -> None:
        self.page = page
        self.themed_page = themed_page or page
        self.card_page = card_page
        self.calls: list[tuple[str, str | None]] = []
        self.card_calls: list[str] = []

    def fetch_commander(
        self,
        slug: str,
        *,
        theme_slug: str | None = None,
    ) -> EdhrecCommanderPage:
        self.calls.append((slug, theme_slug))
        return self.themed_page if theme_slug is not None else self.page

    def fetch_card(self, slug: str) -> EdhrecCardPage:
        self.card_calls.append(slug)
        assert self.card_page is not None
        return self.card_page


def test_service_fetches_once_then_uses_month_long_normalized_cache(
    tmp_path: Path,
) -> None:
    commander_oracle_id = uuid4()
    commander = make_card("Ghalta, Primal Hunger", commander_oracle_id, uuid4())
    related_printing_id = uuid4()
    related_oracle_id = uuid4()
    page = EdhrecCommanderPage(
        cards=(
            EdhrecCardMetric(
                scryfall_id=related_printing_id,
                name="Elvish Mystic",
                num_decks=75,
                potential_decks=100,
                synergy=0.4,
            ),
        ),
        raw_json='{"source":"test"}',
    )
    client = StubClient(page)
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    service = EdhrecCommanderService(
        cache=cache,
        card_catalog=StubCardCatalog(  # type: ignore[arg-type]
            commander,
            {related_printing_id: related_oracle_id},
        ),
        client=client,  # type: ignore[arg-type]
        refresh_after_days=30,
    )

    async def load_twice() -> tuple[object, object]:
        return (
            await service.ranking_for(commander_oracle_id),
            await service.ranking_for(commander_oracle_id),
        )

    fetched, cached = asyncio.run(load_twice())

    assert client.calls == [("ghalta-primal-hunger", None)]
    assert fetched.source == "network"
    assert cached.source == "cache"
    assert cached.associations[related_oracle_id].inclusion == 0.75
    with sqlite3.connect(tmp_path / "edhrec.sqlite3") as connection:
        raw_json = connection.execute("SELECT raw_json FROM commander_snapshots").fetchone()
    assert raw_json == ('{"source":"test"}',)


def test_cache_rejects_snapshots_older_than_thirty_days(tmp_path: Path) -> None:
    commander_id = uuid4()
    related_id = uuid4()
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")

    cache.save(
        commander_oracle_id=commander_id,
        commander_name="Test Commander",
        commander_slug="test-commander",
        fetched_at=datetime.now(UTC) - timedelta(days=31),
        raw_json="{}",
        associations={
            related_id: EdhrecAssociation(
                oracle_id=related_id,
                num_decks=1,
                potential_decks=2,
                synergy=0.1,
            )
        },
    )

    assert (
        cache.load_fresh(
            commander_id,
            refresh_after_days=30,
            now=datetime.now(UTC),
        )
        is None
    )


def test_existing_raw_snapshot_backfills_theme_rows_without_a_refetch(
    tmp_path: Path,
) -> None:
    commander_id = uuid4()
    related_id = uuid4()
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    cache.save(
        commander_oracle_id=commander_id,
        commander_name="Test Commander",
        commander_slug="test-commander",
        fetched_at=datetime.now(UTC),
        raw_json=json.dumps(
            {
                "panels": {
                    "taglinks": [
                        {"slug": "tokens", "value": "Tokens", "count": 42},
                    ]
                }
            }
        ),
        associations={
            related_id: EdhrecAssociation(
                oracle_id=related_id,
                num_decks=10,
                potential_decks=42,
                synergy=0.2,
            )
        },
    )

    context = cache.load_context_fresh(
        commander_id,
        refresh_after_days=30,
        now=datetime.now(UTC),
    )

    assert context is not None
    assert context.themes == (EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=42),)
    with sqlite3.connect(tmp_path / "edhrec.sqlite3") as connection:
        assert connection.execute(
            "SELECT theme_slug, theme_name, deck_count FROM commander_themes"
        ).fetchall() == [("tokens", "Tokens", 42)]


def test_service_fetches_and_caches_theme_specific_commander_evidence(
    tmp_path: Path,
) -> None:
    commander_oracle_id = uuid4()
    commander = make_card("Ghalta, Primal Hunger", commander_oracle_id, uuid4())
    base_printing_id = uuid4()
    base_oracle_id = uuid4()
    themed_printing_id = uuid4()
    themed_oracle_id = uuid4()
    base_page = EdhrecCommanderPage(
        cards=(
            EdhrecCardMetric(
                scryfall_id=base_printing_id,
                name="Llanowar Elves",
                num_decks=500,
                potential_decks=1_000,
                synergy=0.1,
            ),
        ),
        raw_json='{"page":"base"}',
        themes=(EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=80),),
    )
    themed_page = EdhrecCommanderPage(
        cards=(
            EdhrecCardMetric(
                scryfall_id=themed_printing_id,
                name="Scute Swarm",
                num_decks=60,
                potential_decks=80,
                synergy=0.55,
            ),
        ),
        raw_json='{"page":"tokens"}',
    )
    client = StubClient(base_page, themed_page)
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    service = EdhrecCommanderService(
        cache=cache,
        card_catalog=StubCardCatalog(  # type: ignore[arg-type]
            commander,
            {
                base_printing_id: base_oracle_id,
                themed_printing_id: themed_oracle_id,
            },
        ),
        client=client,  # type: ignore[arg-type]
        refresh_after_days=30,
    )

    async def load() -> tuple[object, object, object]:
        return (
            await service.context_for(commander_oracle_id),
            await service.ranking_for(commander_oracle_id, "tokens"),
            await service.ranking_for(commander_oracle_id, "tokens"),
        )

    context, fetched, cached = asyncio.run(load())

    assert context.commander_name == "Ghalta, Primal Hunger"
    assert context.themes == (EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=80),)
    assert fetched.source == "network"
    assert fetched.associations[themed_oracle_id].inclusion == 0.75
    assert cached.source == "cache"
    assert client.calls == [
        ("ghalta-primal-hunger", None),
        ("ghalta-primal-hunger", "tokens"),
    ]


def test_edhrec_slug_uses_the_front_face_and_normalizes_accents() -> None:
    assert edhrec_slug("Altaïr Ibn-La'Ahad // Back Face") == "altair-ibn-laahad"


def test_edhrec_slug_deletes_apostrophes_instead_of_separating_on_them() -> None:
    """EDHREC closes the gap an apostrophe leaves, and 403s on the separated form.

    Verified against the live host on 2026-07-31: `thassas-oracle` answers 200 while
    `thassa-s-oracle` answers 403. Treating the apostrophe as ordinary punctuation
    broke EDHREC for every commander whose name contains one.
    """

    assert edhrec_slug("Thassa's Oracle") == "thassas-oracle"
    assert edhrec_slug("Yuriko, the Tiger's Shadow") == "yuriko-the-tigers-shadow"
    assert edhrec_slug("K'rrik, Son of Yawgmoth") == "krrik-son-of-yawgmoth"
    # The curly form Scryfall does not use, but which must not reappear as a dash.
    assert edhrec_slug("Thassa\u2019s Oracle") == "thassas-oracle"
    # A name without one is untouched.
    assert edhrec_slug("Ghalta, Primal Hunger") == "ghalta-primal-hunger"


def test_edhrec_client_reads_similar_card_names_in_published_order() -> None:
    payload = {
        "similar": [
            "Kodama's Reach",
            "  Rampant Growth  ",
            "Kodama's Reach",
            "",
            17,
            "Farseek",
        ],
        "container": {"json_dict": {"card": {"name": "Cultivate"}}},
    }
    client = EdhrecJsonClient(
        base_url="https://json.example",
        user_agent="test",
        timeout_seconds=2,
        open_url=lambda *_args, **_kwargs: FakeResponse(payload),
    )

    page = client.fetch_card("cultivate")

    assert page.similar_names == ("Kodama's Reach", "Rampant Growth", "Farseek")
    assert json.loads(page.raw_json) == payload


def test_edhrec_client_rejects_a_card_page_with_no_similar_list() -> None:
    client = EdhrecJsonClient(
        base_url="https://json.example",
        user_agent="test",
        timeout_seconds=2,
        open_url=lambda *_args, **_kwargs: FakeResponse({"container": {}}),
    )

    with pytest.raises(EdhrecUnavailable):
        client.fetch_card("cultivate")


def test_edhrec_client_accepts_a_card_with_no_similar_cards() -> None:
    """An empty list is an answer, so it must not raise and must stay cacheable."""

    client = EdhrecJsonClient(
        base_url="https://json.example",
        user_agent="test",
        timeout_seconds=2,
        open_url=lambda *_args, **_kwargs: FakeResponse({"similar": []}),
    )

    assert client.fetch_card("cultivate").similar_names == ()


def test_similar_cards_resolve_names_once_then_serve_from_the_cache(
    tmp_path: Path,
) -> None:
    cultivate_id = uuid4()
    reach_id = uuid4()
    cultivate = make_card("Cultivate", cultivate_id, uuid4())
    catalog = StubCardCatalog(cultivate, {})
    # EDHREC lists the card itself, one card the catalog knows, and one it does not.
    catalog.names = {"kodama's reach": reach_id, "cultivate": cultivate_id}
    client = StubClient(
        EdhrecCommanderPage(cards=(), raw_json="{}"),
        card_page=EdhrecCardPage(
            similar_names=("Kodama's Reach", "Cultivate", "Nissa's Pilgrimage"),
            raw_json='{"similar":["Kodama\'s Reach"]}',
        ),
    )
    service = EdhrecCommanderService(
        cache=SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3"),
        card_catalog=catalog,  # type: ignore[arg-type]
        client=client,  # type: ignore[arg-type]
        refresh_after_days=30,
    )

    async def load_twice() -> tuple[object, object]:
        return (
            await service.similar_cards_for(cultivate_id),
            await service.similar_cards_for(cultivate_id),
        )

    fetched, cached = asyncio.run(load_twice())

    assert client.card_calls == ["cultivate"]
    assert fetched.source == "network"
    assert cached.source == "cache"
    for result in (fetched, cached):
        assert [
            (suggestion.rank, suggestion.name, suggestion.oracle_id)
            for suggestion in result.suggestions
        ] == [
            (1, "Kodama's Reach", reach_id),
            # A page listing its own card must never point the card at itself.
            (2, "Cultivate", None),
            # Unresolvable names stay visible rather than disappearing.
            (3, "Nissa's Pilgrimage", None),
        ]


def test_cached_similar_names_are_re_resolved_against_the_current_catalog(
    tmp_path: Path,
) -> None:
    """A name stored unresolvable must become openable once the catalog knows it.

    Resolution depends on the local catalog rather than on EDHREC, so it cannot be
    cached alongside the names: a `catalog:sync` has to repair it without waiting
    for the long similar-card window to lapse.
    """

    cultivate_id = uuid4()
    reach_id = uuid4()
    catalog = StubCardCatalog(make_card("Cultivate", cultivate_id, uuid4()), {})
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    # A snapshot saved when the catalog did not yet contain Kodama's Reach.
    cache.save_similar(
        oracle_id=cultivate_id,
        card_name="Cultivate",
        card_slug="cultivate",
        fetched_at=datetime.now(UTC),
        raw_json="{}",
        suggestions=(EdhrecSimilarSuggestion(rank=1, name="Kodama's Reach", oracle_id=None),),
    )
    client = StubClient(EdhrecCommanderPage(cards=(), raw_json="{}"))
    service = EdhrecCommanderService(
        cache=cache,
        card_catalog=catalog,  # type: ignore[arg-type]
        client=client,  # type: ignore[arg-type]
        refresh_after_days=30,
        similar_refresh_after_days=180,
    )

    # The catalog now knows the card the stored snapshot could not resolve.
    catalog.names = {"kodama's reach": reach_id}
    result = asyncio.run(service.similar_cards_for(cultivate_id))

    assert result.source == "cache"
    assert result.suggestions[0].oracle_id == reach_id
    # Repaired without a refetch: the names themselves were still fresh.
    assert client.card_calls == []


def test_service_serves_similar_cards_past_the_commander_refresh_window(
    tmp_path: Path,
) -> None:
    """The service must read the similar-card window, not the commander one.

    A 90-day-old snapshot is stale for commander pages and fresh for similar cards,
    so wiring the wrong window silently refetches every list four times a year.
    """

    cultivate_id = uuid4()
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    cache.save_similar(
        oracle_id=cultivate_id,
        card_name="Cultivate",
        card_slug="cultivate",
        fetched_at=datetime.now(UTC) - timedelta(days=90),
        raw_json="{}",
        suggestions=(EdhrecSimilarSuggestion(rank=1, name="Kodama's Reach", oracle_id=None),),
    )
    client = StubClient(
        EdhrecCommanderPage(cards=(), raw_json="{}"),
        card_page=EdhrecCardPage(similar_names=("Refetched",), raw_json="{}"),
    )
    service = EdhrecCommanderService(
        cache=cache,
        card_catalog=StubCardCatalog(  # type: ignore[arg-type]
            make_card("Cultivate", cultivate_id, uuid4()),
            {},
        ),
        client=client,  # type: ignore[arg-type]
        refresh_after_days=30,
        similar_refresh_after_days=180,
    )

    result = asyncio.run(service.similar_cards_for(cultivate_id))

    assert result.source == "cache"
    assert client.card_calls == []
    assert [suggestion.name for suggestion in result.suggestions] == ["Kodama's Reach"]


def test_similar_cards_use_their_own_longer_refresh_window(tmp_path: Path) -> None:
    """The commander window must not expire a similar-card list."""

    oracle_id = uuid4()
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    cache.save_similar(
        oracle_id=oracle_id,
        card_name="Cultivate",
        card_slug="cultivate",
        fetched_at=datetime.now(UTC) - timedelta(days=90),
        raw_json="{}",
        suggestions=(EdhrecSimilarSuggestion(rank=1, name="Kodama's Reach", oracle_id=None),),
    )
    now = datetime.now(UTC)

    assert cache.load_similar_fresh(oracle_id, refresh_after_days=30, now=now) is None
    assert cache.load_similar_fresh(oracle_id, refresh_after_days=180, now=now) is not None


def test_similar_cards_are_refetched_once_the_snapshot_ages_out(tmp_path: Path) -> None:
    oracle_id = uuid4()
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    cache.save_similar(
        oracle_id=oracle_id,
        card_name="Cultivate",
        card_slug="cultivate",
        fetched_at=datetime.now(UTC) - timedelta(days=31),
        raw_json="{}",
        suggestions=(EdhrecSimilarSuggestion(rank=1, name="Kodama's Reach", oracle_id=None),),
    )

    assert (
        cache.load_similar_fresh(
            oracle_id,
            refresh_after_days=30,
            now=datetime.now(UTC),
        )
        is None
    )


def test_cached_similar_cards_survive_having_no_suggestions(tmp_path: Path) -> None:
    """A card EDHREC had nothing for is answered from cache, not fetched again."""

    oracle_id = uuid4()
    cache = SQLiteEdhrecCatalog(tmp_path / "edhrec.sqlite3")
    cache.save_similar(
        oracle_id=oracle_id,
        card_name="Cultivate",
        card_slug="cultivate",
        fetched_at=datetime.now(UTC),
        raw_json="{}",
        suggestions=(),
    )

    cached = cache.load_similar_fresh(
        oracle_id,
        refresh_after_days=30,
        now=datetime.now(UTC),
    )

    assert cached is not None
    assert cached.suggestions == ()
