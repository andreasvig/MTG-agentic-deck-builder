import type {
  CardSearchFilters,
  CardSearchPage,
} from "../domain/card";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:43127/api/v1";

export interface HealthResponse {
  status: "ok";
  service: "mtg-agentic-deck-builder-api";
  version: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  getHealth(signal?: AbortSignal): Promise<HealthResponse>;
  searchCards(
    query: string,
    page?: number,
    signal?: AbortSignal,
    filters?: CardSearchFilters,
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
    async searchCards(query, page = 1, signal, filters) {
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
      setNumberParam(url, "mana_min", filters?.manaValueMin);
      setNumberParam(url, "mana_max", filters?.manaValueMax);
      setNumberParam(url, "price_min", filters?.priceEurMin);
      setNumberParam(url, "price_max", filters?.priceEurMax);
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        let message = "Card search is temporarily unavailable.";
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
          // Keep the stable fallback for non-JSON upstream failures.
        }
        throw new ApiError(message, response.status);
      }

      const body: unknown = await response.json();
      if (!isCardSearchPage(body)) {
        throw new ApiError("The card search response was invalid.", 502);
      }
      return body;
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
    value.cards.every(
      (card) =>
        isRecord(card) &&
        typeof card.oracle_id === "string" &&
        typeof card.scryfall_id === "string" &&
        typeof card.name === "string" &&
        typeof card.type_line === "string" &&
        typeof card.mana_value === "number" &&
        isRecord(card.prices),
    ) &&
    Array.isArray(value.warnings) &&
    ["exact", "fuzzy", "intent", "syntax"].includes(String(value.strategy)) &&
    (value.interpretation === null ||
      typeof value.interpretation === "string") &&
    typeof value.reranked === "boolean"
  );
}
