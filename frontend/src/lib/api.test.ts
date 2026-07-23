import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "./api";

describe("API client", () => {
  it("requests health from the configured API base URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          service: "mtg-agentic-deck-builder-api",
          version: "0.1.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = createApiClient("http://localhost:9999/api/v1/", fetcher);

    await expect(client.getHealth()).resolves.toEqual({
      status: "ok",
      service: "mtg-agentic-deck-builder-api",
      version: "0.1.0",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:9999/api/v1/health",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("raises an API error for an unhealthy response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await expect(client.getHealth()).rejects.toEqual(
      new ApiError("The backend health check failed.", 503),
    );
  });

  it("rejects a response that does not match the health contract", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await expect(client.getHealth()).rejects.toEqual(
      new ApiError("The backend health response was invalid.", 502),
    );
  });

  it("rejects a healthy response from an unrelated service", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          service: "unrelated-local-api",
          version: "1.0.0",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await expect(client.getHealth()).rejects.toEqual(
      new ApiError("The backend health response was invalid.", 502),
    );
  });
});
