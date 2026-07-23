import { describe, expect, it } from "vitest";

import {
  createEmptyDeck,
  getColorIdentityWarnings,
  getCommanderColorIdentity,
  isWithinCommanderColorIdentity,
  parseStoredDeck,
  placementForCategory,
} from "./deck";
import type { DeckCardEntry, DeckSection } from "./deck";
import type { CardSearchResult } from "./card";
import { counterspell, ghalta, solRing } from "../test/fixtures";

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

  it("validates cards against the union of command-zone color identities", () => {
    const entries = [
      makeEntry(ghalta, "command_zone"),
      makeEntry(solRing, "mainboard"),
      makeEntry(counterspell, "mainboard"),
    ];

    const commanderIdentity = getCommanderColorIdentity(entries);
    expect([...(commanderIdentity ?? [])]).toEqual(["G"]);
    expect(isWithinCommanderColorIdentity(ghalta, commanderIdentity)).toBe(true);
    expect(isWithinCommanderColorIdentity(solRing, commanderIdentity)).toBe(
      true,
    );
    expect(
      isWithinCommanderColorIdentity(counterspell, commanderIdentity),
    ).toBe(false);
    expect([...getColorIdentityWarnings(entries)]).toEqual([
      counterspell.oracle_id,
    ]);

    const partnerEntries = [
      makeEntry(ghalta, "command_zone"),
      makeEntry(counterspell, "command_zone"),
      makeEntry(
        { ...solRing, color_identity: ["U", "G"] },
        "mainboard",
      ),
    ];
    expect([
      ...(getCommanderColorIdentity(partnerEntries) ?? []),
    ]).toEqual(["G", "U"]);
    expect(getColorIdentityWarnings(partnerEntries).size).toBe(0);
  });

  it("waits for a known commander identity before warning", () => {
    const entries = [makeEntry(counterspell, "mainboard")];

    expect(getCommanderColorIdentity(entries)).toBeNull();
    expect(getColorIdentityWarnings(entries).size).toBe(0);
  });
});

function makeEntry(
  card: CardSearchResult,
  section: DeckSection,
): DeckCardEntry {
  return {
    card: {
      oracle_id: card.oracle_id,
      scryfall_id: card.scryfall_id,
      name: card.name,
      details: card,
    },
    quantity: 1,
    section,
    categories:
      section === "command_zone" ? ["command_zone"] : ["other_spells"],
  };
}
