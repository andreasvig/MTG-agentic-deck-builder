import asyncio
import os
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid5

import numpy as np
import pytest

from mtg_deck_builder.card_catalog import CatalogEntry, card_title_aliases
from mtg_deck_builder.config import SemanticSortSettings
from mtg_deck_builder.domain import CardPrices, CardSearchResult
from mtg_deck_builder.providers.cards import CardSearchUnavailable
from mtg_deck_builder.semantic_index import (
    SemanticCardIndex,
    render_semantic_document,
)

_NAMESPACE = UUID("f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f")


def make_card(
    name: str,
    *,
    oracle_text: str,
    type_line: str = "Creature — Test",
) -> CardSearchResult:
    return CardSearchResult(
        oracle_id=uuid5(_NAMESPACE, f"oracle:{name}"),
        scryfall_id=uuid5(_NAMESPACE, f"printing:{name}"),
        name=name,
        layout="normal",
        mana_cost="{2}{G}",
        mana_value=3,
        type_line=type_line,
        oracle_text=oracle_text,
        power="3",
        toughness="3",
        colors=["G"],
        color_identity=["G"],
        image_uris=None,
        card_faces=[],
        set_code="tst",
        set_name="Test",
        collector_number="1",
        rarity="rare",
        prices=CardPrices(eur=Decimal("0.25")),
        legalities={"commander": "legal"},
        finishes=["nonfoil"],
        scryfall_url="https://scryfall.com/card/tst/1/test",
    )


UNTAPPER = make_card("Helpful Untapper", oracle_text="{T}: Untap target creature.")
DRAWER = make_card("Thoughtful Drawer", oracle_text="Whenever this attacks, draw a card.")
DAMAGER = make_card("Angry Damager", oracle_text="This deals 3 damage to any target.")


class StubCatalog:
    def __init__(self, path: Path, cards: list[CardSearchResult]) -> None:
        self.path = path
        self.path.write_text("catalog", encoding="utf-8")
        self._entries = tuple(
            CatalogEntry(card=card, aliases=card_title_aliases(card)) for card in cards
        )

    def metadata(self) -> dict[str, str]:
        return {
            "schema_version": "2",
            "source_updated_at": "2026-07-28T00:00:00Z",
            "card_count": str(len(self._entries)),
        }

    async def entries(self) -> tuple[CatalogEntry, ...]:
        return self._entries


class FakeEmbeddingModel:
    model_name = "fake-semantic-model"

    def embed_passages(
        self,
        texts: object,
        *,
        batch_size: int,
    ) -> object:
        assert batch_size == 2
        for text in texts:  # type: ignore[union-attr]
            yield self._vector(str(text))

    def embed_query(self, text: str) -> np.ndarray:
        return self._vector(text)

    @staticmethod
    def _vector(text: str) -> np.ndarray:
        lowered = text.casefold()
        if "untap" in lowered:
            return np.array([1.0, 0.0], dtype=np.float32)
        if "draw" in lowered:
            return np.array([0.0, 1.0], dtype=np.float32)
        return np.array([-1.0, 0.0], dtype=np.float32)


def settings(tmp_path: Path) -> SemanticSortSettings:
    return SemanticSortSettings(
        model="fake-semantic-model",
        index_path=tmp_path / "semantic.sqlite3",
        cache_dir=tmp_path / "models",
        batch_size=2,
    )


def test_semantic_index_builds_atomically_and_cosine_sorts_without_a_cutoff(
    tmp_path: Path,
) -> None:
    catalog = StubCatalog(tmp_path / "cards.sqlite3", [UNTAPPER, DRAWER, DAMAGER])
    index = SemanticCardIndex(
        path=tmp_path / "semantic.sqlite3",
        catalog=catalog,  # type: ignore[arg-type]
        settings=settings(tmp_path),
        model=FakeEmbeddingModel(),
    )

    built = asyncio.run(index.sync())
    current = asyncio.run(index.sync())
    scores = asyncio.run(
        index.score(
            "creatures that untap things",
            [UNTAPPER.oracle_id, DRAWER.oracle_id, DAMAGER.oracle_id],
        )
    )

    assert built.status == "imported"
    assert built.cards == 3
    assert built.dimensions == 2
    assert current.status == "current"
    assert scores.scores[UNTAPPER.oracle_id] == pytest.approx(1.0)
    assert scores.scores[DRAWER.oracle_id] == pytest.approx(0.5)
    assert scores.scores[DAMAGER.oracle_id] == pytest.approx(0.0)


def test_semantic_index_rejects_a_stale_catalog(tmp_path: Path) -> None:
    catalog = StubCatalog(tmp_path / "cards.sqlite3", [UNTAPPER])
    index = SemanticCardIndex(
        path=tmp_path / "semantic.sqlite3",
        catalog=catalog,  # type: ignore[arg-type]
        settings=settings(tmp_path),
        model=FakeEmbeddingModel(),
    )
    asyncio.run(index.sync())
    stat = catalog.path.stat()
    os.utime(
        catalog.path,
        ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000),
    )

    with pytest.raises(CardSearchUnavailable, match="missing or stale"):
        asyncio.run(index.score("untap", [UNTAPPER.oracle_id]))


def test_semantic_document_contains_gameplay_fields_without_provider_urls() -> None:
    document = render_semantic_document(
        UNTAPPER,
        [
            "name",
            "mana_cost",
            "type_line",
            "oracle_text",
            "power_toughness",
            "card_faces",
        ],
    )

    assert "Name: Helpful Untapper" in document
    assert "Mana cost: {2}{G}" in document
    assert "Type: Creature — Test" in document
    assert "Rules: {T}: Untap target creature." in document
    assert "Power/toughness: 3/3" in document
    assert "scryfall.com" not in document
