from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from mtg_deck_builder.config import Settings
from mtg_deck_builder.main import create_app


def test_health_returns_typed_service_status() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "mtg-agentic-deck-builder-api",
        "version": "0.1.0",
    }


def test_cors_allows_only_configured_frontend_origin() -> None:
    origin = "http://127.0.0.1:41737"
    with TestClient(create_app(Settings(frontend_origin=origin))) as client:
        allowed_response = client.options(
            "/api/v1/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )
        denied_response = client.options(
            "/api/v1/health",
            headers={
                "Origin": "http://127.0.0.1:9999",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert allowed_response.status_code == 200
    assert allowed_response.headers["access-control-allow-origin"] == origin
    assert "access-control-allow-origin" not in denied_response.headers


def test_settings_load_prefixed_environment_variables(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setenv("MTG_HOST", "0.0.0.0")
    monkeypatch.setenv("MTG_PORT", "54321")
    monkeypatch.setenv("MTG_FRONTEND_ORIGIN", "https://deck-builder.test/")
    monkeypatch.setenv("MTG_SEARCH_DEBUG_ENABLED", "true")
    monkeypatch.setenv("MTG_SEARCH_DEBUG_LOG_PATH", "tmp/search-debug.jsonl")
    monkeypatch.setenv("MTG_SEARCH_DEBUG_RESULT_LIMIT", "12")
    monkeypatch.setenv("MTG_CARD_CATALOG_PATH", "tmp/cards.sqlite3")
    monkeypatch.setenv("MTG_SCRYFALL_BULK_TIMEOUT_SECONDS", "1200")
    monkeypatch.setenv("MTG_SEARCH__TITLE_MATCH__PAGE_SIZE", "9")
    monkeypatch.setenv("MTG_SEARCH__TITLE_MATCH__PREVIEW_MIN_CONFIDENCE", "0.8")
    monkeypatch.setenv("MTG_SEARCH__AGENTIC__LOCAL_TOOL__DEFAULT_MAX_RESULTS", "18")

    settings = Settings()

    assert settings.host == "0.0.0.0"
    assert settings.port == 54_321
    assert settings.frontend_origin == "https://deck-builder.test"
    assert settings.search_debug_enabled is True
    assert str(settings.search_debug_log_path) == "tmp/search-debug.jsonl"
    assert settings.search_debug_result_limit == 12
    assert str(settings.card_catalog_path) == "tmp/cards.sqlite3"
    assert settings.scryfall_bulk_timeout_seconds == 1_200
    assert settings.search.title_match.page_size == 9
    assert settings.search.title_match.preview_min_confidence == 0.8
    assert settings.search.agentic.local_tool.default_max_results == 18


def test_settings_load_repository_search_yaml() -> None:
    settings = Settings()

    assert settings.search.title_match.page_size == 6
    assert settings.search.title_match.preview_min_confidence == 0.75
    assert settings.search.semantic.enabled is False
    assert settings.search.agentic.enabled is True
    assert settings.search.agentic.max_tool_calls == 1
    assert settings.search.agentic.local_tool.default_max_results == 24
    assert "{T}" in settings.search.agentic.system_prompt
    assert '["{X}", "{X}"]' in settings.search.agentic.system_prompt


def test_settings_accept_standard_openrouter_key_name(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-secret")

    settings = Settings()

    assert settings.openrouter_api_key is not None
    assert settings.openrouter_api_key.get_secret_value() == "test-secret"
