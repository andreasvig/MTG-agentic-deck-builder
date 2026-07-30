"""Atomic Scryfall bulk import and read-only local card catalog."""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import sqlite3
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, BinaryIO, Literal
from urllib.request import Request, urlopen
from uuid import UUID

import ijson
from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, ValidationError

from mtg_deck_builder.domain import CardSearchResult
from mtg_deck_builder.providers.cards import CardSearchUnavailable
from mtg_deck_builder.providers.scryfall import map_scryfall_card

_SCHEMA_VERSION = 2
_BULK_TYPE = "default_cards"


@dataclass(frozen=True)
class CatalogEntry:
    """One canonical card and its normalized searchable title aliases."""

    card: CardSearchResult
    aliases: tuple[str, ...]


@dataclass(frozen=True)
class CatalogSyncResult:
    """Summary returned by a bulk-data refresh."""

    status: Literal["imported", "current"]
    source_updated_at: str
    cards: int
    printings: int
    skipped: int
    path: Path


class _BulkDataItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str
    updated_at: datetime
    download_uri: AnyHttpUrl
    content_type: str
    content_encoding: str | None = None
    size: Annotated[int, Field(ge=0)]


class _BulkDataList(BaseModel):
    model_config = ConfigDict(extra="ignore")

    object: Literal["list"]
    data: list[_BulkDataItem]


class SQLiteCardCatalog:
    """Load canonical card rows from an atomically replaceable SQLite file."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._entries: tuple[CatalogEntry, ...] | None = None
        self._loaded_mtime_ns: int | None = None
        self._load_lock = asyncio.Lock()

    async def entries(self) -> tuple[CatalogEntry, ...]:
        """Return all searchable cards, reloading after an atomic refresh."""

        async with self._load_lock:
            try:
                mtime_ns = self.path.stat().st_mtime_ns
            except OSError as exc:
                raise CardSearchUnavailable from exc
            if self._entries is not None and self._loaded_mtime_ns == mtime_ns:
                return self._entries
            try:
                entries = await asyncio.to_thread(self._read_entries)
            except (OSError, sqlite3.Error, ValidationError, ValueError) as exc:
                raise CardSearchUnavailable from exc
            self._entries = entries
            self._loaded_mtime_ns = mtime_ns
            return entries

    async def card_by_oracle_id(self, oracle_id: str) -> CardSearchResult | None:
        """Resolve one canonical printing by its stable Oracle identity."""

        return next(
            (
                entry.card
                for entry in await self.entries()
                if str(entry.card.oracle_id) == str(oracle_id)
            ),
            None,
        )

    async def oracle_ids_by_scryfall_ids(
        self,
        scryfall_ids: list[UUID],
    ) -> dict[UUID, UUID]:
        """Map any known paper printing identities to stable Oracle identities."""

        if not scryfall_ids:
            return {}
        try:
            return await asyncio.to_thread(
                self._read_oracle_ids_by_scryfall_ids,
                scryfall_ids,
            )
        except (OSError, sqlite3.Error, ValueError) as exc:
            raise CardSearchUnavailable from exc

    def metadata(self) -> dict[str, str]:
        """Read catalog metadata without loading card payloads."""

        if not self.path.is_file():
            return {}
        try:
            with _read_only_connection(self.path) as connection:
                return dict(connection.execute("SELECT key, value FROM metadata"))
        except sqlite3.Error:
            return {}

    def _read_entries(self) -> tuple[CatalogEntry, ...]:
        with _read_only_connection(self.path) as connection:
            schema_version = connection.execute(
                "SELECT value FROM metadata WHERE key = 'schema_version'"
            ).fetchone()
            if schema_version is None or int(schema_version[0]) != _SCHEMA_VERSION:
                raise ValueError("Unsupported card catalog schema")
            rows = connection.execute(
                "SELECT card_json, aliases_json FROM cards ORDER BY name COLLATE NOCASE"
            )
            return tuple(
                CatalogEntry(
                    card=CardSearchResult.model_validate_json(card_json),
                    aliases=tuple(json.loads(aliases_json)),
                )
                for card_json, aliases_json in rows
            )

    def _read_oracle_ids_by_scryfall_ids(
        self,
        scryfall_ids: list[UUID],
    ) -> dict[UUID, UUID]:
        unique_ids = list(dict.fromkeys(scryfall_ids))
        resolved: dict[UUID, UUID] = {}
        with _read_only_connection(self.path) as connection:
            for start in range(0, len(unique_ids), 500):
                chunk = unique_ids[start : start + 500]
                placeholders = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    f"""
                    SELECT scryfall_id, oracle_id
                    FROM printings
                    WHERE scryfall_id IN ({placeholders})
                    """,
                    [str(scryfall_id) for scryfall_id in chunk],
                )
                resolved.update(
                    {
                        UUID(scryfall_id): UUID(oracle_id)
                        for scryfall_id, oracle_id in rows
                    }
                )
        return resolved


class ScryfallBulkCatalogSync:
    """Build a local catalog from Scryfall's compressed default-cards export."""

    def __init__(
        self,
        *,
        target: Path,
        api_base_url: str,
        user_agent: str,
        timeout_seconds: float,
        open_url: Callable[..., Any] = urlopen,
    ) -> None:
        self.target = target
        self.api_base_url = api_base_url.rstrip("/")
        self.user_agent = user_agent
        self.timeout_seconds = timeout_seconds
        self._open_url = open_url

    def sync(self, *, force: bool = False) -> CatalogSyncResult:
        """Refresh the catalog unless the installed bulk timestamp is current."""

        metadata = self._discover()
        source_updated_at = metadata.updated_at.isoformat()
        existing = SQLiteCardCatalog(self.target).metadata()
        if (
            not force
            and existing.get("source_updated_at") == source_updated_at
            and existing.get("schema_version") == str(_SCHEMA_VERSION)
        ):
            return CatalogSyncResult(
                status="current",
                source_updated_at=source_updated_at,
                cards=int(existing.get("card_count", 0)),
                printings=int(existing.get("printing_count", 0)),
                skipped=int(existing.get("skipped_count", 0)),
                path=self.target,
            )

        request = self._request(str(metadata.download_uri))
        with self._open_url(request, timeout=self.timeout_seconds) as response:
            encoding = response.headers.get("Content-Encoding") or metadata.content_encoding
            stream: BinaryIO
            if encoding and "gzip" in encoding.casefold():
                stream = gzip.GzipFile(fileobj=response)
            else:
                stream = response
            return self.import_stream(
                stream,
                source_updated_at=source_updated_at,
                source_uri=str(metadata.download_uri),
            )

    def import_stream(
        self,
        stream: BinaryIO,
        *,
        source_updated_at: str,
        source_uri: str,
    ) -> CatalogSyncResult:
        """Import a JSON array stream into a temporary DB, then swap it in."""

        self.target.parent.mkdir(parents=True, exist_ok=True)
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.target.name}.",
            suffix=".tmp",
            dir=self.target.parent,
        )
        os.close(file_descriptor)
        temporary_path = Path(temporary_name)

        try:
            cards, printings, skipped = _build_database(
                temporary_path,
                ijson.items(stream, "item"),
                source_updated_at=source_updated_at,
                source_uri=source_uri,
            )
            os.replace(temporary_path, self.target)
        except BaseException:
            temporary_path.unlink(missing_ok=True)
            raise

        return CatalogSyncResult(
            status="imported",
            source_updated_at=source_updated_at,
            cards=cards,
            printings=printings,
            skipped=skipped,
            path=self.target,
        )

    def _discover(self) -> _BulkDataItem:
        request = self._request(f"{self.api_base_url}/bulk-data")
        with self._open_url(request, timeout=self.timeout_seconds) as response:
            encoding = response.headers.get("Content-Encoding")
            if encoding and "gzip" in encoding.casefold():
                body = gzip.GzipFile(fileobj=response).read()
            else:
                body = response.read()
            payload = _BulkDataList.model_validate_json(body)
        try:
            return next(item for item in payload.data if item.type == _BULK_TYPE)
        except StopIteration as exc:
            raise RuntimeError(f"Scryfall bulk dataset {_BULK_TYPE!r} was not found") from exc

    def _request(self, url: str) -> Request:
        return Request(
            url,
            headers={
                "Accept": "application/json;q=0.9,*/*;q=0.8",
                "Accept-Encoding": "gzip",
                "User-Agent": self.user_agent,
            },
        )


def card_title_aliases(card: CardSearchResult) -> tuple[str, ...]:
    """Build whole-title, face-title, and pre-comma aliases for fuzzy ranking."""

    names = [card.name, *(face.name for face in card.card_faces)]
    aliases: set[str] = set()
    for name in names:
        if normalized := normalize_card_title(name):
            aliases.add(normalized)
        if "," in name and (short_name := normalize_card_title(name.split(",", 1)[0])):
            aliases.add(short_name)
    return tuple(sorted(aliases)) or (card.name.casefold(),)


def normalize_card_title(value: str) -> str:
    """Normalize punctuation and whitespace while preserving title words."""

    import re

    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def _build_database(
    path: Path,
    payloads: Iterator[object],
    *,
    source_updated_at: str,
    source_uri: str,
) -> tuple[int, int, int]:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode = DELETE;
            PRAGMA synchronous = OFF;
            PRAGMA temp_store = MEMORY;

            CREATE TABLE metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;

            CREATE TABLE printings (
                scryfall_id TEXT PRIMARY KEY,
                oracle_id TEXT NOT NULL,
                name TEXT NOT NULL,
                released_at TEXT NOT NULL,
                card_json TEXT NOT NULL
            ) WITHOUT ROWID;

            CREATE TABLE cards (
                oracle_id TEXT PRIMARY KEY,
                scryfall_id TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                normalized_name TEXT NOT NULL,
                aliases_json TEXT NOT NULL,
                color_identity TEXT NOT NULL,
                mana_value REAL NOT NULL,
                price_eur TEXT,
                selection_key TEXT NOT NULL,
                card_json TEXT NOT NULL
            ) WITHOUT ROWID;
            """
        )

        printings = 0
        skipped = 0
        for payload in payloads:
            if not isinstance(payload, dict) or not _is_searchable_paper_card(payload):
                skipped += 1
                continue
            try:
                card = map_scryfall_card(payload)
            except (TypeError, ValueError, ValidationError):
                skipped += 1
                continue

            serialized = card.model_dump_json()
            released_at = str(payload.get("released_at") or "")
            connection.execute(
                """
                INSERT OR IGNORE INTO printings (
                    scryfall_id, oracle_id, name, released_at, card_json
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    str(card.scryfall_id),
                    str(card.oracle_id),
                    card.name,
                    released_at,
                    serialized,
                ),
            )
            printings += 1

            aliases = card_title_aliases(card)
            selection_key = _selection_key(card, payload)
            connection.execute(
                """
                INSERT INTO cards (
                    oracle_id, scryfall_id, name, normalized_name, aliases_json,
                    color_identity, mana_value, price_eur, selection_key, card_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(oracle_id) DO UPDATE SET
                    scryfall_id = excluded.scryfall_id,
                    name = excluded.name,
                    normalized_name = excluded.normalized_name,
                    aliases_json = excluded.aliases_json,
                    color_identity = excluded.color_identity,
                    mana_value = excluded.mana_value,
                    price_eur = excluded.price_eur,
                    selection_key = excluded.selection_key,
                    card_json = excluded.card_json
                WHERE excluded.selection_key > cards.selection_key
                """,
                (
                    str(card.oracle_id),
                    str(card.scryfall_id),
                    card.name,
                    normalize_card_title(card.name),
                    json.dumps(aliases, ensure_ascii=True, separators=(",", ":")),
                    "".join(card.color_identity),
                    card.mana_value,
                    str(card.prices.eur) if card.prices.eur is not None else None,
                    selection_key,
                    serialized,
                ),
            )

        card_count = int(connection.execute("SELECT count(*) FROM cards").fetchone()[0])
        metadata = {
            "schema_version": str(_SCHEMA_VERSION),
            "source_type": _BULK_TYPE,
            "source_updated_at": source_updated_at,
            "source_uri": source_uri,
            "card_count": str(card_count),
            "printing_count": str(printings),
            "skipped_count": str(skipped),
        }
        connection.executemany(
            "INSERT INTO metadata (key, value) VALUES (?, ?)",
            metadata.items(),
        )
        connection.executescript(
            """
            CREATE INDEX cards_name_idx ON cards(name COLLATE NOCASE);
            CREATE INDEX cards_color_identity_idx ON cards(color_identity);
            CREATE INDEX cards_mana_value_idx ON cards(mana_value);
            ANALYZE;
            """
        )
        connection.commit()
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity is None or integrity[0] != "ok":
            raise sqlite3.DatabaseError("Imported card catalog failed integrity check")
        connection.execute("PRAGMA synchronous = FULL")
        connection.commit()
        return card_count, printings, skipped
    finally:
        connection.close()


def _is_searchable_paper_card(payload: dict[str, Any]) -> bool:
    excluded_set_types = {"token", "memorabilia", "minigame"}
    excluded_layouts = {
        "art_series",
        "double_faced_token",
        "emblem",
        "planar",
        "scheme",
        "token",
        "vanguard",
    }
    return (
        payload.get("oracle_id") is not None
        and "paper" in payload.get("games", [])
        and payload.get("lang", "en") == "en"
        and payload.get("set_type") not in excluded_set_types
        and payload.get("layout") not in excluded_layouts
    )


def _selection_key(card: CardSearchResult, payload: dict[str, Any]) -> str:
    has_image = card.image_uris is not None or any(
        face.image_uris is not None for face in card.card_faces
    )
    score = (
        int(has_image) * 100
        + int(card.prices.eur is not None) * 10
        + int(not payload.get("promo", False))
    )
    return f"{score:03d}:{payload.get('released_at', '')}:{card.scryfall_id}"


def _read_only_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
