# Backend

FastAPI service for the MTG Agentic Deck Builder.

## Development

From the repository root:

```bash
uv --directory backend sync
uv --directory backend run python -m mtg_deck_builder.main
```

The API defaults to `http://127.0.0.1:43127`. Its health endpoint is
`GET /api/v1/health`.

Configuration is read from the process environment or `backend/.env`:

| Variable | Default |
| --- | --- |
| `MTG_HOST` | `127.0.0.1` |
| `MTG_PORT` | `43127` |
| `MTG_FRONTEND_ORIGIN` | `http://127.0.0.1:41737` |

Run the checks with:

```bash
uv --directory backend run pytest
uv --directory backend run ruff check .
```
