"""CLI for refreshing the local Scryfall bulk card catalog."""

import argparse
import asyncio
import json
import sys

from mtg_deck_builder.card_catalog import ScryfallBulkCatalogSync, SQLiteCardCatalog
from mtg_deck_builder.config import get_settings
from mtg_deck_builder.semantic_index import SemanticCardIndex
from mtg_deck_builder.tagger_catalog import SQLiteTaggerCatalog


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="rebuild even when Scryfall's bulk timestamp is already installed",
    )
    args = parser.parse_args()
    settings = get_settings()
    catalog_result = ScryfallBulkCatalogSync(
        target=settings.card_catalog_path,
        api_base_url=settings.scryfall_base_url,
        user_agent=settings.scryfall_user_agent,
        timeout_seconds=settings.scryfall_bulk_timeout_seconds,
    ).sync(force=args.force)
    semantic_settings = settings.search.semantic_sort
    semantic_result = asyncio.run(
        SemanticCardIndex(
            path=semantic_settings.index_path,
            catalog=SQLiteCardCatalog(settings.card_catalog_path),
            settings=semantic_settings,
            tagger_catalog=SQLiteTaggerCatalog(settings.tagger.database_path),
            progress=lambda completed, total: print(
                f"Embedded {completed:,}/{total:,} cards",
                file=sys.stderr,
                flush=True,
            ),
        ).sync(force=args.force)
    )
    print(
        json.dumps(
            {
                "catalog": {
                    "status": catalog_result.status,
                    "source_updated_at": catalog_result.source_updated_at,
                    "cards": catalog_result.cards,
                    "printings": catalog_result.printings,
                    "skipped": catalog_result.skipped,
                    "path": str(catalog_result.path),
                },
                "semantic_sort": {
                    "status": semantic_result.status,
                    "cards": semantic_result.cards,
                    "dimensions": semantic_result.dimensions,
                    "model": semantic_result.model,
                    "path": str(semantic_result.path),
                },
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
