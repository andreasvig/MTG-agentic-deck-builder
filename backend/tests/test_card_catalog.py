import asyncio
import gzip
import io
import json
from pathlib import Path
from uuid import UUID, uuid5

import ijson
import pytest
from pydantic import ValidationError

from mtg_deck_builder.card_catalog import ScryfallBulkCatalogSync, SQLiteCardCatalog
from mtg_deck_builder.config import PrintingSelectionSettings

_NAMESPACE = UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f")


def card_payload(
    name: str,
    *,
    oracle_name: str | None = None,
    released_at: str = "2026-01-01",
    eur: str | None = "0.10",
    games: list[str] | None = None,
    lang: str = "en",
    variant: str = "",
) -> dict:
    oracle_key = oracle_name or name
    printing_key = f"{name}:{released_at}:{eur}:{lang}:{variant}"
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


def importer(
    target: Path,
    *,
    printing_selection: PrintingSelectionSettings | None = None,
) -> ScryfallBulkCatalogSync:
    return ScryfallBulkCatalogSync(
        target=target,
        api_base_url="https://api.scryfall.test",
        user_agent="catalog-test",
        timeout_seconds=5,
        printing_selection=printing_selection,
    )


def selected_printing(target: Path, name: str) -> str:
    entries = asyncio.run(SQLiteCardCatalog(target).entries())
    return str(next(entry for entry in entries if entry.card.name == name).card.scryfall_id)


def printing_id(name: str, *, released_at: str, eur: str | None, variant: str = "") -> str:
    return str(uuid5(_NAMESPACE, f"printing:{name}:{released_at}:{eur}:en:{variant}"))


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
    assert str(forest.card.scryfall_id) == printing_id(
        "Forest Friend", released_at="2026-01-01", eur="0.10"
    )
    assert "forest friend" in forest.aliases
    assert forest.card.power == "2"
    assert forest.card.toughness == "3"
    assert catalog.metadata()["source_updated_at"] == "2026-07-27T09:09:45+00:00"


def test_sync_reads_the_line_delimited_export_without_a_content_encoding_header(
    tmp_path: Path,
) -> None:
    target = tmp_path / "cards.sqlite3"
    # Scryfall's current listing offers only jsonl_download_uri, drops content_type
    # and size, and serves the gzip body as application/gzip with no
    # Content-Encoding header, so nothing but the URI reveals either shape.
    metadata = {
        "object": "list",
        "data": [
            {
                "type": "default_cards",
                "updated_at": "2026-07-30T21:11:26.052+00:00",
                "jsonl_download_uri": "https://data.scryfall.test/default.jsonl.gz",
            }
        ],
    }
    body = b"\n".join(
        json.dumps(payload).encode()
        for payload in (card_payload("Forest"), card_payload("Festival"))
    )
    responses = {
        "https://api.scryfall.test/bulk-data": json.dumps(metadata).encode(),
        "https://data.scryfall.test/default.jsonl.gz": gzip.compress(body),
    }

    def open_url(request: object, *, timeout: float) -> FakeResponse:
        return FakeResponse(responses[request.full_url])  # type: ignore[attr-defined]

    result = ScryfallBulkCatalogSync(
        target=target,
        api_base_url="https://api.scryfall.test",
        user_agent="catalog-test",
        timeout_seconds=5,
        open_url=open_url,
    ).sync()

    assert result.cards == 2
    assert result.printings == 2
    assert SQLiteCardCatalog(target).metadata()["source_updated_at"] == (
        "2026-07-30T21:11:26.052000+00:00"
    )


def test_bulk_listing_without_any_download_uri_is_rejected(tmp_path: Path) -> None:
    metadata = {
        "object": "list",
        "data": [{"type": "default_cards", "updated_at": "2026-07-30T21:11:26.052+00:00"}],
    }

    def open_url(request: object, *, timeout: float) -> FakeResponse:
        return FakeResponse(json.dumps(metadata).encode())

    with pytest.raises(ValidationError):
        ScryfallBulkCatalogSync(
            target=tmp_path / "cards.sqlite3",
            api_base_url="https://api.scryfall.test",
            user_agent="catalog-test",
            timeout_seconds=5,
            open_url=open_url,
        ).sync()


def test_cheapest_ordinary_printing_wins_over_newer_and_cheaper_special_ones(
    tmp_path: Path,
) -> None:
    target = tmp_path / "cards.sqlite3"
    payloads = [
        # Newest, and what the old newest-wins rule picked: a full-art land from a
        # crossover set. Cheaper still is a Secret Lair, so price alone is not enough.
        {**card_payload("Forest", released_at="2026-06-01", eur="0.19"), "full_art": True},
        {
            **card_payload("Forest", released_at="2026-05-01", eur="0.01", variant="secret"),
            "set": "sld",
            "set_type": "box",
        },
        card_payload("Forest", released_at="2020-01-01", eur="0.50", variant="dear"),
        card_payload("Forest", released_at="2014-09-26", eur="0.02", variant="cheap"),
    ]
    # The winner has to lose every fallback key for this to mean anything: the
    # Secret Lair is cheaper, and the full-art printing is newer.

    importer(target).import_stream(
        io.BytesIO(json.dumps(payloads).encode()),
        source_updated_at="2026-07-30T21:11:26+00:00",
        source_uri="https://data.scryfall.test/default.json",
    )

    assert selected_printing(target, "Forest") == printing_id(
        "Forest", released_at="2014-09-26", eur="0.02", variant="cheap"
    )


def test_selection_falls_back_to_the_cheapest_special_printing_when_no_ordinary_one_is_priced(
    tmp_path: Path,
) -> None:
    target = tmp_path / "cards.sqlite3"
    payloads = [
        {**card_payload("Mise", released_at="2017-12-08", eur=None), "set_type": "funny"},
        {
            **card_payload("Mise", released_at="2017-12-08", eur="9.00", variant="dear"),
            "set_type": "funny",
        },
        {
            **card_payload("Mise", released_at="2017-12-08", eur="4.00", variant="cheap"),
            "set_type": "funny",
        },
    ]

    importer(target).import_stream(
        io.BytesIO(json.dumps(payloads).encode()),
        source_updated_at="2026-07-30T21:11:26+00:00",
        source_uri="https://data.scryfall.test/default.json",
    )

    # A card whose every printing is special stays in the catalog at its cheapest.
    assert selected_printing(target, "Mise") == printing_id(
        "Mise", released_at="2017-12-08", eur="4.00", variant="cheap"
    )


def test_a_priced_special_printing_beats_an_unpriced_ordinary_one(tmp_path: Path) -> None:
    target = tmp_path / "cards.sqlite3"
    payloads = [
        card_payload("Forest", released_at="2026-06-01", eur=None),
        {
            **card_payload("Forest", released_at="2014-09-26", eur="0.40", variant="secret"),
            "set": "sld",
            "set_type": "box",
        },
    ]

    importer(target).import_stream(
        io.BytesIO(json.dumps(payloads).encode()),
        source_updated_at="2026-07-30T21:11:26+00:00",
        source_uri="https://data.scryfall.test/default.json",
    )

    # Having a price outranks being ordinary, because a card with no price at all
    # silently drops out of every price filter the agent can apply.
    assert selected_printing(target, "Forest") == printing_id(
        "Forest", released_at="2014-09-26", eur="0.40", variant="secret"
    )


def test_which_printings_count_as_special_comes_from_configuration(tmp_path: Path) -> None:
    target = tmp_path / "cards.sqlite3"
    # The full-art printing is the cheapest but also the oldest, so it can only win
    # by no longer counting as special, and the default policy has to reject it.
    payloads = [
        {**card_payload("Forest", released_at="2014-09-26", eur="0.02"), "full_art": True},
        card_payload("Forest", released_at="2026-06-01", eur="0.05", variant="plain"),
    ]
    stream = io.BytesIO(json.dumps(payloads).encode())
    full_art = printing_id("Forest", released_at="2014-09-26", eur="0.02")
    plain = printing_id("Forest", released_at="2026-06-01", eur="0.05", variant="plain")

    importer(
        target,
        printing_selection=PrintingSelectionSettings(exclude_full_art=False),
    ).import_stream(
        stream,
        source_updated_at="2026-07-30T21:11:26+00:00",
        source_uri="https://data.scryfall.test/default.json",
    )
    assert selected_printing(target, "Forest") == full_art

    permissive = tmp_path / "default.sqlite3"
    importer(permissive).import_stream(
        io.BytesIO(json.dumps(payloads).encode()),
        source_updated_at="2026-07-30T21:11:26+00:00",
        source_uri="https://data.scryfall.test/default.json",
    )
    assert selected_printing(permissive, "Forest") == plain


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


def test_name_resolution_ignores_case_and_matches_a_front_face(tmp_path: Path) -> None:
    """EDHREC publishes names, not identifiers, and does not match Scryfall's casing."""

    target = tmp_path / "cards.sqlite3"
    importer(target).import_stream(
        io.BytesIO(
            json.dumps(
                [
                    card_payload("Kodama's Reach"),
                    card_payload("Aang, Swift Savior // Aang and La, Ocean's Fury"),
                    card_payload("Forest"),
                ]
            ).encode()
        ),
        source_updated_at="2026-07-31T00:00:00+00:00",
        source_uri="https://data.scryfall.test/default.json",
    )
    catalog = SQLiteCardCatalog(target)

    resolved = asyncio.run(
        catalog.oracle_ids_by_names(
            [
                "kodama's reach",
                # Only the front face, which is how another source would name it.
                "Aang, Swift Savior",
                "Nissa's Pilgrimage",
                "  ",
            ]
        )
    )

    assert set(resolved) == {"kodama's reach", "aang, swift savior"}
    assert resolved["kodama's reach"] == UUID(str(uuid5(_NAMESPACE, "oracle:Kodama's Reach")))
    assert resolved["aang, swift savior"] == UUID(
        str(uuid5(_NAMESPACE, "oracle:Aang, Swift Savior // Aang and La, Ocean's Fury"))
    )
    assert asyncio.run(catalog.oracle_ids_by_names([])) == {}


def test_name_resolution_treats_wildcards_as_literal_characters(tmp_path: Path) -> None:
    """A `%` in a lookup must not match a card through the front-face `LIKE`.

    The catalog has to contain a double-faced card for this to bite: unescaped, the
    fallback becomes `LIKE '% // %'`, which matches every split name there is.
    """

    target = tmp_path / "cards.sqlite3"
    importer(target).import_stream(
        io.BytesIO(
            json.dumps(
                [
                    card_payload("Forest"),
                    card_payload("Aang, Swift Savior // Aang and La, Ocean's Fury"),
                ]
            ).encode()
        ),
        source_updated_at="2026-07-31T00:00:00+00:00",
        source_uri="https://data.scryfall.test/default.json",
    )
    catalog = SQLiteCardCatalog(target)

    assert asyncio.run(catalog.oracle_ids_by_names(["%"])) == {}
    assert asyncio.run(catalog.oracle_ids_by_names(["_ang, Swift Savior"])) == {}
