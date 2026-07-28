"""Local dense-vector index used only to sort filtered card candidates."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import tempfile
import threading
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from uuid import UUID

import numpy as np
from numpy.typing import NDArray

from mtg_deck_builder.card_catalog import CatalogEntry, SQLiteCardCatalog
from mtg_deck_builder.config import SemanticSortSettings
from mtg_deck_builder.domain import CardSearchResult
from mtg_deck_builder.providers.cards import CardSearchUnavailable

_SCHEMA_VERSION = 1
_DOCUMENT_TEMPLATE_VERSION = 1
_SQLITE_PARAMETER_BATCH = 900


class EmbeddingModel(Protocol):
    """Small model boundary so indexing and sorting remain deterministic in tests."""

    model_name: str

    def embed_passages(
        self,
        texts: Iterable[str],
        *,
        batch_size: int,
    ) -> Iterable[NDArray[np.floating]]:
        """Embed catalog documents."""

    def embed_query(self, text: str) -> NDArray[np.floating]:
        """Embed one search intent."""


class FastEmbedModel:
    """Lazily load one local ONNX text-embedding model."""

    def __init__(self, *, model_name: str, cache_dir: Path, threads: int) -> None:
        self.model_name = model_name
        self._cache_dir = cache_dir
        self._threads = threads
        self._model: Any | None = None
        self._lock = threading.Lock()

    def embed_passages(
        self,
        texts: Iterable[str],
        *,
        batch_size: int,
    ) -> Iterable[NDArray[np.floating]]:
        with self._lock:
            model = self._get_model()
            yield from model.passage_embed(texts, batch_size=batch_size)

    def embed_query(self, text: str) -> NDArray[np.floating]:
        with self._lock:
            model = self._get_model()
            try:
                return next(iter(model.query_embed(text, batch_size=1)))
            except StopIteration as exc:
                raise CardSearchUnavailable("semantic model returned no query vector") from exc

    def _get_model(self) -> Any:
        if self._model is None:
            self._cache_dir.mkdir(parents=True, exist_ok=True)
            try:
                from fastembed import TextEmbedding

                self._model = TextEmbedding(
                    model_name=self.model_name,
                    cache_dir=str(self._cache_dir),
                    threads=self._threads,
                )
            except Exception as exc:
                raise CardSearchUnavailable("semantic model could not be loaded") from exc
        return self._model


@dataclass(frozen=True)
class SemanticIndexSyncResult:
    """Summary returned after checking or rebuilding the semantic index."""

    status: str
    cards: int
    dimensions: int
    model: str
    path: Path


@dataclass(frozen=True)
class SemanticScoreResult:
    """Semantic scores plus reproducibility metadata for one tool call."""

    scores: dict[UUID, float]
    model: str
    dimensions: int


class SemanticCardIndex:
    """Build and query an atomic SQLite sidecar containing normalized vectors."""

    def __init__(
        self,
        *,
        path: Path,
        catalog: SQLiteCardCatalog,
        settings: SemanticSortSettings,
        model: EmbeddingModel | None = None,
        progress: Callable[[int, int], None] | None = None,
    ) -> None:
        self.path = path
        self._catalog = catalog
        self._settings = settings
        self._model = model or FastEmbedModel(
            model_name=settings.model,
            cache_dir=settings.cache_dir,
            threads=settings.threads,
        )
        self._progress = progress
        self._sync_lock = asyncio.Lock()
        self._score_lock = asyncio.Lock()

    async def sync(self, *, force: bool = False) -> SemanticIndexSyncResult:
        """Build the sidecar when its catalog or embedding settings are stale."""

        async with self._sync_lock:
            expected = self._expected_metadata()
            installed = await asyncio.to_thread(self._read_metadata)
            if not force and all(installed.get(key) == value for key, value in expected.items()):
                return SemanticIndexSyncResult(
                    status="current",
                    cards=int(installed["card_count"]),
                    dimensions=int(installed["dimensions"]),
                    model=installed["model"],
                    path=self.path,
                )
            entries = await self._catalog.entries()
            return await asyncio.to_thread(self._build, entries, expected)

    async def score(
        self,
        query: str,
        oracle_ids: Sequence[UUID],
    ) -> SemanticScoreResult:
        """Cosine-sort candidates without applying a similarity cutoff."""

        if not oracle_ids:
            return SemanticScoreResult(
                scores={},
                model=self._settings.model,
                dimensions=0,
            )
        async with self._score_lock:
            expected = self._expected_metadata()
            installed = await asyncio.to_thread(self._read_metadata)
            if not all(installed.get(key) == value for key, value in expected.items()):
                raise CardSearchUnavailable(
                    "semantic index is missing or stale; run npm run catalog:sync"
                )
            query_vector = await asyncio.to_thread(self._model.embed_query, query)
            return await asyncio.to_thread(
                self._score_vectors,
                oracle_ids,
                query_vector,
                installed,
            )

    def _expected_metadata(self) -> dict[str, str]:
        catalog_metadata = self._catalog.metadata()
        try:
            catalog_mtime_ns = self._catalog.path.stat().st_mtime_ns
        except OSError as exc:
            raise CardSearchUnavailable("card catalog is unavailable") from exc
        return {
            "schema_version": str(_SCHEMA_VERSION),
            "document_template_version": str(_DOCUMENT_TEMPLATE_VERSION),
            "model": self._settings.model,
            "indexed_fields": json.dumps(
                self._settings.indexed_fields,
                ensure_ascii=True,
                separators=(",", ":"),
            ),
            "catalog_schema_version": catalog_metadata.get("schema_version", ""),
            "catalog_source_updated_at": catalog_metadata.get("source_updated_at", ""),
            "catalog_card_count": catalog_metadata.get("card_count", ""),
            "catalog_mtime_ns": str(catalog_mtime_ns),
        }

    def _read_metadata(self) -> dict[str, str]:
        if not self.path.is_file():
            return {}
        try:
            with _read_only_connection(self.path) as connection:
                return dict(connection.execute("SELECT key, value FROM metadata"))
        except sqlite3.Error:
            return {}

    def _build(
        self,
        entries: tuple[CatalogEntry, ...],
        expected: dict[str, str],
    ) -> SemanticIndexSyncResult:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        file_descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            suffix=".tmp",
            dir=self.path.parent,
        )
        os.close(file_descriptor)
        temporary_path = Path(temporary_name)
        connection = sqlite3.connect(temporary_path)
        dimensions: int | None = None
        count = 0
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

                CREATE TABLE embeddings (
                    oracle_id TEXT PRIMARY KEY,
                    document_hash TEXT NOT NULL,
                    vector BLOB NOT NULL
                ) WITHOUT ROWID;
                """
            )
            documents = (
                render_semantic_document(entry.card, self._settings.indexed_fields)
                for entry in entries
            )
            vectors = self._model.embed_passages(
                documents,
                batch_size=self._settings.batch_size,
            )
            for entry, document, raw_vector in zip(
                entries,
                (
                    render_semantic_document(card.card, self._settings.indexed_fields)
                    for card in entries
                ),
                vectors,
                strict=True,
            ):
                vector = _normalized_vector(raw_vector)
                if dimensions is None:
                    dimensions = int(vector.size)
                elif vector.size != dimensions:
                    raise ValueError("semantic model returned inconsistent dimensions")
                connection.execute(
                    """
                    INSERT INTO embeddings (oracle_id, document_hash, vector)
                    VALUES (?, ?, ?)
                    """,
                    (
                        str(entry.card.oracle_id),
                        hashlib.sha256(document.encode("utf-8")).hexdigest(),
                        vector.tobytes(),
                    ),
                )
                count += 1
                if self._progress is not None and (count == len(entries) or count % 1_000 == 0):
                    self._progress(count, len(entries))
            if count != len(entries):
                raise ValueError("semantic model did not return one vector per card")
            dimensions = dimensions or 0
            metadata = {
                **expected,
                "card_count": str(count),
                "dimensions": str(dimensions),
            }
            connection.executemany(
                "INSERT INTO metadata (key, value) VALUES (?, ?)",
                metadata.items(),
            )
            connection.commit()
            integrity = connection.execute("PRAGMA integrity_check").fetchone()
            if integrity is None or integrity[0] != "ok":
                raise sqlite3.DatabaseError("semantic index failed integrity check")
            connection.execute("PRAGMA synchronous = FULL")
            connection.commit()
            connection.close()
            os.replace(temporary_path, self.path)
        except BaseException:
            connection.close()
            temporary_path.unlink(missing_ok=True)
            raise
        return SemanticIndexSyncResult(
            status="imported",
            cards=count,
            dimensions=dimensions,
            model=self._settings.model,
            path=self.path,
        )

    def _score_vectors(
        self,
        oracle_ids: Sequence[UUID],
        raw_query_vector: NDArray[np.floating],
        metadata: dict[str, str],
    ) -> SemanticScoreResult:
        query_vector = _normalized_vector(raw_query_vector)
        expected_dimensions = int(metadata["dimensions"])
        if query_vector.size != expected_dimensions:
            raise CardSearchUnavailable("semantic query dimensions do not match the index")

        requested = {str(oracle_id): oracle_id for oracle_id in oracle_ids}
        rows: dict[str, bytes] = {}
        with _read_only_connection(self.path) as connection:
            identifiers = list(requested)
            for start in range(0, len(identifiers), _SQLITE_PARAMETER_BATCH):
                batch = identifiers[start : start + _SQLITE_PARAMETER_BATCH]
                placeholders = ",".join("?" for _ in batch)
                for oracle_id, vector in connection.execute(
                    f"SELECT oracle_id, vector FROM embeddings WHERE oracle_id IN ({placeholders})",
                    batch,
                ):
                    rows[oracle_id] = vector
        if rows.keys() != requested.keys():
            raise CardSearchUnavailable("semantic index does not cover every candidate")

        ordered_ids = list(requested)
        matrix = np.vstack(
            [np.frombuffer(rows[oracle_id], dtype=np.float32) for oracle_id in ordered_ids]
        )
        cosine_scores = matrix @ query_vector
        normalized_scores = np.clip((cosine_scores + 1.0) / 2.0, 0.0, 1.0)
        return SemanticScoreResult(
            scores={
                requested[oracle_id]: float(score)
                for oracle_id, score in zip(ordered_ids, normalized_scores, strict=True)
            },
            model=metadata["model"],
            dimensions=expected_dimensions,
        )


def render_semantic_document(
    card: CardSearchResult,
    indexed_fields: Sequence[str],
) -> str:
    """Render stable gameplay text for one card embedding."""

    fields = set(indexed_fields)
    sections: list[str] = []
    if "name" in fields:
        sections.append(f"Name: {card.name}")
    if "mana_cost" in fields:
        mana = " // ".join(
            filter(None, [card.mana_cost, *(face.mana_cost for face in card.card_faces)])
        )
        sections.append(f"Mana cost: {mana or 'none'}")
    if "type_line" in fields:
        types = " // ".join(
            filter(None, [card.type_line, *(face.type_line for face in card.card_faces)])
        )
        sections.append(f"Type: {types}")
    if "oracle_text" in fields:
        oracle = "\n".join(
            filter(None, [card.oracle_text, *(face.oracle_text for face in card.card_faces)])
        )
        sections.append(f"Rules: {oracle or 'none'}")
    if "power_toughness" in fields:
        characteristics = _power_toughness_text(card)
        sections.append(f"Power/toughness: {characteristics or 'not applicable'}")
    if "card_faces" in fields and card.card_faces:
        faces = "\n".join(
            (
                f"{face.name}: {face.mana_cost or 'no mana cost'}; "
                f"{face.type_line or 'no type'}; {face.oracle_text or 'no rules text'}; "
                f"{face.power or '?'}/{face.toughness or '?'}"
            )
            for face in card.card_faces
        )
        sections.append(f"Faces:\n{faces}")
    return "\n".join(sections)


def _power_toughness_text(card: CardSearchResult) -> str:
    if card.card_faces:
        return " // ".join(
            f"{face.power or '?'}/{face.toughness or '?'}"
            for face in card.card_faces
            if face.power is not None or face.toughness is not None
        )
    if card.power is None and card.toughness is None:
        return ""
    return f"{card.power or '?'}/{card.toughness or '?'}"


def _normalized_vector(raw_vector: NDArray[np.floating]) -> NDArray[np.float32]:
    vector = np.asarray(raw_vector, dtype=np.float32).reshape(-1)
    magnitude = float(np.linalg.norm(vector))
    if not np.isfinite(magnitude) or magnitude <= 0:
        raise ValueError("semantic model returned an invalid vector")
    return vector / magnitude


def _read_only_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
