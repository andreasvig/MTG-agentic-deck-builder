import asyncio
import gzip
import io
import json
from pathlib import Path
from uuid import UUID, uuid5

import ijson
import pytest

from mtg_deck_builder.card_catalog import ScryfallBulkCatalogSync, SQLiteCardCatalog

_NAMESPACE = UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f")


def card_payload(
    name: str,
    *,
    oracle_name: str | None = None,
    released_at: str = "2026-01-01",
    eur: str | None = "0.10",
    games: list[str] | None = None,
    lang: str = "en",
) -> dict:
    oracle_key = oracle_name or name
    printing_key = f"{name}:{released_at}:{eur}:{lang}"
    return {
        "object": "card",
        "id": str(uuid5(_NAMESPACE, f"printing:{printing_key}")),
        "oracle_id": str(uuid5(_NAMESPACE, f"oracle:{oracle_key}")),
        "name": name,
        "lang": lang,
        "released_at": released_at,
        "games": games or ["paper"],
        "promo": False,
        "set_type": "expansion",
        "layout": "normal",
        "mana_cost": "{G}",
        "cmc": 1,
        "type_line": "Creature — Test",
        "oracle_text": "Test.",
        "power": "2",
        "toughness": "3",
        "colors": ["G"],
        "color_identity": ["G"],
        "image_uris": {
            "small": "https://cards.scryfall.io/small/test.jpg",
            "normal": "https://cards.scryfall.io/normal/test.jpg",
        },
        "card_faces": [],
        "set": "tst",
        "set_name": "Test Set",
        "collector_number": "1",
        "rarity": "common",
        "prices": {
            "usd": None,
            "usd_foil": None,
            "usd_etched": None,
            "eur": eur,
            "eur_foil": None,
            "tix": None,
        },
        "legalities": {"commander": "legal"},
        "finishes": ["nonfoil"],
        "scryfall_uri": "https://scryfall.com/card/tst/1/test",
        "purchase_uris": {},
    }


def importer(target: Path) -> ScryfallBulkCatalogSync:
    return ScryfallBulkCatalogSync(
        target=target,
        api_base_url="https://api.scryfall.test",
        user_agent="catalog-test",
        timeout_seconds=5,
    )


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, *, encoding: str | None = None) -> None:
        super().__init__(body)
        self.headers = {"Content-Encoding": encoding} if encoding else {}

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def test_sync_decompresses_discovery_and_bulk_responses(tmp_path: Path) -> None:
    target = tmp_path / "cards.sqlite3"
    metadata = {
        "object": "list",
        "data": [
            {
                "type": "default_cards",
                "updated_at": "2026-07-27T09:09:45+00:00",
                "download_uri": "https://data.scryfall.test/default.json",
                "content_type": "application/json",
                "content_encoding": "gzip",
                "size": 1,
            }
        ],
    }
    responses = {
        "https://api.scryfall.test/bulk-data": gzip.compress(json.dumps(metadata).encode()),
        "https://data.scryfall.test/default.json": gzip.compress(
            json.dumps([card_payload("Forest")]).encode()
        ),
    }

    def open_url(request: object, *, timeout: float) -> FakeResponse:
        assert timeout == 5
        return FakeResponse(
            responses[request.full_url],  # type: ignore[attr-defined]
            encoding="gzip",
        )

    result = ScryfallBulkCatalogSync(
        target=target,
        api_base_url="https://api.scryfall.test",
        user_agent="catalog-test",
        timeout_seconds=5,
        open_url=open_url,
    ).sync()

    assert result.cards == 1
    assert result.printings == 1
    assert SQLiteCardCatalog(target).metadata()["source_type"] == "default_cards"


def test_bulk_import_keeps_printings_and_selects_one_searchable_oracle_card(
    tmp_path: Path,
) -> None:
    target = tmp_path / "cards.sqlite3"
    payloads = [
        card_payload(
            "Forest Friend",
            oracle_name="Forest Friend",
            released_at="2025-01-01",
        ),
        card_payload(
            "Forest Friend",
            oracle_name="Forest Friend",
            released_at="2026-01-01",
        ),
        card_payload("Festival"),
        card_payload("Digital Only", games=["arena"]),
        {
            **card_payload("Forest // Forest"),
            "set_type": "memorabilia",
            "layout": "art_series",
        },
    ]

    result = importer(target).import_stream(
        io.BytesIO(json.dumps(payloads).encode()),
        source_updated_at="2026-07-27T09:09:45+00:00",
        source_uri="https://data.scryfall.test/default-cards.json",
    )
    catalog = SQLiteCardCatalog(target)
    entries = asyncio.run(catalog.entries())

    assert result.status == "imported"
    assert result.cards == 2
    assert result.printings == 3
    assert result.skipped == 2
    assert [entry.card.name for entry in entries] == ["Festival", "Forest Friend"]
    forest = next(entry for entry in entries if entry.card.name == "Forest Friend")
    assert str(forest.card.scryfall_id) == str(
        uuid5(
            _NAMESPACE,
            "printing:Forest Friend:2026-01-01:0.10:en",
        )
    )
    assert "forest friend" in forest.aliases
    assert forest.card.power == "2"
    assert forest.card.toughness == "3"
    assert catalog.metadata()["source_updated_at"] == "2026-07-27T09:09:45+00:00"


def test_failed_import_preserves_the_installed_database(tmp_path: Path) -> None:
    target = tmp_path / "cards.sqlite3"
    sync = importer(target)
    sync.import_stream(
        io.BytesIO(json.dumps([card_payload("Forest")]).encode()),
        source_updated_at="first",
        source_uri="https://data.scryfall.test/first.json",
    )
    installed = target.read_bytes()

    with pytest.raises(ijson.JSONError):
        sync.import_stream(
            io.BytesIO(b'[{"broken":'),
            source_updated_at="second",
            source_uri="https://data.scryfall.test/second.json",
        )

    assert target.read_bytes() == installed
    assert SQLiteCardCatalog(target).metadata()["source_updated_at"] == "first"
