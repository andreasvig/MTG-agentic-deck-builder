import { describe, expect, it, vi } from "vitest";

import { cardSearchPage, searchDebugSummary } from "../test/fixtures";
import { ApiError, createApiClient } from "./api";

describe("API client", () => {
  it("requests and validates health from the configured API", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "ok",
        service: "mtg-agentic-deck-builder-api",
        version: "0.1.0",
      }),
    );
    const client = createApiClient("http://localhost:9999/api/v1/", fetcher);

    await expect(client.getHealth()).resolves.toMatchObject({
      status: "ok",
      service: "mtg-agentic-deck-builder-api",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:9999/api/v1/health",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("sends raw queries and structured card filters", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(cardSearchPage()));
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await client.searchCards(" Sol Ring ", 2, undefined, {
      colors: ["U", "R"],
      includeColorless: true,
      colorMode: "exact",
      manaValueMin: 2,
      manaValueMax: 5,
      priceEurMin: 0.25,
      priceEurMax: 12,
    }, true);

    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.pathname).toBe("/api/v1/cards/search");
    expect(requestedUrl.searchParams.get("q")).toBe("Sol Ring");
    expect(requestedUrl.searchParams.get("page")).toBe("2");
    expect(requestedUrl.searchParams.getAll("color")).toEqual(["U", "R"]);
    expect(requestedUrl.searchParams.get("include_colorless")).toBe("true");
    expect(requestedUrl.searchParams.get("color_mode")).toBe("exact");
    expect(requestedUrl.searchParams.get("mana_min")).toBe("2");
    expect(requestedUrl.searchParams.get("mana_max")).toBe("5");
    expect(requestedUrl.searchParams.get("price_min")).toBe("0.25");
    expect(requestedUrl.searchParams.get("price_max")).toBe("12");
    expect(requestedUrl.searchParams.get("debug")).toBe("true");
  });

  it("surfaces a safe provider message and rejects malformed payloads", async () => {
    const providerFailure = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { detail: { message: "Scryfall is temporarily unavailable." } },
          { status: 503 },
        ),
      );
    await expect(
      createApiClient("http://localhost/api/v1", providerFailure).searchCards(
        "Sol Ring",
      ),
    ).rejects.toEqual(
      new ApiError("Scryfall is temporarily unavailable.", 503),
    );

    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ cards: [{ name: "Sol Ring" }] }));
    await expect(
      createApiClient("http://localhost/api/v1", malformed).searchCards(
        "Sol Ring",
      ),
    ).rejects.toEqual(
      new ApiError("The card search response was invalid.", 502),
    );
  });

  it("accepts typed search debug summaries", async () => {
    const page = cardSearchPage();
    page.debug = searchDebugSummary();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page));

    await expect(
      createApiClient("http://localhost/api/v1", fetcher).searchCards("Forest"),
    ).resolves.toMatchObject({
      debug: {
        log_written: true,
        stages: expect.arrayContaining([
          expect.objectContaining({ name: "Scryfall intent candidates" }),
        ]),
        trace: {
          decision: { strategy: "intent" },
        },
      },
    });
  });

  it("rejects a healthy response from an unrelated service", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "ok",
        service: "unrelated-local-api",
        version: "1.0.0",
      }),
    );

    await expect(
      createApiClient("http://localhost/api/v1", fetcher).getHealth(),
    ).rejects.toEqual(
      new ApiError("The backend health response was invalid.", 502),
    );
  });
});
