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
    classifier_inverse: str | None = None,
    foreign_key: str = "oracleId",
) -> TaggerEdge:
    # Tagger publishes a genuine inverse for its asymmetric classifiers, so the
    # default is only correct for the symmetric ones such as `SIMILAR_TO`; pass
    # `classifier_inverse` explicitly for anything directional.
    return TaggerEdge.model_validate(
        {
            "id": edge_id,
            "type": "RELATIONSHIP",
            "classifier": classifier,
            "classifierInverse": classifier_inverse or classifier,
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


def test_reader_groups_strictness_variant_and_body_relationships(tmp_path: Path) -> None:
    """Every classifier Tagger publishes reaches a group, read from either side."""

    bolt_id = "4457ed35-7c10-48c8-9776-456485fdf070"
    strike_id = "9d5ec2c2-1b2a-4d1e-9f4b-3c2f8f6de001"
    entomb_id = "7a1f0f1a-7d6c-4a2e-9c3e-9de3a0dd4b02"
    entomber_id = "2b1c9d24-53f4-4c07-8fa2-1c6d59f10a03"
    shifted_id = "5e8c4a6b-2f10-4d38-8c19-7a2b6f4c9d04"
    kin_id = "8f3d2e17-9b45-4c62-a0d8-4e5f1c7b8a05"
    target = tmp_path / "tagger.sqlite3"
    source = FakeTaggerSource(
        {
            ("RELATIONSHIP", 1): edge_page(
                1,
                1,
                [
                    # Stated from the stronger card, which is the highlighted one.
                    relationship_edge(
                        "relationship-better",
                        subject_id=bolt_id,
                        subject_name="Lightning Bolt",
                        related_id=strike_id,
                        related_name="Lightning Strike",
                        classifier="BETTER_THAN",
                        classifier_inverse="WORSE_THAN",
                    ),
                    # Stated from the creature, which here is the *other* card, so
                    # this edge only groups correctly if it is read backwards.
                    relationship_edge(
                        "relationship-body",
                        subject_id=entomber_id,
                        subject_name="Vile Entomber",
                        related_id=entomb_id,
                        related_name="Entomb",
                        classifier="WITH_BODY",
                        classifier_inverse="WITHOUT_BODY",
                    ),
                    relationship_edge(
                        "relationship-colorshifted",
                        subject_id=shifted_id,
                        subject_name="Mind Rot",
                        related_id=bolt_id,
                        related_name="Lightning Bolt",
                        classifier="COLORSHIFTED",
                    ),
                    relationship_edge(
                        "relationship-related",
                        subject_id=bolt_id,
                        subject_name="Lightning Bolt",
                        related_id=kin_id,
                        related_name="Bolt Kin",
                        classifier="RELATED_TO",
                    ),
                ],
            ),
        },
    )
    TaggerCatalogSync(
        target=target,
        source=source,
        concurrent_requests=1,
        refresh_after_hours=24,
    ).sync()
    catalog = SQLiteTaggerCatalog(target)

    bolt = catalog.card_enrichment(UUID(bolt_id))
    entomb = catalog.card_enrichment(UUID(entomb_id))

    assert [card.name for card in bolt.downgrades] == ["Lightning Strike"]
    assert bolt.upgrades == []
    assert [card.name for card in bolt.variants] == ["Mind Rot"]
    assert [card.name for card in bolt.related_cards] == ["Bolt Kin"]
    # Read from the other end, the same strictness edge has to flip groups.
    assert [card.name for card in catalog.card_enrichment(UUID(strike_id)).upgrades] == [
        "Lightning Bolt"
    ]
    assert [card.name for card in entomb.creature_versions] == ["Vile Entomber"]
    assert entomb.spell_versions == []
    assert [card.name for card in catalog.card_enrichment(UUID(entomber_id)).spell_versions] == [
        "Entomb"
    ]


def test_reader_inverts_relationships_without_trusting_the_published_inverse(
    tmp_path: Path,
) -> None:
    """Inversion comes from the local table, not from whatever Tagger published.

    A missing inverse still has to work, and a wrong one must not be able to show a
    card's upgrades as its downgrades.
    """

    better_id = "b1de2c33-5a6f-4e71-9c08-2d4a7f5e6b06"
    worse_id = "c2ef3d44-6b70-4f82-8d19-3e5b8a6f7c07"
    target = tmp_path / "tagger.sqlite3"
    edge = relationship_edge(
        "relationship-better-bad-inverse",
        subject_id=better_id,
        subject_name="Counterspell",
        related_id=worse_id,
        related_name="Nullify",
        classifier="BETTER_THAN",
        # Both wrong: absent, and then self-inverse the way the feed must not be read.
        classifier_inverse="BETTER_THAN",
    )
    source = FakeTaggerSource(
        {
            ("RELATIONSHIP", 1): edge_page(
                1,
                1,
                [edge, edge.model_copy(update={"classifier_inverse": None})],
            ),
        },
    )
    TaggerCatalogSync(
        target=target,
        source=source,
        concurrent_requests=1,
        refresh_after_hours=24,
    ).sync()
    catalog = SQLiteTaggerCatalog(target)

    assert [card.name for card in catalog.card_enrichment(UUID(worse_id)).upgrades] == [
        "Counterspell"
    ]
    assert [card.name for card in catalog.card_enrichment(UUID(better_id)).downgrades] == [
        "Nullify"
    ]


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
