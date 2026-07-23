# Backend

FastAPI service for the MTG Agentic Deck Builder.

## Development

From the repository root:

```bash
uv --directory backend sync
uv --directory backend run python -m mtg_deck_builder.main
```

The API defaults to `http://127.0.0.1:43127`. Its health endpoint is
`GET /api/v1/health`. Live card search is available at
`GET /api/v1/cards/search?q=sol+ring&page=1`.

Configuration is read from the process environment or `backend/.env`:

| Variable | Default |
| --- | --- |
| `MTG_HOST` | `127.0.0.1` |
| `MTG_PORT` | `43127` |
| `MTG_FRONTEND_ORIGIN` | `http://127.0.0.1:41737` |
| `MTG_SCRYFALL_BASE_URL` | `https://api.scryfall.com` |
| `MTG_SCRYFALL_USER_AGENT` | Project name, version, and repository URL |
| `MTG_SCRYFALL_TIMEOUT_SECONDS` | `10` |

Run the checks with:

```bash
uv --directory backend run pytest
uv --directory backend run ruff check .
```
