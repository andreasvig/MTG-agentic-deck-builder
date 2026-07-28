"""Application configuration."""

from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    AliasChoices,
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    TypeAdapter,
    field_validator,
    model_validator,
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
    preview_min_confidence: Annotated[float, Field(ge=0, le=1)] = 0.75


class SemanticSearchSettings(BaseModel):
    """Configuration reserved for semantic retrieval inside the local tool."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    model: str | None = None
    indexed_fields: list[Literal["name", "type_line", "oracle_text", "keywords", "card_faces"]] = (
        Field(
            default_factory=lambda: [
                "name",
                "type_line",
                "oracle_text",
                "keywords",
                "card_faces",
            ]
        )
    )

    @field_validator("model")
    @classmethod
    def model_must_not_be_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("semantic model must not be blank")
        return stripped

    @model_validator(mode="after")
    def enabled_search_requires_a_model(self) -> "SemanticSearchSettings":
        if self.enabled and self.model is None:
            raise ValueError("semantic model is required while semantic search is enabled")
        return self


class AgentDebugSettings(BaseModel):
    """Observable agent payloads captured only when search debug mode is active."""

    model_config = ConfigDict(extra="forbid")

    capture_raw_requests: bool = True
    capture_raw_responses: bool = True
    capture_provider_reasoning: bool = True
    capture_tool_arguments: bool = True
    capture_tool_results: bool = True
    capture_final_validation: bool = True


class AgentLocalToolSettings(BaseModel):
    """Candidate bounds for the local agent search tool."""

    model_config = ConfigDict(extra="forbid")

    default_max_results: Annotated[int, Field(ge=1, le=60)] = 24
    hard_max_results: Annotated[int, Field(ge=1, le=60)] = 60

    @model_validator(mode="after")
    def default_must_not_exceed_hard_maximum(self) -> "AgentLocalToolSettings":
        if self.default_max_results > self.hard_max_results:
            raise ValueError("default_max_results must not exceed hard_max_results")
        return self


class AgenticSearchSettings(BaseModel):
    """Configuration for the bounded one-tool agentic search phase."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    provider: Literal["openrouter"] = "openrouter"
    model: str = "google/gemini-3.5-flash-lite"
    max_tool_calls: Literal[1] = 1
    max_tool_results: Annotated[int, Field(ge=1, le=60)] = 60
    timeout_seconds: Annotated[float, Field(gt=0, le=120)] = 20
    debug: AgentDebugSettings = Field(default_factory=AgentDebugSettings)
    local_tool: AgentLocalToolSettings = Field(default_factory=AgentLocalToolSettings)
    system_prompt: str = "You are a Magic: The Gathering card-search agent."

    @field_validator("model", "system_prompt")
    @classmethod
    def required_text_must_not_be_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value must not be blank")
        return stripped

    @model_validator(mode="after")
    def tool_bounds_must_agree(self) -> "AgenticSearchSettings":
        if self.local_tool.hard_max_results > self.max_tool_results:
            raise ValueError("local_tool.hard_max_results must not exceed max_tool_results")
        return self


class SearchSettings(BaseModel):
    """Search configuration loaded from the repository YAML file."""

    model_config = ConfigDict(extra="forbid")

    title_match: TitleMatchSettings = Field(default_factory=TitleMatchSettings)
    semantic: SemanticSearchSettings = Field(default_factory=SemanticSearchSettings)
    agentic: AgenticSearchSettings = Field(default_factory=AgenticSearchSettings)


class Settings(BaseSettings):
    """Runtime settings loaded from environment variables and an optional .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="MTG_",
        env_nested_delimiter="__",
        populate_by_name=True,
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
    scryfall_request_interval_seconds: Annotated[float, Field(ge=0, le=10)] = 0.1
    card_catalog_path: Path = Path("local-data/cards.sqlite3")
    openrouter_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "MTG_OPENROUTER_API_KEY",
            "OPENROUTER_API_KEY",
        ),
    )
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
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
        "openrouter_base_url",
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
