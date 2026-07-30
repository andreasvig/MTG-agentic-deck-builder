import type {
  CardEnrichment,
  EdhrecCommanderContext,
  CardSearchFilters,
  CardSearchPage,
  CardSearchResult,
  CardSubtypeMatch,
  CardTagMatch,
  SearchDebugSummary,
} from "../domain/card";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:43127/api/v1";

export interface HealthResponse {
  status: "ok";
  service: "mtg-agentic-deck-builder-api";
  version: string;
}

export interface CardSearchEnhancements {
  enhanceWithEdhrec: boolean;
  commanderOracleId: string;
  edhrecTheme?: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debug: SearchDebugSummary | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  getHealth(signal?: AbortSignal): Promise<HealthResponse>;
  getCardEnrichment?(
    oracleId: string,
    signal?: AbortSignal,
  ): Promise<CardEnrichment>;
  getCard?(
    oracleId: string,
    signal?: AbortSignal,
  ): Promise<CardSearchResult>;
  getCommanderEdhrecContext?(
    oracleId: string,
    signal?: AbortSignal,
  ): Promise<EdhrecCommanderContext>;
  searchCardTags?(
    query: string,
    signal?: AbortSignal,
  ): Promise<CardTagMatch[]>;
  searchCardSubtypes?(
    query: string,
    signal?: AbortSignal,
  ): Promise<CardSubtypeMatch[]>;
  searchCards(
    query: string,
    page?: number,
    signal?: AbortSignal,
    filters?: CardSearchFilters,
    debug?: boolean,
    enhancements?: CardSearchEnhancements,
  ): Promise<CardSearchPage>;
  searchCardsAgentic?(
    query: string,
    page?: number,
    signal?: AbortSignal,
    filters?: CardSearchFilters,
    debug?: boolean,
    searchSessionId?: string | null,
    alreadyShownOracleIds?: string[],
    enhancements?: CardSearchEnhancements,
  ): Promise<CardSearchPage>;
}

export function createApiClient(
  baseUrl = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL,
  fetcher: typeof fetch = (...args) => fetch(...args),
): ApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return {
    async getHealth(signal) {
      const response = await fetcher(`${normalizedBaseUrl}/health`, {
        headers: { Accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        throw new ApiError("The backend health check failed.", response.status);
      }

      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        body.status !== "ok" ||
        body.service !== "mtg-agentic-deck-builder-api" ||
        typeof body.version !== "string"
      ) {
        throw new ApiError("The backend health response was invalid.", 502);
      }

      return {
        status: body.status,
        service: body.service,
        version: body.version,
      };
    },
    async getCardEnrichment(oracleId, signal) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/${encodeURIComponent(oracleId)}/enrichment`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readCardEnrichmentResponse(response);
    },
    async getCard(oracleId, signal) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/${encodeURIComponent(oracleId)}`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readCardResponse(response);
    },
    async getCommanderEdhrecContext(oracleId, signal) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/${encodeURIComponent(oracleId)}/edhrec`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readEdhrecCommanderContextResponse(response);
    },
    async searchCardTags(query, signal) {
      const url = new URL(`${normalizedBaseUrl}/cards/tags/search`);
      url.searchParams.set("q", query.trim());
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal,
      });
      return readCardTagSearchResponse(response);
    },
    async searchCardSubtypes(query, signal) {
      const url = new URL(`${normalizedBaseUrl}/cards/subtypes/search`);
      url.searchParams.set("q", query.trim());
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal,
      });
      return readCardSubtypeSearchResponse(response);
    },
    async searchCards(
      query,
      page = 1,
      signal,
      filters,
      debug = false,
      enhancements,
    ) {
      const url = new URL(`${normalizedBaseUrl}/cards/search`);
      url.searchParams.set("q", query.trim());
      url.searchParams.set("page", String(page));
      filters?.colors.forEach((color) => url.searchParams.append("color", color));
      if (filters?.includeColorless) {
        url.searchParams.set("include_colorless", "true");
      }
      if (filters && (filters.colors.length > 0 || filters.includeColorless)) {
        url.searchParams.set("color_mode", filters.colorMode);
      }
      if (filters?.includeNonCommanderLegal) {
        url.searchParams.set("include_non_commander_legal", "true");
      }
      if (filters?.includeOutsideCommanderColorIdentity) {
        url.searchParams.set("include_outside_commander_identity", "true");
      }
      filters?.commanderColorIdentity?.forEach((color) =>
        url.searchParams.append("commander_color", color),
      );
      if (filters?.commanderColorIdentity !== null) {
        url.searchParams.set("commander_identity_known", "true");
      }
      filters?.tags.forEach((tag) => url.searchParams.append("tag", tag.id));
      filters?.cardTypes?.forEach((cardType) =>
        url.searchParams.append("card_type", cardType),
      );
      filters?.subtypes?.forEach((subtype) =>
        url.searchParams.append("subtype", subtype),
      );
      setNumberParam(url, "mana_min", filters?.manaValueMin);
      setNumberParam(url, "mana_max", filters?.manaValueMax);
      setNumberParam(url, "price_min", filters?.priceEurMin);
      setNumberParam(url, "price_max", filters?.priceEurMax);
      if (enhancements?.enhanceWithEdhrec) {
        url.searchParams.set("enhance_with_edhrec", "true");
        url.searchParams.set(
          "commander_oracle_id",
          enhancements.commanderOracleId,
        );
        if (enhancements.edhrecTheme) {
          url.searchParams.set("edhrec_theme", enhancements.edhrecTheme);
        }
      }
      if (debug) {
        url.searchParams.set("debug", "true");
      }
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal,
      });

      return readCardSearchResponse(response);
    },
    async searchCardsAgentic(
      query,
      page = 1,
      signal,
      filters = {
        colors: [],
        includeColorless: false,
        colorMode: "subset",
        includeNonCommanderLegal: false,
        includeOutsideCommanderColorIdentity: false,
        commanderColorIdentity: null,
        tags: [],
        cardTypes: [],
        subtypes: [],
        manaValueMin: null,
        manaValueMax: null,
        priceEurMin: null,
        priceEurMax: null,
      },
      debug = false,
      searchSessionId = null,
      alreadyShownOracleIds = [],
      enhancements,
    ) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/search/agentic`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            q: query.trim(),
            page,
            filters: {
              colors: filters.colors,
              include_colorless: filters.includeColorless,
              color_mode: filters.colorMode,
              include_non_commander_legal:
                filters.includeNonCommanderLegal,
              include_outside_commander_color_identity:
                filters.includeOutsideCommanderColorIdentity,
              commander_color_identity: filters.commanderColorIdentity,
              tags: filters.tags,
              card_types: filters.cardTypes ?? [],
              subtypes: filters.subtypes ?? [],
              mana_value_min: filters.manaValueMin,
              mana_value_max: filters.manaValueMax,
              price_eur_min: filters.priceEurMin,
              price_eur_max: filters.priceEurMax,
            },
            debug,
            search_session_id: searchSessionId,
            already_shown_oracle_ids: alreadyShownOracleIds,
            ...(enhancements
              ? {
                  commander_oracle_id: enhancements.commanderOracleId,
                  enhance_with_edhrec: enhancements.enhanceWithEdhrec,
                  edhrec_theme:
                    enhancements.enhanceWithEdhrec
                      ? (enhancements.edhrecTheme ?? null)
                      : null,
                }
              : {}),
          }),
          signal,
        },
      );
      return readCardSearchResponse(response);
    },
  };
}

export const apiClient = createApiClient();

function setNumberParam(
  url: URL,
  name: string,
  value: number | null | undefined,
) {
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    url.searchParams.set(name, String(value));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCardSearchPage(value: unknown): value is CardSearchPage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.query === "string" &&
    typeof value.page === "number" &&
    typeof value.total_results === "number" &&
    typeof value.has_more === "boolean" &&
    Array.isArray(value.cards) &&
    value.cards.every(isCardSearchResult) &&
    isRecord(value.name_match_scores) &&
    Object.values(value.name_match_scores).every(
      (score) =>
        typeof score === "number" &&
        Number.isFinite(score) &&
        score >= 0 &&
        score <= 1,
    ) &&
    isRecord(value.title_confidence_scores) &&
    Object.values(value.title_confidence_scores).every(
      (score) =>
        typeof score === "number" &&
        Number.isFinite(score) &&
        score >= 0 &&
        score <= 1,
    ) &&
    Array.isArray(value.warnings) &&
    ["fuzzy", "agentic"].includes(String(value.strategy)) &&
    (value.interpretation === null ||
      typeof value.interpretation === "string") &&
    typeof value.reranked === "boolean" &&
    typeof value.agentic_required === "boolean" &&
    (value.search_session_id === null ||
      typeof value.search_session_id === "string") &&
    isEdhrecSearchEnhancement(value.edhrec) &&
    (value.debug === null || isSearchDebugSummary(value.debug)) &&
    Array.isArray(value.debug_runs) &&
    value.debug_runs.every(isSearchDebugSummary)
  );
}

function isEdhrecSearchEnhancement(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["not_requested", "applied", "unavailable"].includes(
      String(value.status),
    ) &&
    (value.source === null ||
      value.source === "cache" ||
      value.source === "network") &&
    (value.message === null || typeof value.message === "string")
  );
}

function isCardSearchResult(value: unknown): value is CardSearchResult {
  return (
    isRecord(value) &&
    typeof value.oracle_id === "string" &&
    typeof value.scryfall_id === "string" &&
    typeof value.name === "string" &&
    typeof value.type_line === "string" &&
    typeof value.mana_value === "number" &&
    (value.power === null || typeof value.power === "string") &&
    (value.toughness === null || typeof value.toughness === "string") &&
    isRecord(value.prices)
  );
}

async function readCardSearchResponse(
  response: Response,
): Promise<CardSearchPage> {
  if (!response.ok) {
    let message = "Card search is temporarily unavailable.";
    let debug: SearchDebugSummary | null = null;
    try {
      const body: unknown = await response.json();
      if (
        isRecord(body) &&
        isRecord(body.detail) &&
        typeof body.detail.message === "string"
      ) {
        message = body.detail.message;
        if (isSearchDebugSummary(body.detail.debug)) {
          debug = body.detail.debug;
        }
      }
    } catch {
      // Keep the stable fallback for non-JSON upstream failures.
    }
    throw new ApiError(message, response.status, debug);
  }

  const body: unknown = await response.json();
  if (!isCardSearchPage(body)) {
    throw new ApiError("The card search response was invalid.", 502);
  }
  return body;
}

async function readCardEnrichmentResponse(
  response: Response,
): Promise<CardEnrichment> {
  if (!response.ok) {
    let message = "Card tags and relationships are temporarily unavailable.";
    try {
      const body: unknown = await response.json();
      if (
        isRecord(body) &&
        isRecord(body.detail) &&
        typeof body.detail.message === "string"
      ) {
        message = body.detail.message;
      }
    } catch {
      // Keep the stable fallback for non-JSON failures.
    }
    throw new ApiError(message, response.status);
  }

  const body: unknown = await response.json();
  if (!isCardEnrichment(body)) {
    throw new ApiError("The card enrichment response was invalid.", 502);
  }
  return body;
}

async function readCardResponse(response: Response): Promise<CardSearchResult> {
  if (!response.ok) {
    throw new ApiError(
      "That card is not available in the local catalog.",
      response.status,
    );
  }
  const body: unknown = await response.json();
  if (!isCardSearchResult(body)) {
    throw new ApiError("The card response was invalid.", 502);
  }
  return body;
}

async function readEdhrecCommanderContextResponse(
  response: Response,
): Promise<EdhrecCommanderContext> {
  if (!response.ok) {
    throw new ApiError(
      "EDHREC commander themes are temporarily unavailable.",
      response.status,
    );
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !["not_requested", "applied", "unavailable"].includes(
      String(body.status),
    ) ||
    (body.source !== null &&
      body.source !== "cache" &&
      body.source !== "network") ||
    typeof body.commander_oracle_id !== "string" ||
    (body.commander_name !== null &&
      typeof body.commander_name !== "string") ||
    !Array.isArray(body.themes) ||
    !body.themes.every(
      (theme) =>
        isRecord(theme) &&
        typeof theme.slug === "string" &&
        typeof theme.name === "string" &&
        typeof theme.deck_count === "number" &&
        theme.deck_count >= 0,
    ) ||
    (body.message !== null && typeof body.message !== "string")
  ) {
    throw new ApiError("The EDHREC commander-theme response was invalid.", 502);
  }
  return body as unknown as EdhrecCommanderContext;
}

async function readCardTagSearchResponse(
  response: Response,
): Promise<CardTagMatch[]> {
  if (!response.ok) {
    throw new ApiError("Card tags are temporarily unavailable.", response.status);
  }
  const body: unknown = await response.json();
  if (
    !Array.isArray(body) ||
    !body.every(
      (tag) =>
        isRecord(tag) &&
        typeof tag.id === "string" &&
        typeof tag.name === "string" &&
        typeof tag.slug === "string" &&
        (tag.description === null || typeof tag.description === "string") &&
        typeof tag.match_score === "number" &&
        tag.match_score >= 0 &&
        tag.match_score <= 1,
    )
  ) {
    throw new ApiError("The card tag response was invalid.", 502);
  }
  return body;
}

async function readCardSubtypeSearchResponse(
  response: Response,
): Promise<CardSubtypeMatch[]> {
  if (!response.ok) {
    throw new ApiError("Card subtypes are temporarily unavailable.", response.status);
  }
  const body: unknown = await response.json();
  if (
    !Array.isArray(body) ||
    !body.every(
      (subtype) =>
        isRecord(subtype) &&
        typeof subtype.name === "string" &&
        typeof subtype.match_score === "number" &&
        subtype.match_score >= 0 &&
        subtype.match_score <= 1,
    )
  ) {
    throw new ApiError("The card subtype response was invalid.", 502);
  }
  return body;
}

function isCardEnrichment(value: unknown): value is CardEnrichment {
  return (
    isRecord(value) &&
    typeof value.oracle_id === "string" &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (tag) =>
        isRecord(tag) &&
        typeof tag.id === "string" &&
        typeof tag.name === "string" &&
        typeof tag.slug === "string" &&
        (tag.description === null || typeof tag.description === "string"),
    ) &&
    isRelatedCardList(value.similar_cards) &&
    isRelatedCardList(value.references) &&
    isRelatedCardList(value.referenced_by)
  );
}

function isRelatedCardList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (card) =>
        isRecord(card) &&
        typeof card.oracle_id === "string" &&
        typeof card.name === "string",
    )
  );
}

function isSearchDebugSummary(value: unknown): value is SearchDebugSummary {
  return (
    isRecord(value) &&
    typeof value.trace_id === "string" &&
    typeof value.log_path === "string" &&
    typeof value.log_written === "boolean" &&
    typeof value.total_duration_ms === "number" &&
    Array.isArray(value.stages) &&
    value.stages.every(
      (stage) =>
        isRecord(stage) &&
        typeof stage.name === "string" &&
        ["ok", "skipped", "error"].includes(String(stage.status)) &&
        typeof stage.duration_ms === "number" &&
        (stage.input_count === null ||
          typeof stage.input_count === "number") &&
        (stage.output_count === null ||
          typeof stage.output_count === "number"),
    ) &&
    isSearchDebugTrace(value.trace)
  );
}

function isSearchDebugTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.schema_version === "number" &&
    typeof value.trace_id === "string" &&
    typeof value.started_at === "string" &&
    typeof value.completed_at === "string" &&
    typeof value.total_duration_ms === "number" &&
    isRecord(value.request) &&
    isRecord(value.configuration) &&
    isRecord(value.decision) &&
    Array.isArray(value.stages) &&
    value.stages.every(
      (stage) =>
        isRecord(stage) &&
        typeof stage.name === "string" &&
        ["ok", "skipped", "error"].includes(String(stage.status)) &&
        typeof stage.duration_ms === "number",
    ) &&
    isRecord(value.result)
  );
}
