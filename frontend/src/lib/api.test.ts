import { describe, expect, it, vi } from "vitest";

import { cardSearchPage } from "../test/fixtures";
import { ApiError, createApiClient, toScryfallQuery } from "./api";

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

  it("turns plain names into exact Scryfall name searches", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(cardSearchPage()));
    const client = createApiClient("http://localhost:9999/api/v1", fetcher);

    await client.searchCards("Sol Ring", 2);

    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.pathname).toBe("/api/v1/cards/search");
    expect(requestedUrl.searchParams.get("q")).toBe('name:"Sol Ring"');
    expect(requestedUrl.searchParams.get("page")).toBe("2");
  });

  it("preserves explicit Scryfall syntax and escapes plain names", () => {
    expect(toScryfallQuery("type:land color:g")).toBe("type:land color:g");
    expect(toScryfallQuery("goblin OR elf")).toBe("goblin OR elf");
    expect(toScryfallQuery("Sword of War and Peace")).toBe(
      'name:"Sword of War and Peace"',
    );
    expect(toScryfallQuery('Sword "Prototype"')).toBe(
      'name:"Sword \\"Prototype\\""',
    );
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
