"""CLI for refreshing the local Scryfall bulk card catalog."""

import argparse
import json

from mtg_deck_builder.card_catalog import ScryfallBulkCatalogSync
from mtg_deck_builder.config import get_settings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="rebuild even when Scryfall's bulk timestamp is already installed",
    )
    args = parser.parse_args()
    settings = get_settings()
    result = ScryfallBulkCatalogSync(
        target=settings.card_catalog_path,
        api_base_url=settings.scryfall_base_url,
        user_agent=settings.scryfall_user_agent,
        timeout_seconds=settings.scryfall_bulk_timeout_seconds,
    ).sync(force=args.force)
    print(
        json.dumps(
            {
                "status": result.status,
                "source_updated_at": result.source_updated_at,
                "cards": result.cards,
                "printings": result.printings,
                "skipped": result.skipped,
                "path": str(result.path),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
