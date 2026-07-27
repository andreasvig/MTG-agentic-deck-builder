"""Application configuration."""

from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
)
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

from mtg_deck_builder import __version__

_http_url_adapter = TypeAdapter(AnyHttpUrl)
_project_config_file = Path(__file__).resolve().parents[3] / "config.yaml"


class TitleMatchSettings(BaseModel):
    """User-facing controls for fuzzy card-title search."""

    model_config = ConfigDict(extra="forbid")

    page_size: Annotated[int, Field(ge=1, le=30)] = 12


class SearchSettings(BaseModel):
    """Search configuration loaded from the repository YAML file."""

    model_config = ConfigDict(extra="forbid")

    title_match: TitleMatchSettings = Field(default_factory=TitleMatchSettings)


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables and an optional .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="MTG_",
        env_nested_delimiter="__",
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
    scryfall_bulk_timeout_seconds: Annotated[float, Field(gt=0, le=3_600)] = 900.0
    card_catalog_path: Path = Path("local-data/cards.sqlite3")
    search: SearchSettings = Field(default_factory=SearchSettings)
    search_debug_enabled: bool = False
    search_debug_log_path: Path = Path("local-data/search-debug.jsonl")
    search_debug_result_limit: Annotated[int, Field(ge=1, le=100)] = 25

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            YamlConfigSettingsSource(settings_cls, yaml_file=_project_config_file),
            file_secret_settings,
        )

    @field_validator(
        "host",
        "frontend_origin",
        "scryfall_base_url",
        "scryfall_user_agent",
        "card_catalog_path",
        "search_debug_log_path",
        mode="before",
    )
    @classmethod
    def strip_surrounding_whitespace(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

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

    @field_validator("scryfall_user_agent")
    @classmethod
    def required_string_must_not_be_empty(cls, value: str) -> str:
        if not value:
            raise ValueError("value must not be empty")
        return value


@lru_cache
def get_settings() -> Settings:
    """Return the process-wide settings instance."""

    return Settings()
