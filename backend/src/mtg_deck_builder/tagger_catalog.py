"""Atomic, resumable import of Scryfall Tagger Oracle-card data."""

from __future__ import annotations

import math
import os
import re
import sqlite3
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal, Protocol
from uuid import UUID

from mtg_deck_builder.config import SemanticTagDocumentSettings
from mtg_deck_builder.domain import (
    CardEnrichment,
    CardTag,
    CardTagFilter,
    CardTagMatch,
    RelatedOracleCard,
)
from mtg_deck_builder.providers.scryfall import name_similarity_score
from mtg_deck_builder.providers.tagger import (
    TaggerBulkOracleTag,
    TaggerEdge,
    TaggerEdgePage,
)

_SCHEMA_VERSION = 3
_ORACLE_TAG_CLASSIFIER = "ORACLE_CARD_TAG"

# Which `CardEnrichment` list a relationship belongs in, keyed by the classifier as
# it reads *from the highlighted card towards the listed one*. Tagger states every
# asymmetric relationship from its stronger or embodied side, so `BETTER_THAN` puts
# the listed card among the highlighted card's downgrades, and `WITH_BODY` means the
# listed card is the same effect without a creature attached. A classifier missing
# from this mapping is ignored rather than guessed at.
_INVERSE_CLASSIFIERS = {
    "SIMILAR_TO": "SIMILAR_TO",
    "REFERENCES_TO": "REFERENCED_BY",
    "REFERENCED_BY": "REFERENCES_TO",
    "BETTER_THAN": "WORSE_THAN",
    "WORSE_THAN": "BETTER_THAN",
    "MIRRORS": "MIRRORS",
    "COLORSHIFTED": "COLORSHIFTED",
    "WITH_BODY": "WITHOUT_BODY",
    "WITHOUT_BODY": "WITH_BODY",
    "RELATED_TO": "RELATED_TO",
}

_RELATED_CARD_GROUPS = {
    "SIMILAR_TO": "similar_cards",
    "REFERENCES_TO": "references",
    "REFERENCED_BY": "referenced_by",
    "WORSE_THAN": "upgrades",
    "BETTER_THAN": "downgrades",
    "MIRRORS": "variants",
    "COLORSHIFTED": "variants",
    "WITHOUT_BODY": "creature_versions",
    "WITH_BODY": "spell_versions",
    "RELATED_TO": "related_cards",
}


class TaggerCatalogUnavailable(RuntimeError):
    """Raised when the optional local Tagger sidecar cannot be read."""


class TaggerTagNotFound(ValueError):
    """Raised when a selected tag no longer exists in the local sidecar."""


@dataclass(frozen=True)
class TaggerSemanticSnapshot:
    """Bounded gameplay concepts plus source metadata for embedding builds."""

    concepts_by_oracle_id: dict[UUID, tuple[str, ...]]
    metadata: dict[str, str]


@dataclass(frozen=True)
class _SemanticTagCandidate:
    tag_id: str
    name: str
    description: str | None
    card_count: int
    oracle_ids: tuple[str, ...]


class SQLiteTaggerCatalog:
    """Read highlighted-card enrichment from the replaceable Tagger sidecar."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def card_enrichment(self, oracle_id: UUID) -> CardEnrichment:
        """Return tags and card relationships for one Oracle identity."""

        try:
            with self._connection() as connection:
                tag_rows = connection.execute(
                    """
                    SELECT tags.tag_id, tags.name, tags.slug, tags.description
                    FROM oracle_card_tags
                    JOIN tags USING (tag_id)
                    WHERE oracle_card_tags.oracle_id = ?
                    ORDER BY tags.name COLLATE NOCASE, tags.tag_id
                    """,
                    (str(oracle_id),),
                ).fetchall()
                relationship_rows = connection.execute(
                    """
                    SELECT subject_oracle_id, subject_name,
                           related_oracle_id, related_name,
                           classifier, classifier_inverse
                    FROM oracle_card_relationships
                    WHERE subject_oracle_id = ? OR related_oracle_id = ?
                    ORDER BY relationship_id
                    """,
                    (str(oracle_id), str(oracle_id)),
                ).fetchall()
        except sqlite3.Error as exc:
            raise TaggerCatalogUnavailable("Tagger sidecar could not be read") from exc

        tags = [
            CardTag(
                id=tag_id,
                name=name,
                slug=slug,
                description=description,
            )
            for tag_id, name, slug, description in tag_rows
        ]
        grouped: dict[str, dict[UUID, RelatedOracleCard]] = {
            group: {} for group in dict.fromkeys(_RELATED_CARD_GROUPS.values())
        }
        for (
            subject_id,
            subject_name,
            related_id,
            related_name,
            classifier,
            classifier_inverse,
        ) in relationship_rows:
            is_subject = subject_id == str(oracle_id)
            other_id = related_id if is_subject else subject_id
            other_name = related_name if is_subject else subject_name
            try:
                related_card = RelatedOracleCard(
                    oracle_id=other_id,
                    name=other_name,
                )
            except ValueError:
                continue

            # Each edge is stored once, from its subject's side, so an edge reached
            # through its related card has to be read backwards before it can be
            # grouped.
            direction = (
                str(classifier).upper()
                if is_subject
                else _inverse_classifier(classifier, classifier_inverse)
            )
            group = _RELATED_CARD_GROUPS.get(direction)
            if group is None:
                continue
            grouped[group][related_card.oracle_id] = related_card

        return CardEnrichment(
            oracle_id=oracle_id,
            tags=tags,
            **{group: _sorted_related_cards(cards) for group, cards in grouped.items()},
        )

    def search_tags(self, query: str, *, limit: int = 12) -> list[CardTagMatch]:
        """Fuzzy-rank local tag names without a minimum score threshold."""

        normalized_query = query.strip()
        if not normalized_query or limit < 1:
            return []
        rows = self._read_tag_rows()
        ranked = [
            CardTagMatch(
                id=tag_id,
                name=name,
                slug=slug,
                description=description,
                match_score=max(
                    name_similarity_score(normalized_query, name),
                    name_similarity_score(normalized_query, slug),
                ),
            )
            for tag_id, name, slug, description in rows
        ]
        ranked.sort(
            key=lambda tag: (
                -tag.match_score,
                abs(len(tag.name) - len(normalized_query)),
                tag.name.casefold(),
            ),
        )
        return ranked[:limit]

    def tag_filters(self, tag_ids: list[str]) -> list[CardTagFilter]:
        """Resolve selected IDs to canonical names in the caller's order."""

        if not tag_ids:
            return []
        unique_ids = list(dict.fromkeys(tag_ids))
        placeholders = ",".join("?" for _ in unique_ids)
        try:
            with self._connection() as connection:
                rows = connection.execute(
                    f"SELECT tag_id, name FROM tags WHERE tag_id IN ({placeholders})",
                    unique_ids,
                ).fetchall()
        except sqlite3.Error as exc:
            raise TaggerCatalogUnavailable("Tagger sidecar could not be read") from exc
        names = {str(tag_id): str(name) for tag_id, name in rows}
        missing = [tag_id for tag_id in unique_ids if tag_id not in names]
        if missing:
            raise TaggerTagNotFound(missing[0])
        return [CardTagFilter(id=tag_id, name=names[tag_id]) for tag_id in unique_ids]

    def oracle_ids_for_tags(self, tag_ids: list[str]) -> frozenset[UUID]:
        """Return Oracle cards carrying every selected tag."""

        if not tag_ids:
            return frozenset()
        unique_ids = list(dict.fromkeys(tag_ids))
        self.tag_filters(unique_ids)
        placeholders = ",".join("?" for _ in unique_ids)
        try:
            with self._connection() as connection:
                rows = connection.execute(
                    f"""
                    SELECT oracle_id
                    FROM oracle_card_tags
                    WHERE tag_id IN ({placeholders})
                    GROUP BY oracle_id
                    HAVING count(DISTINCT tag_id) = ?
                    """,
                    (*unique_ids, len(unique_ids)),
                ).fetchall()
        except sqlite3.Error as exc:
            raise TaggerCatalogUnavailable("Tagger sidecar could not be read") from exc
        oracle_ids: set[UUID] = set()
        for (oracle_id,) in rows:
            try:
                oracle_ids.add(UUID(str(oracle_id)))
            except ValueError:
                continue
        return frozenset(oracle_ids)

    def semantic_metadata(self) -> dict[str, str]:
        """Return the source identity that invalidates semantic document v2."""

        if not self.path.is_file():
            return {"status": "absent"}
        try:
            stat = self.path.stat()
            with self._connection() as connection:
                return self._semantic_metadata_from_connection(
                    connection,
                    mtime_ns=stat.st_mtime_ns,
                )
        except (OSError, sqlite3.Error, KeyError, ValueError) as exc:
            raise TaggerCatalogUnavailable("Tagger sidecar metadata is invalid") from exc

    def semantic_snapshot(
        self,
        settings: SemanticTagDocumentSettings,
        *,
        total_cards: int,
    ) -> TaggerSemanticSnapshot:
        """Select stable, bounded Tagger concepts for every catalog card."""

        if not settings.enabled or not self.path.is_file():
            return TaggerSemanticSnapshot(
                concepts_by_oracle_id={},
                metadata={"status": "disabled" if not settings.enabled else "absent"},
            )
        maximum_card_count = max(1, int(total_cards * settings.maximum_card_fraction))
        excluded = set(settings.excluded)
        try:
            stat = self.path.stat()
            with self._connection() as connection:
                metadata = self._semantic_metadata_from_connection(
                    connection,
                    mtime_ns=stat.st_mtime_ns,
                )
                rows = connection.execute(
                    """
                    SELECT tags.tag_id, tags.name, tags.description, count(*) AS card_count
                    FROM tags
                    JOIN oracle_card_tags USING (tag_id)
                    GROUP BY tags.tag_id, tags.name, tags.description
                    HAVING count(*) >= ? AND count(*) <= ?
                    ORDER BY tags.tag_id
                    """,
                    (settings.minimum_card_count, maximum_card_count),
                ).fetchall()
                eligible = {
                    str(tag_id): (
                        str(name),
                        str(description) if description is not None else None,
                        int(card_count),
                    )
                    for tag_id, name, description, card_count in rows
                    if not _semantic_tag_is_excluded(str(name), excluded)
                }
                memberships: dict[str, list[str]] = {tag_id: [] for tag_id in eligible}
                for tag_id, oracle_id in connection.execute(
                    """
                    SELECT tag_id, oracle_id
                    FROM oracle_card_tags
                    ORDER BY tag_id, oracle_id
                    """
                ):
                    normalized_tag_id = str(tag_id)
                    if normalized_tag_id in memberships:
                        memberships[normalized_tag_id].append(str(oracle_id))
        except (OSError, sqlite3.Error, KeyError, ValueError) as exc:
            raise TaggerCatalogUnavailable("Tagger concepts could not be read") from exc

        candidates = [
            _SemanticTagCandidate(
                tag_id=tag_id,
                name=name,
                description=description,
                card_count=card_count,
                oracle_ids=tuple(memberships[tag_id]),
            )
            for tag_id, (name, description, card_count) in eligible.items()
            if memberships[tag_id]
        ]
        if settings.collapse_equivalent_memberships:
            candidates = _collapse_equivalent_tags(candidates, settings.aliases)

        concepts_by_raw_id: dict[str, dict[str, int]] = {}
        for candidate in candidates:
            concept = _semantic_concept_text(candidate, settings)
            if not concept:
                continue
            for oracle_id in candidate.oracle_ids:
                concepts = concepts_by_raw_id.setdefault(oracle_id, {})
                concepts[concept] = min(
                    candidate.card_count,
                    concepts.get(concept, candidate.card_count),
                )

        concepts_by_oracle_id: dict[UUID, tuple[str, ...]] = {}
        for raw_oracle_id, concepts in concepts_by_raw_id.items():
            try:
                oracle_id = UUID(raw_oracle_id)
            except ValueError:
                continue
            if settings.prefer_specific_tags:
                concepts = _remove_subsumed_concepts(concepts)
            ranked = sorted(
                concepts.items(),
                key=lambda item: (
                    item[1] if settings.prefer_specific_tags else 0,
                    item[0].casefold(),
                ),
            )
            concepts_by_oracle_id[oracle_id] = tuple(
                concept for concept, _ in ranked[: settings.maximum_per_card]
            )
        return TaggerSemanticSnapshot(
            concepts_by_oracle_id=concepts_by_oracle_id,
            metadata=metadata,
        )

    @staticmethod
    def _semantic_metadata_from_connection(
        connection: sqlite3.Connection,
        *,
        mtime_ns: int,
    ) -> dict[str, str]:
        metadata = dict(connection.execute("SELECT key, value FROM metadata"))
        return {
            "status": "available",
            "schema_version": str(metadata["schema_version"]),
            "sync_completed_at": str(metadata["sync_completed_at"]),
            "tag_count": str(metadata["tag_count"]),
            "oracle_card_tagging_count": str(metadata["oracle_card_tagging_count"]),
            "mtime_ns": str(mtime_ns),
        }

    def _read_tag_rows(self) -> list[tuple[str, str, str, str | None]]:
        try:
            with self._connection() as connection:
                return [
                    (str(tag_id), str(name), str(slug), description)
                    for tag_id, name, slug, description in connection.execute(
                        """
                        SELECT tag_id, name, slug, description
                        FROM tags
                        ORDER BY name COLLATE NOCASE, tag_id
                        """
                    )
                ]
        except sqlite3.Error as exc:
            raise TaggerCatalogUnavailable("Tagger sidecar could not be read") from exc

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        if not self.path.is_file():
            raise TaggerCatalogUnavailable("Tagger sidecar has not been imported")
        connection = sqlite3.connect(
            f"file:{self.path.resolve()}?mode=ro",
            uri=True,
        )
        try:
            yield connection
        finally:
            connection.close()


def _collapse_equivalent_tags(
    candidates: list[_SemanticTagCandidate],
    aliases: dict[str, str],
) -> list[_SemanticTagCandidate]:
    selected: dict[tuple[str, ...], _SemanticTagCandidate] = {}
    for candidate in candidates:
        incumbent = selected.get(candidate.oracle_ids)
        if incumbent is None or _semantic_tag_preference(
            candidate,
            aliases,
        ) < _semantic_tag_preference(incumbent, aliases):
            selected[candidate.oracle_ids] = candidate
    return list(selected.values())


def _semantic_tag_is_excluded(name: str, excluded: set[str]) -> bool:
    name_tokens = tuple(name.replace("-", " ").casefold().split())
    return any(_contains_token_sequence(name_tokens, tuple(phrase.split())) for phrase in excluded)


def _remove_subsumed_concepts(concepts: dict[str, int]) -> dict[str, int]:
    tokenized = {concept: tuple(concept.casefold().split()) for concept in concepts}
    selected: dict[str, int] = {}
    for concept, card_count in concepts.items():
        concept_tokens = tokenized[concept]
        is_subsumed = any(
            _contains_token_sequence(other_tokens, concept_tokens)
            for other, other_tokens in tokenized.items()
            if other != concept and len(other_tokens) > len(concept_tokens)
        )
        if not is_subsumed:
            selected[concept] = card_count
    return selected


def _contains_token_sequence(
    container: tuple[str, ...],
    contained: tuple[str, ...],
) -> bool:
    return any(
        container[start : start + len(contained)] == contained
        for start in range(len(container) - len(contained) + 1)
    )


def _semantic_tag_preference(
    candidate: _SemanticTagCandidate,
    aliases: dict[str, str],
) -> tuple[bool, int, str]:
    concept = _normalize_semantic_concept(candidate.name, aliases)
    return (
        not bool(candidate.description),
        len(concept),
        concept.casefold(),
    )


def _semantic_concept_text(
    candidate: _SemanticTagCandidate,
    settings: SemanticTagDocumentSettings,
) -> str:
    concept = _normalize_semantic_concept(candidate.name, settings.aliases)
    if not concept:
        return ""
    if not settings.include_descriptions or not candidate.description:
        return concept
    description = re.sub(
        r"\[([^\]]+)\]\([^)]+\)",
        r"\1",
        candidate.description,
    )
    description = " ".join(description.split())
    if len(description) > settings.description_max_characters:
        description = (
            description[: settings.description_max_characters].rsplit(" ", 1)[0].rstrip() + "…"
        )
    return f"{concept}: {description}" if description else concept


def _normalize_semantic_concept(name: str, aliases: dict[str, str]) -> str:
    concept = " ".join(name.replace("-", " ").split()).casefold()
    if aliases:
        choices = "|".join(re.escape(source) for source in sorted(aliases, key=len, reverse=True))
        concept = re.sub(
            rf"(?<!\w)({choices})(?!\w)",
            lambda match: aliases[match.group(1).casefold()],
            concept,
            flags=re.IGNORECASE,
        )
    return " ".join(concept.split())


def _inverse_classifier(classifier: str, published_inverse: str | None = None) -> str:
    """Read a classifier from the other card's side.

    The local table wins over the inverse Tagger publishes, because these pairings
    were confirmed against the real sidecar and a wrong inverse in the feed would
    otherwise silently invert a whole list — showing a card's upgrades as its
    downgrades. The published value is only consulted for a classifier this table
    does not know, which `_RELATED_CARD_GROUPS` then ignores anyway.
    """

    normalized = str(classifier).upper()
    known = _INVERSE_CLASSIFIERS.get(normalized)
    if known is not None:
        return known
    return str(published_inverse or normalized).upper()


def _sorted_related_cards(
    cards: dict[UUID, RelatedOracleCard],
) -> list[RelatedOracleCard]:
    return sorted(cards.values(), key=lambda card: (card.name.casefold(), str(card.oracle_id)))


class TaggerEdgeSource(Protocol):
    def fetch_oracle_tags(self) -> list[TaggerBulkOracleTag]: ...

    def search_edges(
        self,
        *,
        edge_type: Literal["TAGGING", "RELATIONSHIP"],
        page: int,
        classifiers: list[str] | None = None,
    ) -> TaggerEdgePage: ...


@dataclass(frozen=True)
class TaggerSyncResult:
    """Summary returned by a Tagger sidecar refresh."""

    status: Literal["imported", "current"]
    tags: int
    oracle_card_taggings: int
    oracle_card_relationships: int
    path: Path
    completed_at: str


class TaggerCatalogSync:
    """Download Tagger edges into a separately replaceable SQLite sidecar."""

    def __init__(
        self,
        *,
        target: Path,
        source: TaggerEdgeSource,
        concurrent_requests: int,
        refresh_after_hours: float,
        oracle_names: dict[str, str] | None = None,
        progress: Callable[[str, int, int], None] | None = None,
    ) -> None:
        self.target = target
        self.source = source
        self.concurrent_requests = concurrent_requests
        self.refresh_after = timedelta(hours=refresh_after_hours)
        self.oracle_names = oracle_names or {}
        self.progress = progress

    def sync(self, *, force: bool = False) -> TaggerSyncResult:
        """Build or resume the sidecar and atomically install it when complete."""

        partial_path = self.target.with_name(f".{self.target.name}.partial")
        current = None if not force and partial_path.is_file() else self._current_result()
        if not force and current is not None:
            return current

        self.target.parent.mkdir(parents=True, exist_ok=True)
        if force:
            partial_path.unlink(missing_ok=True)
        connection = sqlite3.connect(partial_path)
        try:
            self._initialize_or_validate(connection)
            self._sync_oracle_tags(connection)
            self._sync_phase(
                connection,
                phase="oracle_card_relationships",
                edge_type="RELATIONSHIP",
                classifiers=None,
            )
            completed_at = datetime.now(UTC).isoformat()
            counts = self._finalize(connection, completed_at)
        except BaseException:
            connection.close()
            raise
        else:
            connection.close()
            os.replace(partial_path, self.target)

        return TaggerSyncResult(
            status="imported",
            tags=counts["tags"],
            oracle_card_taggings=counts["oracle_card_taggings"],
            oracle_card_relationships=counts["oracle_card_relationships"],
            path=self.target,
            completed_at=completed_at,
        )

    def _sync_oracle_tags(self, connection: sqlite3.Connection) -> None:
        phase = "oracle_card_tags_bulk"
        if self._completed_pages(connection, phase):
            self._report_progress(phase, 1, 1)
            return
        tags = self.source.fetch_oracle_tags()
        with connection:
            for tag in tags:
                self._store_bulk_tag(connection, tag)
            connection.execute(
                "INSERT INTO completed_pages (phase, page) VALUES (?, 1)",
                (phase,),
            )
            connection.executemany(
                """
                INSERT INTO metadata (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (
                    ("oracle_tag_bulk_tag_count", str(len(tags))),
                    (
                        "oracle_tag_bulk_membership_count",
                        str(sum(len(tag.oracle_ids) for tag in tags)),
                    ),
                ),
            )
        self._report_progress(phase, 1, 1)

    def _sync_phase(
        self,
        connection: sqlite3.Connection,
        *,
        phase: str,
        edge_type: Literal["TAGGING", "RELATIONSHIP"],
        classifiers: list[str] | None,
    ) -> None:
        first_page = self.source.search_edges(
            edge_type=edge_type,
            page=1,
            classifiers=classifiers,
        )
        self._store_page(connection, phase, first_page)
        total_pages = max(1, math.ceil(first_page.total / first_page.per_page))
        completed = self._completed_pages(connection, phase)
        missing_pages = [page for page in range(2, total_pages + 1) if page not in completed]
        self._report_progress(phase, len(completed), total_pages)

        window_size = max(self.concurrent_requests * 4, 1)
        with ThreadPoolExecutor(max_workers=self.concurrent_requests) as executor:
            for offset in range(0, len(missing_pages), window_size):
                page_window = missing_pages[offset : offset + window_size]
                futures = {
                    executor.submit(
                        self.source.search_edges,
                        edge_type=edge_type,
                        page=page,
                        classifiers=classifiers,
                    ): page
                    for page in page_window
                }
                for future in as_completed(futures):
                    result = future.result()
                    if result.page != futures[future]:
                        raise ValueError("Tagger returned a different page than requested")
                    if result.per_page != first_page.per_page:
                        raise ValueError("Tagger changed page size during synchronization")
                    self._store_page(connection, phase, result)
                    completed.add(result.page)
                    self._report_progress(phase, len(completed), total_pages)

        if len(self._completed_pages(connection, phase)) != total_pages:
            raise ValueError(f"Tagger phase {phase!r} did not complete every page")

    def _store_page(
        self,
        connection: sqlite3.Connection,
        phase: str,
        page: TaggerEdgePage,
    ) -> None:
        with connection:
            for edge in page.results:
                if edge.type == "TAGGING":
                    self._store_tagging(connection, edge)
                elif edge.type == "RELATIONSHIP" and edge.foreign_key == "oracleId":
                    self._store_relationship(connection, edge)
            connection.execute(
                """
                INSERT INTO completed_pages (phase, page)
                VALUES (?, ?)
                ON CONFLICT(phase, page) DO NOTHING
                """,
                (phase, page.page),
            )
            connection.executemany(
                """
                INSERT INTO metadata (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (
                    (f"{phase}_source_total", str(page.total)),
                    (f"{phase}_per_page", str(page.per_page)),
                ),
            )

    def _store_bulk_tag(
        self,
        connection: sqlite3.Connection,
        tag: TaggerBulkOracleTag,
    ) -> None:
        connection.execute(
            """
            INSERT INTO tags (
                tag_id, name, slug, namespace, tag_type, status, category,
                description, created_at, creator_id, pending_revisions,
                has_exemplary_tagging, raw_json
            ) VALUES (?, ?, ?, 'card', 'ORACLE_CARD_TAG', NULL, NULL, ?, NULL,
                      NULL, NULL, NULL, ?)
            ON CONFLICT(tag_id) DO UPDATE SET
                name = excluded.name,
                slug = excluded.slug,
                namespace = excluded.namespace,
                tag_type = excluded.tag_type,
                status = excluded.status,
                category = excluded.category,
                description = excluded.description,
                created_at = excluded.created_at,
                creator_id = excluded.creator_id,
                pending_revisions = excluded.pending_revisions,
                has_exemplary_tagging = excluded.has_exemplary_tagging,
                raw_json = excluded.raw_json
            """,
            (
                tag.id,
                tag.label.replace("-", " "),
                tag.label,
                tag.description,
                tag.model_dump_json(),
            ),
        )
        connection.executemany(
            """
            INSERT INTO oracle_cards (oracle_id, name)
            VALUES (?, ?)
            ON CONFLICT(oracle_id) DO UPDATE SET
                name = coalesce(excluded.name, oracle_cards.name)
            """,
            ((oracle_id, self.oracle_names.get(oracle_id)) for oracle_id in tag.oracle_ids),
        )
        connection.executemany(
            """
            INSERT INTO oracle_card_tags (
                oracle_id, tag_id, source_edge_id, weight, status,
                annotation, created_at, creator_id, pending_revisions
            ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
            ON CONFLICT(oracle_id, tag_id) DO NOTHING
            """,
            ((oracle_id, tag.id) for oracle_id in tag.oracle_ids),
        )

    @staticmethod
    def _store_tagging(connection: sqlite3.Connection, edge: TaggerEdge) -> None:
        if (
            edge.classifier != _ORACLE_TAG_CLASSIFIER
            or edge.foreign_key != "oracleId"
            or edge.tag is None
        ):
            return
        tag = edge.tag
        connection.execute(
            """
            INSERT INTO tags (
                tag_id, name, slug, namespace, tag_type, status, category,
                description, created_at, creator_id, pending_revisions,
                has_exemplary_tagging, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tag_id) DO UPDATE SET
                name = excluded.name,
                slug = excluded.slug,
                namespace = excluded.namespace,
                tag_type = excluded.tag_type,
                status = excluded.status,
                category = excluded.category,
                description = excluded.description,
                created_at = excluded.created_at,
                creator_id = excluded.creator_id,
                pending_revisions = excluded.pending_revisions,
                has_exemplary_tagging = excluded.has_exemplary_tagging,
                raw_json = excluded.raw_json
            """,
            (
                tag.id,
                tag.name,
                tag.slug,
                tag.namespace,
                tag.type,
                tag.status,
                int(tag.category),
                tag.description,
                tag.created_at,
                tag.creator_id,
                tag.pending_revisions,
                (int(tag.has_exemplary_tagging) if tag.has_exemplary_tagging is not None else None),
                tag.model_dump_json(by_alias=True),
            ),
        )
        connection.execute(
            """
            INSERT INTO oracle_cards (oracle_id, name)
            VALUES (?, ?)
            ON CONFLICT(oracle_id) DO UPDATE SET name = excluded.name
            """,
            (edge.subject_id, edge.subject_name),
        )
        connection.execute(
            """
            INSERT INTO oracle_card_tags (
                oracle_id, tag_id, source_edge_id, weight, status, annotation,
                created_at, creator_id, pending_revisions
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(oracle_id, tag_id) DO UPDATE SET
                source_edge_id = excluded.source_edge_id,
                weight = excluded.weight,
                status = excluded.status,
                annotation = excluded.annotation,
                created_at = excluded.created_at,
                creator_id = excluded.creator_id,
                pending_revisions = excluded.pending_revisions
            """,
            (
                edge.subject_id,
                tag.id,
                edge.id,
                edge.weight,
                edge.status,
                edge.annotation,
                edge.created_at,
                edge.creator_id,
                edge.pending_revisions,
            ),
        )

    @staticmethod
    def _store_relationship(connection: sqlite3.Connection, edge: TaggerEdge) -> None:
        connection.executemany(
            """
            INSERT INTO oracle_cards (oracle_id, name)
            VALUES (?, ?)
            ON CONFLICT(oracle_id) DO UPDATE SET
                name = coalesce(excluded.name, oracle_cards.name)
            """,
            (
                (edge.subject_id, edge.subject_name),
                (edge.related_id, edge.related_name or edge.name),
            ),
        )
        connection.execute(
            """
            INSERT INTO oracle_card_relationships (
                relationship_id, subject_oracle_id, subject_name,
                related_oracle_id, related_name, classifier,
                classifier_inverse, status, annotation, created_at, creator_id,
                pending_revisions, raw_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(relationship_id) DO UPDATE SET
                subject_oracle_id = excluded.subject_oracle_id,
                subject_name = excluded.subject_name,
                related_oracle_id = excluded.related_oracle_id,
                related_name = excluded.related_name,
                classifier = excluded.classifier,
                classifier_inverse = excluded.classifier_inverse,
                status = excluded.status,
                annotation = excluded.annotation,
                created_at = excluded.created_at,
                creator_id = excluded.creator_id,
                pending_revisions = excluded.pending_revisions,
                raw_json = excluded.raw_json
            """,
            (
                edge.id,
                edge.subject_id,
                edge.subject_name,
                edge.related_id,
                edge.related_name or edge.name or "",
                edge.classifier,
                edge.classifier_inverse,
                edge.status,
                edge.annotation,
                edge.created_at,
                edge.creator_id,
                edge.pending_revisions,
                edge.model_dump_json(by_alias=True),
            ),
        )

    @staticmethod
    def _initialize_or_validate(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            PRAGMA journal_mode = DELETE;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS tags (
                tag_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL,
                namespace TEXT NOT NULL,
                tag_type TEXT NOT NULL,
                status TEXT,
                category INTEGER,
                description TEXT,
                created_at TEXT,
                creator_id TEXT,
                pending_revisions INTEGER,
                has_exemplary_tagging INTEGER,
                raw_json TEXT NOT NULL
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS oracle_cards (
                oracle_id TEXT PRIMARY KEY,
                name TEXT
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS oracle_card_tags (
                oracle_id TEXT NOT NULL REFERENCES oracle_cards(oracle_id),
                tag_id TEXT NOT NULL REFERENCES tags(tag_id),
                source_edge_id TEXT,
                weight TEXT,
                status TEXT,
                annotation TEXT,
                created_at TEXT,
                creator_id TEXT,
                pending_revisions INTEGER,
                PRIMARY KEY (oracle_id, tag_id)
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS oracle_card_relationships (
                relationship_id TEXT PRIMARY KEY,
                subject_oracle_id TEXT NOT NULL,
                subject_name TEXT NOT NULL,
                related_oracle_id TEXT NOT NULL,
                related_name TEXT NOT NULL,
                classifier TEXT NOT NULL,
                classifier_inverse TEXT,
                status TEXT,
                annotation TEXT,
                created_at TEXT,
                creator_id TEXT,
                pending_revisions INTEGER,
                raw_json TEXT NOT NULL
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS completed_pages (
                phase TEXT NOT NULL,
                page INTEGER NOT NULL,
                PRIMARY KEY (phase, page)
            ) WITHOUT ROWID;
            """
        )
        existing = connection.execute(
            "SELECT value FROM metadata WHERE key = 'schema_version'"
        ).fetchone()
        if existing is not None and int(existing[0]) != _SCHEMA_VERSION:
            raise ValueError("Unsupported partial Tagger catalog schema; retry with --force")
        connection.execute(
            """
            INSERT INTO metadata (key, value)
            VALUES ('schema_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (str(_SCHEMA_VERSION),),
        )
        connection.commit()

    @staticmethod
    def _completed_pages(connection: sqlite3.Connection, phase: str) -> set[int]:
        return {
            int(row[0])
            for row in connection.execute(
                "SELECT page FROM completed_pages WHERE phase = ?",
                (phase,),
            )
        }

    def _finalize(
        self,
        connection: sqlite3.Connection,
        completed_at: str,
    ) -> dict[str, int]:
        counts = {
            "tags": int(connection.execute("SELECT count(*) FROM tags").fetchone()[0]),
            "oracle_card_taggings": int(
                connection.execute("SELECT count(*) FROM oracle_card_tags").fetchone()[0]
            ),
            "oracle_card_relationships": int(
                connection.execute("SELECT count(*) FROM oracle_card_relationships").fetchone()[0]
            ),
        }
        metadata = {
            "sync_completed_at": completed_at,
            "tag_source": "https://api.scryfall.com/private/tags/oracle",
            "relationship_source": "https://tagger.scryfall.com/graphql",
            "tag_count": str(counts["tags"]),
            "oracle_card_tagging_count": str(counts["oracle_card_taggings"]),
            "oracle_card_relationship_count": str(counts["oracle_card_relationships"]),
        }
        connection.executemany(
            """
            INSERT INTO metadata (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            metadata.items(),
        )
        connection.executescript(
            """
            CREATE INDEX IF NOT EXISTS tags_name_idx
                ON tags(name COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS oracle_card_tags_oracle_idx
                ON oracle_card_tags(oracle_id);
            CREATE INDEX IF NOT EXISTS oracle_card_tags_tag_idx
                ON oracle_card_tags(tag_id);
            CREATE INDEX IF NOT EXISTS relationships_subject_idx
                ON oracle_card_relationships(subject_oracle_id);
            CREATE INDEX IF NOT EXISTS relationships_related_idx
                ON oracle_card_relationships(related_oracle_id);
            CREATE INDEX IF NOT EXISTS relationships_classifier_idx
                ON oracle_card_relationships(classifier);
            ANALYZE;
            """
        )
        connection.commit()
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity is None or integrity[0] != "ok":
            raise sqlite3.DatabaseError("Tagger sidecar failed integrity check")
        return counts

    def _current_result(self) -> TaggerSyncResult | None:
        if not self.target.is_file():
            return None
        try:
            with sqlite3.connect(
                f"file:{self.target.resolve()}?mode=ro",
                uri=True,
            ) as connection:
                metadata = dict(connection.execute("SELECT key, value FROM metadata"))
            completed_at = datetime.fromisoformat(metadata["sync_completed_at"])
            if datetime.now(UTC) - completed_at > self.refresh_after:
                return None
            if int(metadata["schema_version"]) != _SCHEMA_VERSION:
                return None
            return TaggerSyncResult(
                status="current",
                tags=int(metadata["tag_count"]),
                oracle_card_taggings=int(metadata["oracle_card_tagging_count"]),
                oracle_card_relationships=int(metadata["oracle_card_relationship_count"]),
                path=self.target,
                completed_at=completed_at.isoformat(),
            )
        except (KeyError, OSError, sqlite3.Error, ValueError):
            return None

    def _report_progress(self, phase: str, completed: int, total: int) -> None:
        if self.progress is not None:
            self.progress(phase, completed, total)


def load_oracle_names(card_catalog_path: Path) -> dict[str, str]:
    """Read the local catalog's Oracle names for sidecar convenience columns."""

    if not card_catalog_path.is_file():
        return {}
    try:
        with sqlite3.connect(
            f"file:{card_catalog_path.resolve()}?mode=ro",
            uri=True,
        ) as connection:
            return {
                str(oracle_id): str(name)
                for oracle_id, name in connection.execute("SELECT oracle_id, name FROM cards")
            }
    except sqlite3.Error:
        return {}
