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

    page_size: Annotated[int, Field(ge=1, le=30)] = 6
    preview_min_confidence: Annotated[float, Field(ge=0, le=1)] = 0.75


SemanticDocumentField = Literal[
    "mana_cost",
    "mana_value",
    "type_line",
    "oracle_text",
    "power_toughness",
    "card_faces",
]


class SemanticTagDocumentSettings(BaseModel):
    """Controls for bounded Tagger concepts inside semantic documents."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    maximum_per_card: Annotated[int, Field(ge=1, le=50)] = 12
    minimum_card_count: Annotated[int, Field(ge=1)] = 3
    maximum_card_fraction: Annotated[float, Field(gt=0, le=1)] = 0.2
    collapse_equivalent_memberships: bool = True
    include_descriptions: bool = False
    description_max_characters: Annotated[int, Field(ge=40, le=500)] = 160
    prefer_specific_tags: bool = True
    aliases: dict[str, str] = Field(
        default_factory=lambda: {
            "pp counters": "+1/+1 counters",
            "etb": "enters the battlefield",
        }
    )
    excluded: list[str] = Field(
        default_factory=lambda: [
            "alliteration",
            "card name",
            "card names",
            "cycle",
            "errata",
            "erratum",
            "flavor",
            "flavors",
            "french vanilla",
            "has identical token",
            "naming scheme",
            "token versions of cards",
            "virtual legendary",
        ]
    )

    @field_validator("aliases")
    @classmethod
    def aliases_must_be_nonempty(cls, value: dict[str, str]) -> dict[str, str]:
        normalized: dict[str, str] = {}
        for source, replacement in value.items():
            clean_source = source.strip().casefold()
            clean_replacement = replacement.strip()
            if not clean_source or not clean_replacement:
                raise ValueError("semantic tag aliases must not be blank")
            normalized[clean_source] = clean_replacement
        return normalized

    @field_validator("excluded")
    @classmethod
    def excluded_tags_must_be_unique(cls, value: list[str]) -> list[str]:
        normalized = [tag.strip().casefold() for tag in value]
        if any(not tag for tag in normalized):
            raise ValueError("excluded semantic tags must not be blank")
        return list(dict.fromkeys(normalized))


class SemanticRelationshipDocumentSettings(BaseModel):
    """Keep exact Tagger relationships outside dense gameplay documents."""

    model_config = ConfigDict(extra="forbid")

    include_in_document: Literal[False] = False


class SemanticDocumentSettings(BaseModel):
    """Deterministic gameplay-document template for card embeddings."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[2] = 2
    fields: list[SemanticDocumentField] = Field(
        default_factory=lambda: [
            "mana_cost",
            "mana_value",
            "type_line",
            "oracle_text",
            "power_toughness",
            "card_faces",
        ],
        min_length=1,
    )
    include_name: bool = False
    normalize_self_references: bool = True
    explain_symbols: bool = True
    tags: SemanticTagDocumentSettings = Field(default_factory=SemanticTagDocumentSettings)
    relationships: SemanticRelationshipDocumentSettings = Field(
        default_factory=SemanticRelationshipDocumentSettings
    )

    @field_validator("fields")
    @classmethod
    def fields_must_be_unique(
        cls,
        value: list[SemanticDocumentField],
    ) -> list[SemanticDocumentField]:
        return list(dict.fromkeys(value))


class SemanticSortSettings(BaseModel):
    """Always-available local embedding sort inside the agent tool."""

    model_config = ConfigDict(extra="forbid")

    model: str = "BAAI/bge-small-en-v1.5"
    index_path: Path = Path("local-data/card-semantic.sqlite3")
    cache_dir: Path = Path("local-data/embedding-models")
    batch_size: Annotated[int, Field(ge=1, le=2_048)] = 256
    threads: Annotated[int, Field(ge=1, le=64)] = 4
    document: SemanticDocumentSettings = Field(default_factory=SemanticDocumentSettings)

    @field_validator("model")
    @classmethod
    def model_must_not_be_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("semantic model must not be blank")
        return stripped

    @field_validator("index_path", "cache_dir", mode="before")
    @classmethod
    def paths_must_not_be_blank(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise ValueError("semantic paths must not be blank")
            return stripped
        return value


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


class WeightedSortWeights(BaseModel):
    """Relative weights blended by the agent's default `weighted` ordering."""

    model_config = ConfigDict(extra="forbid")

    semantic: Annotated[float, Field(ge=0, le=1)] = 0.5
    edhrec_inclusion: Annotated[float, Field(ge=0, le=1)] = 0.5

    @model_validator(mode="after")
    def at_least_one_signal_must_carry_weight(self) -> "WeightedSortWeights":
        if self.semantic <= 0 and self.edhrec_inclusion <= 0:
            raise ValueError("weighted sort requires at least one positive weight")
        return self


class AgentRankingSettings(BaseModel):
    """Ordering weights applied after the local tool has filtered the catalog."""

    model_config = ConfigDict(extra="forbid")

    weighted: WeightedSortWeights = Field(default_factory=WeightedSortWeights)


class AgentContinuationSettings(BaseModel):
    """User-triggered search-expansion behavior."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    exclude_already_shown: bool = True
    exclude_previously_considered: bool = True
    include_full_card_details_in_prompt: bool = True
    max_rounds: Annotated[int | None, Field(default=None, ge=1, le=100)] = None


class AgenticSearchSettings(BaseModel):
    """Configuration for the bounded one-tool agentic search phase."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    provider: Literal["openrouter"] = "openrouter"
    model: str = "google/gemini-3.5-flash-lite"
    reasoning_effort: Literal["minimal", "low", "medium", "high"] = "minimal"
    temperature: Annotated[float, Field(ge=0, le=2)] | None = 0
    max_tool_calls: Literal[1] = 1
    max_tool_results: Annotated[int, Field(ge=1, le=60)] = 60
    timeout_seconds: Annotated[float, Field(gt=0, le=120)] = 20
    debug: AgentDebugSettings = Field(default_factory=AgentDebugSettings)
    local_tool: AgentLocalToolSettings = Field(default_factory=AgentLocalToolSettings)
    ranking: AgentRankingSettings = Field(default_factory=AgentRankingSettings)
    continuation: AgentContinuationSettings = Field(default_factory=AgentContinuationSettings)
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
    semantic_sort: SemanticSortSettings = Field(default_factory=SemanticSortSettings)
    agentic: AgenticSearchSettings = Field(default_factory=AgenticSearchSettings)


class TaggerSettings(BaseModel):
    """Offline synchronization settings for optional Tagger enrichment data."""

    model_config = ConfigDict(extra="forbid")

    base_url: str = "https://tagger.scryfall.com"
    database_path: Path = Path("local-data/card-tagger.sqlite3")
    timeout_seconds: Annotated[float, Field(gt=0, le=300)] = 30
    request_interval_seconds: Annotated[float, Field(ge=0.1, le=10)] = 0.12
    concurrent_requests: Annotated[int, Field(ge=1, le=8)] = 4
    max_retries: Annotated[int, Field(ge=0, le=10)] = 5
    refresh_after_hours: Annotated[float, Field(gt=0, le=720)] = 24

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        base_url = value.strip().rstrip("/")
        url = _http_url_adapter.validate_python(base_url)
        if (
            url.username is not None
            or url.password is not None
            or url.query is not None
            or url.fragment is not None
        ):
            raise ValueError("tagger base_url must not contain credentials, query, or fragment")
        return base_url

    @field_validator("database_path", mode="before")
    @classmethod
    def database_path_must_not_be_blank(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise ValueError("tagger database_path must not be blank")
            return stripped
        return value


class EdhrecSettings(BaseModel):
    """On-demand commander recommendation cache settings."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    base_url: str = "https://json.edhrec.com"
    database_path: Path = Path("local-data/card-edhrec.sqlite3")
    timeout_seconds: Annotated[float, Field(gt=0, le=300)] = 20
    refresh_after_days: Annotated[int, Field(ge=1, le=365)] = 30
    user_agent: str = (
        f"MTG-Agentic-Deck-Builder/{__version__} "
        "(personal local testing; +https://github.com/andreasvig/MTG-agentic-deck-builder)"
    )

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        base_url = value.strip().rstrip("/")
        url = _http_url_adapter.validate_python(base_url)
        if (
            url.username is not None
            or url.password is not None
            or url.query is not None
            or url.fragment is not None
        ):
            raise ValueError("edhrec base_url must not contain credentials, query, or fragment")
        return base_url

    @field_validator("database_path", mode="before")
    @classmethod
    def database_path_must_not_be_blank(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                raise ValueError("edhrec database_path must not be blank")
            return stripped
        return value

    @field_validator("user_agent")
    @classmethod
    def user_agent_must_not_be_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("edhrec user_agent must not be blank")
        return stripped


class PrintingSelectionSettings(BaseModel):
    """Rules deciding which printing of a card the local catalog stores and prices."""

    model_config = ConfigDict(extra="forbid")

    exclude_promotional: bool = True
    exclude_full_art: bool = True
    exclude_textless: bool = True
    exclude_foil_only: bool = True
    special_set_types: tuple[str, ...] = (
        "promo",
        "funny",
        "masterpiece",
        "from_the_vault",
        "premium_deck",
        "arsenal",
        "spellbook",
        "eternal",
    )
    special_set_codes: tuple[str, ...] = ("sld", "slc", "slu")
    special_border_colors: tuple[str, ...] = ("borderless", "silver", "yellow")
    special_promo_types: tuple[str, ...] = (
        "boosterfun",
        "boxtopper",
        "concept",
        "embossed",
        "playtest",
        "poster",
        "scroll",
        "serialized",
        "sldbonus",
        "thick",
    )
    special_frame_effects: tuple[str, ...] = (
        "etched",
        "extendedart",
        "fullart",
        "shatteredglass",
        "showcase",
    )
    special_security_stamps: tuple[str, ...] = ("acorn",)


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
    printing_selection: PrintingSelectionSettings = Field(
        default_factory=PrintingSelectionSettings
    )
    openrouter_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "MTG_OPENROUTER_API_KEY",
            "OPENROUTER_API_KEY",
        ),
    )
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    search: SearchSettings = Field(default_factory=SearchSettings)
    tagger: TaggerSettings = Field(default_factory=TaggerSettings)
    edhrec: EdhrecSettings = Field(default_factory=EdhrecSettings)
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
