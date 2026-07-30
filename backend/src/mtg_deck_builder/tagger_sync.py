"""CLI for refreshing the local Scryfall Tagger enrichment sidecar."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from mtg_deck_builder.card_catalog import SQLiteCardCatalog
from mtg_deck_builder.config import get_settings
from mtg_deck_builder.providers.tagger import TaggerClient
from mtg_deck_builder.semantic_index import SemanticCardIndex
from mtg_deck_builder.tagger_catalog import (
    SQLiteTaggerCatalog,
    TaggerCatalogSync,
    load_oracle_names,
)


def _print_progress(phase: str, completed: int, total: int) -> None:
    if completed == 1 or completed == total or completed % 25 == 0:
        print(
            f"{phase}: {completed:,}/{total:,} pages",
            file=sys.stderr,
            flush=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="discard any partial import and rebuild even when the sidecar is fresh",
    )
    args = parser.parse_args()
    settings = get_settings()
    tagger_settings = settings.tagger
    client = TaggerClient(
        base_url=tagger_settings.base_url,
        scryfall_api_base_url=settings.scryfall_base_url,
        user_agent=settings.scryfall_user_agent,
        timeout_seconds=tagger_settings.timeout_seconds,
        request_interval_seconds=tagger_settings.request_interval_seconds,
        max_retries=tagger_settings.max_retries,
    )
    result = TaggerCatalogSync(
        target=tagger_settings.database_path,
        source=client,
        concurrent_requests=tagger_settings.concurrent_requests,
        refresh_after_hours=tagger_settings.refresh_after_hours,
        oracle_names=load_oracle_names(settings.card_catalog_path),
        progress=_print_progress,
    ).sync(force=args.force)
    semantic_result = None
    if settings.card_catalog_path.is_file():
        semantic_settings = settings.search.semantic_sort
        semantic_result = asyncio.run(
            SemanticCardIndex(
                path=semantic_settings.index_path,
                catalog=SQLiteCardCatalog(settings.card_catalog_path),
                settings=semantic_settings,
                tagger_catalog=SQLiteTaggerCatalog(tagger_settings.database_path),
                progress=lambda completed, total: print(
                    f"Embedded {completed:,}/{total:,} cards",
                    file=sys.stderr,
                    flush=True,
                ),
            ).sync()
        )
    print(
        json.dumps(
            {
                "tagger": {
                    "status": result.status,
                    "tags": result.tags,
                    "oracle_card_taggings": result.oracle_card_taggings,
                    "oracle_card_relationships": result.oracle_card_relationships,
                    "completed_at": result.completed_at,
                    "path": str(result.path),
                },
                "semantic_sort": (
                    {
                        "status": semantic_result.status,
                        "cards": semantic_result.cards,
                        "dimensions": semantic_result.dimensions,
                        "model": semantic_result.model,
                        "path": str(semantic_result.path),
                    }
                    if semantic_result is not None
                    else {
                        "status": "skipped",
                        "reason": "card catalog is not installed",
                    }
                ),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
