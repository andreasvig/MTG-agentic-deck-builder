import io
import json
import sqlite3
import threading
from pathlib import Path
from urllib.request import Request
from uuid import UUID

import pytest

from mtg_deck_builder.config import SemanticTagDocumentSettings
from mtg_deck_builder.providers.tagger import (
    TaggerBulkOracleTag,
    TaggerClient,
    TaggerEdge,
    TaggerEdgePage,
)
from mtg_deck_builder.tagger_catalog import (
    SQLiteTaggerCatalog,
    TaggerCatalogSync,
    TaggerCatalogUnavailable,
)


def tag_edge(
    edge_id: str,
    *,
    oracle_id: str,
    oracle_name: str,
    tag_id: str,
    tag_name: str,
    tag_status: str = "GOOD_STANDING",
) -> TaggerEdge:
    return TaggerEdge.model_validate(
        {
            "id": edge_id,
            "type": "TAGGING",
            "classifier": "ORACLE_CARD_TAG",
            "namespace": "card",
            "subjectId": oracle_id,
            "subjectName": oracle_name,
            "foreignKey": "oracleId",
            "relatedId": tag_id,
            "relatedName": None,
            "status": "GOOD_STANDING",
            "weight": "VERY_STRONG",
            "tag": {
                "id": tag_id,
                "name": tag_name,
                "slug": tag_name.replace(" ", "-"),
                "namespace": "card",
                "type": "ORACLE_CARD_TAG",
                "status": tag_status,
                "category": False,
                "description": f"Description for {tag_name}.",
            },
        }
    )


def relationship_edge(
    edge_id: str,
    *,
    subject_id: str,
    subject_name: str,
    related_id: str,
    related_name: str,
    classifier: str = "SIMILAR_TO",
    foreign_key: str = "oracleId",
) -> TaggerEdge:
    return TaggerEdge.model_validate(
        {
            "id": edge_id,
            "type": "RELATIONSHIP",
            "classifier": classifier,
            "classifierInverse": classifier,
            "namespace": "card" if foreign_key == "oracleId" else "artwork",
            "subjectId": subject_id,
            "subjectName": subject_name,
            "foreignKey": foreign_key,
            "relatedId": related_id,
            "relatedName": related_name,
            "name": related_name,
            "status": "GOOD_STANDING",
        }
    )


class FakeTaggerSource:
    def __init__(
        self,
        pages: dict[tuple[str, int], TaggerEdgePage | BaseException],
        *,
        bulk_tags: list[TaggerBulkOracleTag] | None = None,
    ) -> None:
        self.pages = pages
        self.bulk_tags = bulk_tags or []
        self.bulk_calls = 0
        self.calls: list[tuple[str, int, tuple[str, ...]]] = []
        self._lock = threading.Lock()

    def fetch_oracle_tags(self) -> list[TaggerBulkOracleTag]:
        self.bulk_calls += 1
        return self.bulk_tags

    def search_edges(
        self,
        *,
        edge_type: str,
        page: int,
        classifiers: list[str] | None = None,
    ) -> TaggerEdgePage:
        with self._lock:
            self.calls.append((edge_type, page, tuple(classifiers or [])))
        result = self.pages[(edge_type, page)]
        if isinstance(result, BaseException):
            raise result
        return result


def edge_page(page: int, total: int, results: list[TaggerEdge]) -> TaggerEdgePage:
    return TaggerEdgePage(page=page, perPage=2, total=total, results=results)


def syncer(target: Path, source: FakeTaggerSource) -> TaggerCatalogSync:
    return TaggerCatalogSync(
        target=target,
        source=source,
        concurrent_requests=2,
        refresh_after_hours=24,
        oracle_names={"city": "City of Brass"},
    )


def bulk_tags() -> list[TaggerBulkOracleTag]:
    return [
        TaggerBulkOracleTag(
            object="tag",
            id="tag-painland",
            label="painland",
            type="oracle",
            description="Lands that hurt their controller.",
            oracle_ids=["city"],
        ),
        TaggerBulkOracleTag(
            object="tag",
            id="tag-rainbow",
            label="rainbow-land",
            type="oracle",
            description="Lands that make any color.",
            oracle_ids=["city"],
        ),
        TaggerBulkOracleTag(
            object="tag",
            id="tag-third",
            label="activated-ability",
            type="oracle",
            description=None,
            oracle_ids=["other"],
        ),
    ]


def complete_pages() -> dict[tuple[str, int], TaggerEdgePage]:
    return {
        ("RELATIONSHIP", 1): edge_page(
            1,
            3,
            [
                relationship_edge(
                    "relationship-1",
                    subject_id="city",
                    subject_name="City of Brass",
                    related_id="mana",
                    related_name="Mana Confluence",
                ),
                relationship_edge(
                    "relationship-art",
                    subject_id="illustration-1",
                    subject_name="City of Brass",
                    related_id="illustration-2",
                    related_name="Another illustration",
                    foreign_key="illustrationId",
                ),
            ],
        ),
        ("RELATIONSHIP", 2): edge_page(
            2,
            3,
            [
                relationship_edge(
                    "relationship-2",
                    subject_id="joke",
                    subject_name="City of Ass",
                    related_id="city",
                    related_name="City of Brass",
                    classifier="REFERENCES_TO",
                )
            ],
        ),
    }


def test_sync_normalizes_oracle_tags_and_relationships_atomically(
    tmp_path: Path,
) -> None:
    target = tmp_path / "tagger.sqlite3"
    source = FakeTaggerSource(complete_pages(), bulk_tags=bulk_tags())

    result = syncer(target, source).sync()

    assert result.status == "imported"
    assert result.tags == 3
    assert result.oracle_card_taggings == 3
    assert result.oracle_card_relationships == 2
    assert target.is_file()
    assert not target.with_name(".tagger.sqlite3.partial").exists()
    with sqlite3.connect(target) as connection:
        tags = connection.execute(
            """
            SELECT tags.name, tags.status, oracle_card_tags.weight,
                   oracle_cards.name
            FROM oracle_card_tags
            JOIN tags USING (tag_id)
            JOIN oracle_cards USING (oracle_id)
            WHERE oracle_card_tags.oracle_id = 'city'
            ORDER BY tags.name
            """
        ).fetchall()
        relationships = connection.execute(
            """
            SELECT subject_name, classifier, related_name
            FROM oracle_card_relationships
            ORDER BY relationship_id
            """
        ).fetchall()
        raw = json.loads(
            connection.execute(
                """
                SELECT raw_json FROM oracle_card_relationships
                WHERE relationship_id = 'relationship-2'
                """
            ).fetchone()[0]
        )
        raw_tag = json.loads(
            connection.execute(
                "SELECT raw_json FROM tags WHERE tag_id = 'tag-painland'"
            ).fetchone()[0]
        )

    assert tags == [
        ("painland", None, None, "City of Brass"),
        ("rainbow land", None, None, "City of Brass"),
    ]
    assert relationships == [
        ("City of Brass", "SIMILAR_TO", "Mana Confluence"),
        ("City of Ass", "REFERENCES_TO", "City of Brass"),
    ]
    assert raw["classifier"] == "REFERENCES_TO"
    assert raw_tag["oracle_ids"] == ["city"]

    fresh_source = FakeTaggerSource({})
    current = syncer(target, fresh_source).sync()
    assert current.status == "current"
    assert fresh_source.calls == []


def test_reader_groups_tags_similar_cards_and_reference_directions(
    tmp_path: Path,
) -> None:
    city_id = "f25351e3-539b-4bbc-b92d-6480acf4d722"
    mana_id = "ad45e515-4f39-4188-9b2e-f8cfef7ac0d0"
    joke_id = "1025d55f-1e51-44ee-9b44-fc2b01b73f94"
    target = tmp_path / "tagger.sqlite3"
    source = FakeTaggerSource(
        {
            ("RELATIONSHIP", 1): edge_page(
                1,
                2,
                [
                    relationship_edge(
                        "relationship-similar",
                        subject_id=city_id,
                        subject_name="City of Brass",
                        related_id=mana_id,
                        related_name="Mana Confluence",
                    ),
                    relationship_edge(
                        "relationship-reference",
                        subject_id=joke_id,
                        subject_name="City of Ass",
                        related_id=city_id,
                        related_name="City of Brass",
                        classifier="REFERENCES_TO",
                    ),
                ],
            ),
        },
        bulk_tags=[
            TaggerBulkOracleTag(
                object="tag",
                id="tag-painland",
                label="painland",
                type="oracle",
                description="Lands that hurt their controller.",
                oracle_ids=[city_id],
            ),
            TaggerBulkOracleTag(
                object="tag",
                id="tag-rainbow",
                label="rainbow-land",
                type="oracle",
                description="Lands that make any color.",
                oracle_ids=[city_id],
            ),
        ],
    )
    TaggerCatalogSync(
        target=target,
        source=source,
        concurrent_requests=1,
        refresh_after_hours=24,
    ).sync()

    catalog = SQLiteTaggerCatalog(target)
    enrichment = catalog.card_enrichment(UUID(city_id))

    assert [tag.name for tag in enrichment.tags] == ["painland", "rainbow land"]
    assert [card.name for card in enrichment.similar_cards] == ["Mana Confluence"]
    assert enrichment.references == []
    assert [card.name for card in enrichment.referenced_by] == ["City of Ass"]
    assert catalog.search_tags("rainbo")[0].name == "rainbow land"
    assert [tag.model_dump() for tag in catalog.tag_filters(["tag-rainbow", "tag-painland"])] == [
        {"id": "tag-rainbow", "name": "rainbow land"},
        {"id": "tag-painland", "name": "painland"},
    ]
    assert catalog.oracle_ids_for_tags(["tag-rainbow", "tag-painland"]) == {
        UUID(city_id),
    }


def test_reader_reports_a_missing_sidecar() -> None:
    catalog = SQLiteTaggerCatalog(Path("missing-tagger-sidecar.sqlite3"))

    with pytest.raises(TaggerCatalogUnavailable):
        catalog.card_enrichment(UUID("f25351e3-539b-4bbc-b92d-6480acf4d722"))


def test_semantic_snapshot_bounds_deduplicates_and_normalizes_gameplay_tags(
    tmp_path: Path,
) -> None:
    oracle_ids = [str(UUID(int=value)) for value in range(1, 10)]
    target = tmp_path / "tagger.sqlite3"
    source = FakeTaggerSource(
        {
            ("RELATIONSHIP", 1): edge_page(1, 0, []),
        },
        bulk_tags=[
            TaggerBulkOracleTag(
                object="tag",
                id="tag-activated",
                label="activated-ability",
                type="oracle",
                description="Cards with activated abilities.",
                oracle_ids=[oracle_ids[0], oracle_ids[1], oracle_ids[2]],
            ),
            TaggerBulkOracleTag(
                object="tag",
                id="tag-death",
                label="death-trigger",
                type="oracle",
                description="Abilities that trigger when a permanent dies.",
                oracle_ids=[oracle_ids[0], oracle_ids[3], oracle_ids[4]],
            ),
            TaggerBulkOracleTag(
                object="tag",
                id="tag-death-duplicate",
                label="deathtrigger",
                type="oracle",
                description=None,
                oracle_ids=[oracle_ids[0], oracle_ids[3], oracle_ids[4]],
            ),
            TaggerBulkOracleTag(
                object="tag",
                id="tag-counters",
                label="repeatable-pp-counters",
                type="oracle",
                description=None,
                oracle_ids=[oracle_ids[0], oracle_ids[5], oracle_ids[6]],
            ),
            TaggerBulkOracleTag(
                object="tag",
                id="tag-recycle",
                label="recycle",
                type="oracle",
                description=None,
                oracle_ids=[oracle_ids[0], oracle_ids[2], oracle_ids[5]],
            ),
            TaggerBulkOracleTag(
                object="tag",
                id="tag-meta",
                label="card-names",
                type="oracle",
                description=None,
                oracle_ids=[oracle_ids[0], oracle_ids[7], oracle_ids[8]],
            ),
            TaggerBulkOracleTag(
                object="tag",
                id="tag-too-broad",
                label="generic-effect",
                type="oracle",
                description=None,
                oracle_ids=oracle_ids[:5],
            ),
        ],
    )
    TaggerCatalogSync(
        target=target,
        source=source,
        concurrent_requests=1,
        refresh_after_hours=24,
    ).sync()

    snapshot = SQLiteTaggerCatalog(target).semantic_snapshot(
        SemanticTagDocumentSettings(maximum_per_card=4),
        total_cards=20,
    )

    assert snapshot.metadata["status"] == "available"
    assert snapshot.concepts_by_oracle_id[UUID(oracle_ids[0])] == (
        "activated ability",
        "death trigger",
        "recycle",
        "repeatable +1/+1 counters",
    )
    assert "deathtrigger" not in snapshot.concepts_by_oracle_id[UUID(oracle_ids[0])]
    assert "card names" not in snapshot.concepts_by_oracle_id[UUID(oracle_ids[0])]
    assert "generic effect" not in snapshot.concepts_by_oracle_id[UUID(oracle_ids[0])]


def test_interrupted_sync_keeps_checkpoint_and_resumes_missing_pages(
    tmp_path: Path,
) -> None:
    target = tmp_path / "tagger.sqlite3"
    pages = complete_pages()
    interrupted_pages: dict[tuple[str, int], TaggerEdgePage | BaseException] = {
        **pages,
        ("RELATIONSHIP", 2): RuntimeError("temporary failure"),
    }

    with pytest.raises(RuntimeError, match="temporary failure"):
        syncer(
            target,
            FakeTaggerSource(interrupted_pages, bulk_tags=bulk_tags()),
        ).sync()

    partial = target.with_name(".tagger.sqlite3.partial")
    assert partial.is_file()
    assert not target.exists()

    resumed_source = FakeTaggerSource(pages, bulk_tags=bulk_tags())
    result = syncer(target, resumed_source).sync()

    assert result.status == "imported"
    assert resumed_source.bulk_calls == 0
    assert ("RELATIONSHIP", 1, ()) in resumed_source.calls
    assert ("RELATIONSHIP", 2, ()) in resumed_source.calls
    assert not partial.exists()


class FakeHeaders(dict[str, str]):
    def __init__(
        self,
        values: dict[str, str],
        *,
        set_cookies: list[str] | None = None,
    ) -> None:
        super().__init__(values)
        self._set_cookies = set_cookies or []

    def get_all(self, name: str) -> list[str]:
        return list(self._set_cookies) if name.casefold() == "set-cookie" else []


class FakeResponse(io.BytesIO):
    def __init__(
        self,
        body: bytes,
        *,
        headers: FakeHeaders | None = None,
    ) -> None:
        super().__init__(body)
        self.headers = headers if headers is not None else FakeHeaders({})

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def test_tagger_client_establishes_session_and_validates_edge_page() -> None:
    requests: list[Request] = []
    graphql_body = {
        "data": {
            "edges": {
                "page": 1,
                "perPage": 100,
                "total": 1,
                "results": [
                    tag_edge(
                        "tagging-1",
                        oracle_id="city",
                        oracle_name="City of Brass",
                        tag_id="tag-painland",
                        tag_name="painland",
                    ).model_dump(by_alias=True)
                ],
            }
        }
    }

    def open_url(request: Request, *, timeout: float) -> FakeResponse:
        requests.append(request)
        assert timeout == 5
        if len(requests) == 1:
            return FakeResponse(
                b'<html><meta name="csrf-token" content="csrf-value"></html>',
                headers=FakeHeaders(
                    {},
                    set_cookies=["_scryfall_tagger_session=session-value; path=/"],
                ),
            )
        return FakeResponse(json.dumps(graphql_body).encode())

    page = TaggerClient(
        base_url="https://tagger.scryfall.test",
        scryfall_api_base_url="https://api.scryfall.test",
        user_agent="tagger-test",
        timeout_seconds=5,
        request_interval_seconds=0,
        max_retries=0,
        open_url=open_url,
    ).search_edges(
        edge_type="TAGGING",
        page=1,
        classifiers=["ORACLE_CARD_TAG"],
    )

    assert page.total == 1
    assert page.results[0].tag is not None
    assert page.results[0].tag.name == "painland"
    assert requests[1].get_header("X-csrf-token") == "csrf-value"
    assert requests[1].get_header("Cookie") == ("_scryfall_tagger_session=session-value")
    request_body = json.loads(requests[1].data or b"{}")
    assert request_body["variables"]["input"] == {
        "type": "TAGGING",
        "page": 1,
        "classifier": ["ORACLE_CARD_TAG"],
    }


def test_tagger_client_reads_bulk_oracle_tag_memberships() -> None:
    requests: list[Request] = []
    body = {
        "object": "list",
        "has_more": False,
        "data": [
            {
                "object": "tag",
                "id": "tag-painland",
                "label": "painland",
                "type": "oracle",
                "description": "Lands that hurt their controller.",
                "oracle_ids": ["city", "other"],
            }
        ],
    }

    def open_url(request: Request, *, timeout: float) -> FakeResponse:
        requests.append(request)
        assert timeout == 5
        return FakeResponse(json.dumps(body).encode())

    tags = TaggerClient(
        base_url="https://tagger.scryfall.test",
        scryfall_api_base_url="https://api.scryfall.test",
        user_agent="tagger-test",
        timeout_seconds=5,
        request_interval_seconds=0,
        max_retries=0,
        open_url=open_url,
    ).fetch_oracle_tags()

    assert tags[0].label == "painland"
    assert tags[0].oracle_ids == ["city", "other"]
    assert requests[0].full_url == "https://api.scryfall.test/private/tags/oracle"
