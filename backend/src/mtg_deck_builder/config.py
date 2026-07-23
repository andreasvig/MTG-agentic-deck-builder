"""Application configuration."""

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    AliasChoices,
    AnyHttpUrl,
    Field,
    SecretStr,
    TypeAdapter,
    field_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict

from mtg_deck_builder import __version__

_http_url_adapter = TypeAdapter(AnyHttpUrl)


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables and an optional .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="MTG_",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: Annotated[int, Field(ge=1, le=65_535)] = 43_127
    frontend_origin: str = "http://127.0.0.1:41737"
    scryfall_base_url: str = "https://api.scryfall.com"
    scryfall_user_agent: str = (
        f"MTG-Agentic-Deck-Builder/{__version__} "
        "(+https://github.com/andreasvig/MTG-agentic-deck-builder)"
    )
    scryfall_timeout_seconds: Annotated[float, Field(gt=0, le=60)] = 10.0
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    openrouter_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "OPENROUTER_API_KEY",
            "MTG_OPENROUTER_API_KEY",
        ),
    )
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_model: str = "google/gemini-3.5-flash-lite"
    openrouter_provider: str | None = None
    openrouter_reasoning_effort: Literal[
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ] = "minimal"
    openrouter_max_tokens: Annotated[int, Field(ge=100, le=8_000)] = 900
    openrouter_timeout_seconds: Annotated[float, Field(gt=0, le=60)] = 15.0
    search_debug_enabled: bool = False
    search_debug_log_path: Path = Path("local-data/search-debug.jsonl")
    search_debug_result_limit: Annotated[int, Field(ge=1, le=100)] = 25
    fuzzy_name_candidate_limit: Annotated[int, Field(ge=2, le=30)] = 12
    fuzzy_name_min_score: Annotated[float, Field(ge=0, le=1)] = 0.45

    @field_validator(
        "host",
        "frontend_origin",
        "scryfall_base_url",
        "scryfall_user_agent",
        "embedding_model",
        "openrouter_base_url",
        "openrouter_model",
        "search_debug_log_path",
        mode="before",
    )
    @classmethod
    def strip_surrounding_whitespace(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("openrouter_provider", mode="before")
    @classmethod
    def empty_optional_string_is_none(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @field_validator("host")
    @classmethod
    def host_must_not_be_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("host must not be empty")
        return value

    @field_validator("frontend_origin")
    @classmethod
    def validate_frontend_origin(cls, value: str) -> str:
        origin = value.rstrip("/")
        url = _http_url_adapter.validate_python(origin)
        if (
            url.username is not None
            or url.password is not None
            or url.path not in {"", "/"}
            or url.query is not None
            or url.fragment is not None
        ):
            raise ValueError("frontend_origin must contain only scheme, host, and optional port")
        return origin

    @field_validator("scryfall_base_url")
    @classmethod
    def validate_scryfall_base_url(cls, value: str) -> str:
        base_url = value.rstrip("/")
        url = _http_url_adapter.validate_python(base_url)
        if (
            url.username is not None
            or url.password is not None
            or url.query is not None
            or url.fragment is not None
        ):
            raise ValueError("scryfall_base_url must not contain credentials, query, or fragment")
        return base_url

    @field_validator("openrouter_base_url")
    @classmethod
    def validate_openrouter_base_url(cls, value: str) -> str:
        base_url = value.rstrip("/")
        url = _http_url_adapter.validate_python(base_url)
        if (
            url.username is not None
            or url.password is not None
            or url.query is not None
            or url.fragment is not None
        ):
            raise ValueError("openrouter_base_url must not contain credentials, query, or fragment")
        return base_url

    @field_validator("scryfall_user_agent", "embedding_model", "openrouter_model")
    @classmethod
    def required_string_must_not_be_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("value must not be empty")
        return value


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide settings instance."""

    return Settings()
