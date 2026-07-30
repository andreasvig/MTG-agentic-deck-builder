"""On-demand EDHREC commander association cache and normalization service."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal
from uuid import UUID

from mtg_deck_builder.card_catalog import SQLiteCardCatalog
from mtg_deck_builder.providers.edhrec import (
    EdhrecDeckTheme,
    EdhrecJsonClient,
    EdhrecUnavailable,
    edhrec_slug,
)

_LOGGER = logging.getLogger(__name__)
_SCHEMA_VERSION = 2


class EdhrecCatalogUnavailable(RuntimeError):
    """Raised when fresh commander association data cannot be provided."""


@dataclass(frozen=True)
class EdhrecAssociation:
    """Normalized commander-to-Oracle-card recommendation evidence."""

    oracle_id: UUID
    num_decks: int
    potential_decks: int
    synergy: float | None

    @property
    def inclusion(self) -> float:
        """Return raw inclusion, preserving unknown potential as zero."""

        return self.num_decks / self.potential_decks if self.potential_decks > 0 else 0.0


@dataclass(frozen=True)
class EdhrecCommanderRanking:
    """Fresh association lookup used by one local filter-only search."""

    associations: dict[UUID, EdhrecAssociation]
    source: Literal["cache", "network"]


@dataclass(frozen=True)
class EdhrecCommanderContext:
    """Commander identity and its currently advertised EDHREC deck themes."""

    commander_oracle_id: UUID
    commander_name: str
    themes: tuple[EdhrecDeckTheme, ...]
    source: Literal["cache", "network"]


class SQLiteEdhrecCatalog:
    """Replaceable sidecar holding raw and normalized commander pages."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._schema_lock = threading.Lock()
        self._schema_ready = False

    def load_fresh(
        self,
        commander_oracle_id: UUID,
        *,
        refresh_after_days: int,
        now: datetime,
    ) -> EdhrecCommanderRanking | None:
        """Return cached associations only while the snapshot is fresh."""

        self._ensure_schema()
        cutoff = now - timedelta(days=refresh_after_days)
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                """
                SELECT fetched_at
                FROM commander_snapshots
                WHERE commander_oracle_id = ?
                """,
                (str(commander_oracle_id),),
            ).fetchone()
            if row is None:
                return None
            try:
                fetched_at = datetime.fromisoformat(row[0])
            except ValueError:
                return None
            if fetched_at.tzinfo is None:
                fetched_at = fetched_at.replace(tzinfo=UTC)
            if fetched_at < cutoff:
                return None
            rows = connection.execute(
                """
                SELECT related_oracle_id, num_decks, potential_decks, synergy
                FROM commander_associations
                WHERE commander_oracle_id = ?
                """,
                (str(commander_oracle_id),),
            )
            associations = {
                UUID(related_oracle_id): EdhrecAssociation(
                    oracle_id=UUID(related_oracle_id),
                    num_decks=num_decks,
                    potential_decks=potential_decks,
                    synergy=synergy,
                )
                for related_oracle_id, num_decks, potential_decks, synergy in rows
            }
        return (
            EdhrecCommanderRanking(associations=associations, source="cache")
            if associations
            else None
        )

    def save(
        self,
        *,
        commander_oracle_id: UUID,
        commander_name: str,
        commander_slug: str,
        fetched_at: datetime,
        raw_json: str,
        associations: dict[UUID, EdhrecAssociation],
        themes: tuple[EdhrecDeckTheme, ...] = (),
    ) -> None:
        """Transactionally replace one commander's raw and normalized snapshot."""

        self._ensure_schema()
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO commander_snapshots (
                    commander_oracle_id, commander_name, commander_slug,
                    fetched_at, raw_json
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(commander_oracle_id) DO UPDATE SET
                    commander_name = excluded.commander_name,
                    commander_slug = excluded.commander_slug,
                    fetched_at = excluded.fetched_at,
                    raw_json = excluded.raw_json
                """,
                (
                    str(commander_oracle_id),
                    commander_name,
                    commander_slug,
                    fetched_at.astimezone(UTC).isoformat(),
                    raw_json,
                ),
            )
            connection.execute(
                "DELETE FROM commander_associations WHERE commander_oracle_id = ?",
                (str(commander_oracle_id),),
            )
            connection.executemany(
                """
                INSERT INTO commander_associations (
                    commander_oracle_id, related_oracle_id,
                    num_decks, potential_decks, synergy
                ) VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        str(commander_oracle_id),
                        str(association.oracle_id),
                        association.num_decks,
                        association.potential_decks,
                        association.synergy,
                    )
                    for association in associations.values()
                ],
            )
            connection.execute(
                "DELETE FROM commander_themes WHERE commander_oracle_id = ?",
                (str(commander_oracle_id),),
            )
            connection.executemany(
                """
                INSERT INTO commander_themes (
                    commander_oracle_id, theme_slug, theme_name, deck_count
                ) VALUES (?, ?, ?, ?)
                """,
                [
                    (
                        str(commander_oracle_id),
                        theme.slug,
                        theme.name,
                        theme.deck_count,
                    )
                    for theme in themes
                ],
            )

    def load_context_fresh(
        self,
        commander_oracle_id: UUID,
        *,
        refresh_after_days: int,
        now: datetime,
        source: Literal["cache", "network"] = "cache",
    ) -> EdhrecCommanderContext | None:
        """Return cached commander metadata and themes while its base page is fresh."""

        self._ensure_schema()
        cutoff = now - timedelta(days=refresh_after_days)
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                """
                SELECT commander_name, fetched_at, raw_json
                FROM commander_snapshots
                WHERE commander_oracle_id = ?
                """,
                (str(commander_oracle_id),),
            ).fetchone()
            if row is None or not _is_fresh_timestamp(row[1], cutoff):
                return None
            themes = tuple(
                EdhrecDeckTheme(slug=slug, name=name, deck_count=deck_count)
                for slug, name, deck_count in connection.execute(
                    """
                    SELECT theme_slug, theme_name, deck_count
                    FROM commander_themes
                    WHERE commander_oracle_id = ?
                    ORDER BY deck_count DESC, theme_name COLLATE NOCASE
                    """,
                    (str(commander_oracle_id),),
                )
            )
            if not themes:
                themes = _themes_from_raw_json(row[2])
                if themes:
                    connection.executemany(
                        """
                        INSERT OR REPLACE INTO commander_themes (
                            commander_oracle_id, theme_slug, theme_name, deck_count
                        ) VALUES (?, ?, ?, ?)
                        """,
                        [
                            (
                                str(commander_oracle_id),
                                theme.slug,
                                theme.name,
                                theme.deck_count,
                            )
                            for theme in themes
                        ],
                    )
        return EdhrecCommanderContext(
            commander_oracle_id=commander_oracle_id,
            commander_name=row[0],
            themes=themes,
            source=source,
        )

    def load_theme_fresh(
        self,
        commander_oracle_id: UUID,
        theme_slug: str,
        *,
        refresh_after_days: int,
        now: datetime,
    ) -> EdhrecCommanderRanking | None:
        """Return one cached theme-specific ranking while its snapshot is fresh."""

        self._ensure_schema()
        cutoff = now - timedelta(days=refresh_after_days)
        with sqlite3.connect(self.path) as connection:
            row = connection.execute(
                """
                SELECT fetched_at
                FROM commander_theme_snapshots
                WHERE commander_oracle_id = ? AND theme_slug = ?
                """,
                (str(commander_oracle_id), theme_slug),
            ).fetchone()
            if row is None or not _is_fresh_timestamp(row[0], cutoff):
                return None
            rows = connection.execute(
                """
                SELECT related_oracle_id, num_decks, potential_decks, synergy
                FROM commander_theme_associations
                WHERE commander_oracle_id = ? AND theme_slug = ?
                """,
                (str(commander_oracle_id), theme_slug),
            )
            associations = {
                UUID(related_oracle_id): EdhrecAssociation(
                    oracle_id=UUID(related_oracle_id),
                    num_decks=num_decks,
                    potential_decks=potential_decks,
                    synergy=synergy,
                )
                for related_oracle_id, num_decks, potential_decks, synergy in rows
            }
        return (
            EdhrecCommanderRanking(associations=associations, source="cache")
            if associations
            else None
        )

    def save_theme(
        self,
        *,
        commander_oracle_id: UUID,
        theme_slug: str,
        fetched_at: datetime,
        raw_json: str,
        associations: dict[UUID, EdhrecAssociation],
    ) -> None:
        """Transactionally replace one commander-theme snapshot."""

        self._ensure_schema()
        with sqlite3.connect(self.path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO commander_theme_snapshots (
                    commander_oracle_id, theme_slug, fetched_at, raw_json
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(commander_oracle_id, theme_slug) DO UPDATE SET
                    fetched_at = excluded.fetched_at,
                    raw_json = excluded.raw_json
                """,
                (
                    str(commander_oracle_id),
                    theme_slug,
                    fetched_at.astimezone(UTC).isoformat(),
                    raw_json,
                ),
            )
            connection.execute(
                """
                DELETE FROM commander_theme_associations
                WHERE commander_oracle_id = ? AND theme_slug = ?
                """,
                (str(commander_oracle_id), theme_slug),
            )
            connection.executemany(
                """
                INSERT INTO commander_theme_associations (
                    commander_oracle_id, theme_slug, related_oracle_id,
                    num_decks, potential_decks, synergy
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        str(commander_oracle_id),
                        theme_slug,
                        str(association.oracle_id),
                        association.num_decks,
                        association.potential_decks,
                        association.synergy,
                    )
                    for association in associations.values()
                ],
            )

    def _ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with self._schema_lock:
            if self._schema_ready:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.path) as connection:
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS metadata (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    ) WITHOUT ROWID;

                    CREATE TABLE IF NOT EXISTS commander_snapshots (
                        commander_oracle_id TEXT PRIMARY KEY,
                        commander_name TEXT NOT NULL,
                        commander_slug TEXT NOT NULL,
                        fetched_at TEXT NOT NULL,
                        raw_json TEXT NOT NULL
                    ) WITHOUT ROWID;

                    CREATE TABLE IF NOT EXISTS commander_associations (
                        commander_oracle_id TEXT NOT NULL,
                        related_oracle_id TEXT NOT NULL,
                        num_decks INTEGER NOT NULL,
                        potential_decks INTEGER NOT NULL,
                        synergy REAL,
                        PRIMARY KEY (commander_oracle_id, related_oracle_id),
                        FOREIGN KEY (commander_oracle_id)
                            REFERENCES commander_snapshots(commander_oracle_id)
                            ON DELETE CASCADE
                    ) WITHOUT ROWID;

                    CREATE INDEX IF NOT EXISTS commander_associations_ranking
                    ON commander_associations (
                        commander_oracle_id,
                        num_decks DESC,
                        potential_decks DESC
                    );

                    CREATE TABLE IF NOT EXISTS commander_themes (
                        commander_oracle_id TEXT NOT NULL,
                        theme_slug TEXT NOT NULL,
                        theme_name TEXT NOT NULL,
                        deck_count INTEGER NOT NULL,
                        PRIMARY KEY (commander_oracle_id, theme_slug)
                    ) WITHOUT ROWID;

                    CREATE TABLE IF NOT EXISTS commander_theme_snapshots (
                        commander_oracle_id TEXT NOT NULL,
                        theme_slug TEXT NOT NULL,
                        fetched_at TEXT NOT NULL,
                        raw_json TEXT NOT NULL,
                        PRIMARY KEY (commander_oracle_id, theme_slug)
                    ) WITHOUT ROWID;

                    CREATE TABLE IF NOT EXISTS commander_theme_associations (
                        commander_oracle_id TEXT NOT NULL,
                        theme_slug TEXT NOT NULL,
                        related_oracle_id TEXT NOT NULL,
                        num_decks INTEGER NOT NULL,
                        potential_decks INTEGER NOT NULL,
                        synergy REAL,
                        PRIMARY KEY (
                            commander_oracle_id,
                            theme_slug,
                            related_oracle_id
                        )
                    ) WITHOUT ROWID;

                    CREATE INDEX IF NOT EXISTS commander_theme_associations_ranking
                    ON commander_theme_associations (
                        commander_oracle_id,
                        theme_slug,
                        num_decks DESC,
                        potential_decks DESC
                    );
                    """
                )
                existing = connection.execute(
                    "SELECT value FROM metadata WHERE key = 'schema_version'"
                ).fetchone()
                if existing is not None and int(existing[0]) not in {1, _SCHEMA_VERSION}:
                    raise EdhrecCatalogUnavailable("Unsupported EDHREC cache schema")
                connection.execute(
                    """
                    INSERT INTO metadata (key, value) VALUES ('schema_version', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (str(_SCHEMA_VERSION),),
                )
            self._schema_ready = True


class EdhrecCommanderService:
    """Use fresh cache data or fetch and normalize one commander page."""

    def __init__(
        self,
        *,
        cache: SQLiteEdhrecCatalog,
        card_catalog: SQLiteCardCatalog,
        client: EdhrecJsonClient,
        refresh_after_days: int,
    ) -> None:
        self._cache = cache
        self._card_catalog = card_catalog
        self._client = client
        self._refresh_after_days = refresh_after_days
        self._locks: dict[tuple[UUID, str | None], asyncio.Lock] = {}

    async def context_for(self, commander_oracle_id: UUID) -> EdhrecCommanderContext:
        """Return the selected commander and its available EDHREC themes."""

        ranking = await self.ranking_for(commander_oracle_id)
        try:
            context = await asyncio.to_thread(
                self._cache.load_context_fresh,
                commander_oracle_id,
                refresh_after_days=self._refresh_after_days,
                now=datetime.now(UTC),
                source=ranking.source,
            )
        except (OSError, sqlite3.Error, ValueError, EdhrecCatalogUnavailable) as exc:
            raise EdhrecCatalogUnavailable("EDHREC cache could not be read") from exc
        if context is None:
            raise EdhrecCatalogUnavailable("EDHREC commander context was unavailable")
        return context

    async def ranking_for(
        self,
        commander_oracle_id: UUID,
        theme_slug: str | None = None,
    ) -> EdhrecCommanderRanking:
        """Return fresh commander evidence, fetching at most once per commander."""

        commander = await self._card_catalog.card_by_oracle_id(str(commander_oracle_id))
        if commander is None:
            raise EdhrecCatalogUnavailable("The selected commander is not in the catalog")
        slug = edhrec_slug(commander.name)
        if theme_slug is not None:
            context = await self.context_for(commander_oracle_id)
            available = {theme.slug for theme in context.themes}
            if theme_slug not in available:
                raise EdhrecCatalogUnavailable(
                    "The selected EDHREC theme is not available for this commander"
                )

        lock = self._locks.setdefault((commander_oracle_id, theme_slug), asyncio.Lock())
        async with lock:
            now = datetime.now(UTC)
            try:
                if theme_slug is None:
                    cached = await asyncio.to_thread(
                        self._cache.load_fresh,
                        commander_oracle_id,
                        refresh_after_days=self._refresh_after_days,
                        now=now,
                    )
                else:
                    cached = await asyncio.to_thread(
                        self._cache.load_theme_fresh,
                        commander_oracle_id,
                        theme_slug,
                        refresh_after_days=self._refresh_after_days,
                        now=now,
                    )
            except (OSError, sqlite3.Error, ValueError, EdhrecCatalogUnavailable) as exc:
                raise EdhrecCatalogUnavailable("EDHREC cache could not be read") from exc
            if cached is not None:
                return cached

            try:
                if theme_slug is None:
                    page = await asyncio.to_thread(
                        self._client.fetch_commander,
                        slug,
                    )
                else:
                    page = await asyncio.to_thread(
                        self._client.fetch_commander,
                        slug,
                        theme_slug=theme_slug,
                    )
                printing_map = await self._card_catalog.oracle_ids_by_scryfall_ids(
                    [metric.scryfall_id for metric in page.cards]
                )
            except EdhrecUnavailable as exc:
                _LOGGER.warning("EDHREC fetch failed for %s: %s", commander.name, exc)
                raise EdhrecCatalogUnavailable(
                    "EDHREC commander data could not be fetched"
                ) from exc
            except Exception as exc:
                _LOGGER.warning("EDHREC normalization failed for %s: %s", commander.name, exc)
                raise EdhrecCatalogUnavailable(
                    "EDHREC commander data could not be normalized"
                ) from exc

            associations: dict[UUID, EdhrecAssociation] = {}
            for metric in page.cards:
                oracle_id = printing_map.get(metric.scryfall_id)
                if oracle_id is None or oracle_id == commander_oracle_id:
                    continue
                association = EdhrecAssociation(
                    oracle_id=oracle_id,
                    num_decks=metric.num_decks,
                    potential_decks=metric.potential_decks,
                    synergy=metric.synergy,
                )
                previous = associations.get(oracle_id)
                if previous is None or (
                    association.num_decks,
                    association.potential_decks,
                ) > (
                    previous.num_decks,
                    previous.potential_decks,
                ):
                    associations[oracle_id] = association

            if not associations:
                raise EdhrecCatalogUnavailable(
                    "EDHREC returned no cards available in the local catalog"
                )
            try:
                if theme_slug is None:
                    await asyncio.to_thread(
                        self._cache.save,
                        commander_oracle_id=commander_oracle_id,
                        commander_name=commander.name,
                        commander_slug=slug,
                        fetched_at=now,
                        raw_json=page.raw_json,
                        associations=associations,
                        themes=page.themes,
                    )
                else:
                    await asyncio.to_thread(
                        self._cache.save_theme,
                        commander_oracle_id=commander_oracle_id,
                        theme_slug=theme_slug,
                        fetched_at=now,
                        raw_json=page.raw_json,
                        associations=associations,
                    )
            except (OSError, sqlite3.Error, EdhrecCatalogUnavailable) as exc:
                raise EdhrecCatalogUnavailable("EDHREC cache could not be written") from exc
            return EdhrecCommanderRanking(associations=associations, source="network")


def _is_fresh_timestamp(value: str, cutoff: datetime) -> bool:
    try:
        fetched_at = datetime.fromisoformat(value)
    except ValueError:
        return False
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=UTC)
    return fetched_at >= cutoff


def _themes_from_raw_json(raw_json: str) -> tuple[EdhrecDeckTheme, ...]:
    """Backfill theme rows from a pre-theme cache's retained source payload."""

    try:
        taglinks = json.loads(raw_json).get("panels", {}).get("taglinks", [])
    except (AttributeError, json.JSONDecodeError):
        return ()
    if not isinstance(taglinks, list):
        return ()
    themes: list[EdhrecDeckTheme] = []
    for item in taglinks:
        if not isinstance(item, dict):
            continue
        slug = item.get("slug")
        name = item.get("value")
        deck_count = item.get("count")
        if (
            not isinstance(slug, str)
            or not slug
            or not isinstance(name, str)
            or not name.strip()
            or not isinstance(deck_count, int)
            or deck_count < 0
        ):
            continue
        themes.append(
            EdhrecDeckTheme(
                slug=slug,
                name=name.strip(),
                deck_count=deck_count,
            )
        )
    themes.sort(key=lambda theme: (-theme.deck_count, theme.name.casefold()))
    return tuple(themes)
