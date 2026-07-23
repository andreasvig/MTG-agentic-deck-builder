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
  };
}

export const apiClient = createApiClient();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
