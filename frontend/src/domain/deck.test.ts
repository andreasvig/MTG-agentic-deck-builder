import { describe, expect, it } from "vitest";

import {
  createEmptyDeck,
  parseStoredDeck,
  placementForCategory,
} from "./deck";

describe("deck domain", () => {
  it("falls back safely for missing, malformed, or incomplete stored decks", () => {
    const fallback = createEmptyDeck(new Date("2026-01-01T00:00:00Z"));

    expect(parseStoredDeck(null, fallback)).toBe(fallback);
    expect(parseStoredDeck("{broken", fallback)).toBe(fallback);
    expect(parseStoredDeck('{"name":"Incomplete"}', fallback)).toBe(fallback);
  });

  it("maps editor categories to the correct deck sections", () => {
    expect(placementForCategory("command_zone")).toEqual({
      section: "command_zone",
      categories: ["command_zone"],
    });
    expect(placementForCategory("creatures")).toEqual({
      section: "mainboard",
      categories: ["creatures"],
    });
    expect(placementForCategory("maybeboard")).toEqual({
      section: "maybeboard",
      categories: ["maybeboard"],
    });
  });
});
