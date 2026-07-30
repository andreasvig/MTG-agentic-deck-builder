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
from mtg_deck_builder.config import SemanticDocumentSettings, SemanticSortSettings
from mtg_deck_builder.domain import CardFace, CardSearchResult
from mtg_deck_builder.providers.cards import CardSearchUnavailable
from mtg_deck_builder.tagger_catalog import SQLiteTaggerCatalog, TaggerCatalogUnavailable

_SCHEMA_VERSION = 1
_DOCUMENT_TEMPLATE_VERSION = 2
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
        tagger_catalog: SQLiteTaggerCatalog | None = None,
        model: EmbeddingModel | None = None,
        progress: Callable[[int, int], None] | None = None,
    ) -> None:
        self.path = path
        self._catalog = catalog
        self._settings = settings
        self._tagger_catalog = tagger_catalog
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
            concepts: dict[UUID, tuple[str, ...]] = {}
            if self._settings.document.tags.enabled and self._tagger_catalog is not None:
                try:
                    snapshot = await asyncio.to_thread(
                        self._tagger_catalog.semantic_snapshot,
                        self._settings.document.tags,
                        total_cards=len(entries),
                    )
                except TaggerCatalogUnavailable as exc:
                    raise CardSearchUnavailable(
                        "Tagger concepts could not be loaded for semantic indexing"
                    ) from exc
                concepts = snapshot.concepts_by_oracle_id
                expected = self._expected_metadata(
                    tagger_metadata=snapshot.metadata,
                )
            return await asyncio.to_thread(
                self._build,
                entries,
                expected,
                concepts,
            )

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

    def _expected_metadata(
        self,
        *,
        tagger_metadata: dict[str, str] | None = None,
    ) -> dict[str, str]:
        catalog_metadata = self._catalog.metadata()
        try:
            catalog_mtime_ns = self._catalog.path.stat().st_mtime_ns
        except OSError as exc:
            raise CardSearchUnavailable("card catalog is unavailable") from exc
        resolved_tagger_metadata = (
            tagger_metadata if tagger_metadata is not None else self._semantic_tagger_metadata()
        )
        return {
            "schema_version": str(_SCHEMA_VERSION),
            "document_template_version": str(_DOCUMENT_TEMPLATE_VERSION),
            "model": self._settings.model,
            "document_settings": json.dumps(
                self._settings.document.model_dump(mode="json"),
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ),
            "tagger_snapshot": json.dumps(
                resolved_tagger_metadata,
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ),
            "catalog_schema_version": catalog_metadata.get("schema_version", ""),
            "catalog_source_updated_at": catalog_metadata.get("source_updated_at", ""),
            "catalog_card_count": catalog_metadata.get("card_count", ""),
            "catalog_mtime_ns": str(catalog_mtime_ns),
        }

    def _semantic_tagger_metadata(self) -> dict[str, str]:
        if not self._settings.document.tags.enabled:
            return {"status": "disabled"}
        if self._tagger_catalog is None:
            return {"status": "absent"}
        try:
            return self._tagger_catalog.semantic_metadata()
        except TaggerCatalogUnavailable as exc:
            raise CardSearchUnavailable(
                "Tagger metadata could not be loaded for semantic indexing"
            ) from exc

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
        concepts_by_oracle_id: dict[UUID, tuple[str, ...]],
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
                render_semantic_document(
                    entry.card,
                    self._settings.document,
                    concepts_by_oracle_id.get(entry.card.oracle_id, ()),
                )
                for entry in entries
            )
            vectors = self._model.embed_passages(
                documents,
                batch_size=self._settings.batch_size,
            )
            for entry, document, raw_vector in zip(
                entries,
                (
                    render_semantic_document(
                        card.card,
                        self._settings.document,
                        concepts_by_oracle_id.get(card.card.oracle_id, ()),
                    )
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
    settings: SemanticDocumentSettings,
    gameplay_concepts: Sequence[str] = (),
) -> str:
    """Render one deterministic, title-resistant gameplay document."""

    fields = set(settings.fields)
    sections: list[str] = []
    self_names = tuple(
        sorted(
            {card.name, *(face.name for face in card.card_faces)},
            key=len,
            reverse=True,
        )
    )
    if settings.include_name:
        sections.append(f"Card: {card.name}")
    if "mana_value" in fields:
        sections.append(f"Mana value: {_format_number(card.mana_value)}")

    if card.card_faces and "card_faces" in fields:
        face_sections = [
            _render_face_section(
                face,
                index=index,
                fields=fields,
                settings=settings,
                self_names=self_names,
            )
            for index, face in enumerate(card.card_faces, start=1)
        ]
        sections.append("Card faces:\n" + "\n\n".join(face_sections))
    else:
        sections.extend(
            _render_gameplay_fields(
                card,
                fields=fields,
                settings=settings,
                self_names=self_names,
            )
        )

    concepts = list(
        dict.fromkeys(concept.strip() for concept in gameplay_concepts if concept.strip())
    )
    if concepts and settings.tags.enabled:
        sections.append("Gameplay concepts: " + "; ".join(concepts))
    return "\n\n".join(section for section in sections if section)


def _render_face_section(
    face: CardFace,
    *,
    index: int,
    fields: set[str],
    settings: SemanticDocumentSettings,
    self_names: tuple[str, ...],
) -> str:
    heading = f"Face {index}"
    if settings.include_name:
        heading += f": {face.name}"
    details = _render_gameplay_fields(
        face,
        fields=fields,
        settings=settings,
        self_names=self_names,
    )
    return "\n".join([heading, *details])


def _render_gameplay_fields(
    card: CardSearchResult | CardFace,
    *,
    fields: set[str],
    settings: SemanticDocumentSettings,
    self_names: tuple[str, ...],
) -> list[str]:
    details: list[str] = []
    if "type_line" in fields and card.type_line:
        details.append(f"Type: {card.type_line}")
    if "mana_cost" in fields:
        details.append(
            "Mana cost: "
            + _semantic_mana_cost(
                card.mana_cost,
                explain_symbols=settings.explain_symbols,
            )
        )
    if "power_toughness" in fields and (card.power is not None or card.toughness is not None):
        details.append(f"Power/toughness: {card.power or '?'}/{card.toughness or '?'}")
    if "oracle_text" in fields and card.oracle_text:
        rules = _semantic_rules_text(
            card.oracle_text,
            self_names=self_names,
            normalize_self_references=settings.normalize_self_references,
            explain_symbols=settings.explain_symbols,
        )
        if rules:
            details.append("Abilities:\n" + "\n".join(f"- {line}" for line in rules))
    return details


def _semantic_mana_cost(
    mana_cost: str | None,
    *,
    explain_symbols: bool,
) -> str:
    if not mana_cost:
        return "none"
    if not explain_symbols or "{X}" not in mana_cost.upper():
        return mana_cost
    return f"{mana_cost} (contains variable X mana)"


def _semantic_rules_text(
    oracle_text: str,
    *,
    self_names: tuple[str, ...],
    normalize_self_references: bool,
    explain_symbols: bool,
) -> list[str]:
    text = oracle_text
    if normalize_self_references:
        for self_name in self_names:
            text = text.replace(self_name, "this card")
    if explain_symbols:
        replacements = {
            "{T}": "{T} (tap)",
            "{Q}": "{Q} (untap)",
            "{X}": "{X} (variable mana amount)",
        }
        for symbol, explanation in replacements.items():
            text = text.replace(symbol, explanation)
    return [line.strip() for line in text.splitlines() if line.strip()]


def _format_number(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def _normalized_vector(raw_vector: NDArray[np.floating]) -> NDArray[np.float32]:
    vector = np.asarray(raw_vector, dtype=np.float32).reshape(-1)
    magnitude = float(np.linalg.norm(vector))
    if not np.isfinite(magnitude) or magnitude <= 0:
        raise ValueError("semantic model returned an invalid vector")
    return vector / magnitude


def _read_only_connection(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
