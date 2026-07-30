import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

from mtg_deck_builder.domain import CardPrices, CardSearchResult
from mtg_deck_builder.edhrec_catalog import (
    EdhrecAssociation,
    EdhrecCommanderService,
    SQLiteEdhrecCatalog,
)
from mtg_deck_builder.providers.edhrec import (
    EdhrecCardMetric,
    EdhrecCommanderPage,
    EdhrecDeckTheme,
    EdhrecJsonClient,
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
        }
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

    async def card_by_oracle_id(self, _oracle_id: str) -> CardSearchResult:
        return self.commander

    async def oracle_ids_by_scryfall_ids(
        self,
        _scryfall_ids: list[UUID],
    ) -> dict[UUID, UUID]:
        return self.mapping


class StubClient:
    def __init__(
        self,
        page: EdhrecCommanderPage,
        themed_page: EdhrecCommanderPage | None = None,
    ) -> None:
        self.page = page
        self.themed_page = themed_page or page
        self.calls: list[tuple[str, str | None]] = []

    def fetch_commander(
        self,
        slug: str,
        *,
        theme_slug: str | None = None,
    ) -> EdhrecCommanderPage:
        self.calls.append((slug, theme_slug))
        return self.themed_page if theme_slug is not None else self.page


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
        raw_json = connection.execute(
            "SELECT raw_json FROM commander_snapshots"
        ).fetchone()
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
    assert context.themes == (
        EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=42),
    )
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
    assert context.themes == (
        EdhrecDeckTheme(slug="tokens", name="Tokens", deck_count=80),
    )
    assert fetched.source == "network"
    assert fetched.associations[themed_oracle_id].inclusion == 0.75
    assert cached.source == "cache"
    assert client.calls == [
        ("ghalta-primal-hunger", None),
        ("ghalta-primal-hunger", "tokens"),
    ]


def test_edhrec_slug_uses_the_front_face_and_normalizes_accents() -> None:
    assert edhrec_slug("Altaïr Ibn-La'Ahad // Back Face") == "altair-ibn-la-ahad"
