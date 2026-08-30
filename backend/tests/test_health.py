import json
from typing import get_args

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from mtg_deck_builder.agentic_card_search import DEFAULT_AGENT_SORT
from mtg_deck_builder.config import Settings
from mtg_deck_builder.domain.agentic_search import (
    ColorSearch,
    LocalCardSearchRequest,
    ManaSearch,
    NumericRange,
    TypeSearch,
)
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
    monkeypatch.setenv("MTG_TAGGER__DATABASE_PATH", "tmp/tagger.sqlite3")
    monkeypatch.setenv("MTG_EDHREC__DATABASE_PATH", "tmp/edhrec.sqlite3")
    monkeypatch.setenv("MTG_EDHREC__REFRESH_AFTER_DAYS", "45")
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
    assert str(settings.tagger.database_path) == "tmp/tagger.sqlite3"
    assert str(settings.edhrec.database_path) == "tmp/edhrec.sqlite3"
    assert settings.edhrec.refresh_after_days == 45
    assert settings.scryfall_bulk_timeout_seconds == 1_200
    assert settings.search.title_match.page_size == 9
    assert settings.search.title_match.preview_min_confidence == 0.8
    assert settings.search.agentic.local_tool.default_max_results == 18


def test_settings_load_repository_search_yaml() -> None:
    settings = Settings()

    assert settings.search.title_match.page_size == 6
    assert settings.search.title_match.preview_min_confidence == 0.75
    assert settings.search.semantic_sort.model == "BAAI/bge-small-en-v1.5"
    assert str(settings.search.semantic_sort.index_path) == ("local-data/card-semantic.sqlite3")
    assert settings.search.semantic_sort.threads == 4
    assert settings.search.semantic_sort.document.version == 2
    assert settings.search.semantic_sort.document.include_name is False
    assert settings.search.semantic_sort.document.tags.enabled is True
    assert settings.search.semantic_sort.document.tags.maximum_per_card == 12
    assert settings.search.semantic_sort.document.relationships.include_in_document is False
    assert settings.tagger.base_url == "https://tagger.scryfall.com"
    assert str(settings.tagger.database_path) == "local-data/card-tagger.sqlite3"
    assert settings.tagger.concurrent_requests == 4
    assert settings.edhrec.enabled is True
    assert settings.edhrec.base_url == "https://json.edhrec.com"
    assert str(settings.edhrec.database_path) == "local-data/card-edhrec.sqlite3"
    assert settings.edhrec.refresh_after_days == 30
    assert settings.search.agentic.enabled is True
    assert settings.search.agentic.max_tool_calls == 1
    assert settings.search.agentic.local_tool.default_max_results == 24
    assert "{T}" in settings.search.agentic.system_prompt
    assert '["{X}", "{X}"]' in settings.search.agentic.system_prompt
    assert "`edhrec_synergy`" in settings.search.agentic.system_prompt
    assert "never resend an earlier tool request unchanged" in (
        settings.search.agentic.system_prompt
    )
    # The prompt uses the product's required Markdown skeleton.
    for heading in ("# Task", "# Inputs", "# Output", "# Tools", "# Guidelines"):
        assert heading in settings.search.agentic.system_prompt
    # `# Tools` explains every tool field, so no field reaches the model unexplained.
    tools_section = settings.search.agentic.system_prompt.split("# Tools", 1)[1].split(
        "\n# Guidelines",
        1,
    )[0]
    for field_name in LocalCardSearchRequest.model_fields:
        assert f"`{field_name}`" in tools_section, field_name
    for nested_model in (ManaSearch, TypeSearch, ColorSearch, NumericRange):
        for field_name in nested_model.model_fields:
            assert f"`{field_name}`" in tools_section, f"{nested_model.__name__}.{field_name}"
    # Every ordering the schema accepts must be explained, including the default.
    sort_values = [
        value
        for member in get_args(LocalCardSearchRequest.model_fields["sort_by"].annotation)
        for value in get_args(member)
    ]
    assert DEFAULT_AGENT_SORT in sort_values
    for value in sort_values:
        assert f"`{value}`" in tools_section, value
    # The stated result cap must be the configured one, never a stale number.
    assert str(settings.search.agentic.local_tool.hard_max_results) in tools_section
    # Product owners may tune weights; only the wiring is pinned here.
    weights = settings.search.agentic.ranking.weighted
    assert max(weights.semantic, weights.edhrec_inclusion) > 0
    # Every worked example must be a valid tool payload with a semantic_sort.
    prompt_lines = settings.search.agentic.system_prompt.splitlines()
    example_payloads = [
        json.loads(line.strip().strip("`"))
        for line in prompt_lines
        if line.strip().startswith("`{") and line.strip().endswith("}`")
    ]
    # How many examples to carry is editorial, so this is a floor, not a pin.
    assert len(example_payloads) >= 8
    assert all("semantic_sort" in payload for payload in example_payloads)
    # A worked example the tool would reject teaches the model a payload that cannot run.
    for payload in example_payloads:
        LocalCardSearchRequest.model_validate(payload)


def test_settings_accept_standard_openrouter_key_name(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-secret")

    settings = Settings()

    assert settings.openrouter_api_key is not None
    assert settings.openrouter_api_key.get_secret_value() == "test-secret"
