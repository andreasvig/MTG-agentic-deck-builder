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

    settings = Settings()

    assert settings.host == "0.0.0.0"
    assert settings.port == 54_321
    assert settings.frontend_origin == "https://deck-builder.test"
