import { describe, expect, it } from "vitest";

import type { CardSearchResult } from "./card";
import type { DeckCardEntry, DeckSection } from "./deck";
import {
  canShareCommandZone,
  COMMAND_ZONE_GROUP_ID,
  createDeckLibrary,
  createEmptyDeck,
  getColorIdentityWarnings,
  getCommandZoneProblem,
  getCommanderColorIdentity,
  groupIdForEntry,
  isWithinCommanderColorIdentity,
  parseStoredDeck,
  parseStoredDeckLibrary,
  placementForGroup,
  UNASSIGNED_GROUP_ID,
  validateCommandZoneAddition,
} from "./deck";
import { counterspell, ghalta, solRing } from "../test/fixtures";

describe("deck domain", () => {
  it("falls back safely for missing, malformed, or incomplete stored decks", () => {
    const fallback = createEmptyDeck(new Date("2026-01-01T00:00:00Z"));

    expect(parseStoredDeck(null, fallback)).toBe(fallback);
    expect(parseStoredDeck("{broken", fallback)).toBe(fallback);
    expect(parseStoredDeck('{"name":"Incomplete"}', fallback)).toBe(fallback);
  });

  it("migrates fixed categories and maybeboard cards to Not assigned", () => {
    const legacy = createEmptyDeck(new Date("2026-01-01T00:00:00Z"));
    const legacyValue = {
      ...legacy,
      custom_groups: undefined,
      cards: [
        { ...makeEntry(ghalta, "command_zone"), categories: ["command_zone"] },
        { ...makeEntry(solRing, "mainboard"), categories: ["other_spells"] },
        {
          ...makeEntry(counterspell, "mainboard"),
          section: "maybeboard",
          categories: ["maybeboard"],
        },
      ],
    };

    const migrated = parseStoredDeck(JSON.stringify(legacyValue));

    expect(migrated.custom_groups).toEqual([]);
    expect(migrated.cards[0]?.categories).toEqual([COMMAND_ZONE_GROUP_ID]);
    expect(migrated.cards[1]?.categories).toEqual([UNASSIGNED_GROUP_ID]);
    expect(migrated.cards[2]).toMatchObject({
      section: "mainboard",
      categories: [UNASSIGNED_GROUP_ID],
    });
  });

  it("maps command-zone and custom-group placements", () => {
    expect(placementForGroup(COMMAND_ZONE_GROUP_ID)).toEqual({
      section: "command_zone",
      categories: [COMMAND_ZONE_GROUP_ID],
    });
    expect(placementForGroup(UNASSIGNED_GROUP_ID)).toEqual({
      section: "mainboard",
      categories: [UNASSIGNED_GROUP_ID],
    });
    expect(placementForGroup("group-ramp")).toEqual({
      section: "mainboard",
      categories: ["group-ramp"],
    });
  });

  it("parses a persisted deck library and repairs a missing active id", () => {
    const first = createEmptyDeck(
      new Date("2026-01-01T00:00:00Z"),
      "First",
    );
    const second = createEmptyDeck(
      new Date("2026-01-02T00:00:00Z"),
      "Second",
    );
    second.id = "second";
    const fallback = createDeckLibrary(first);

    const parsed = parseStoredDeckLibrary(
      JSON.stringify({
        active_deck_id: "missing",
        decks: [first, second],
      }),
      fallback,
    );

    expect(parsed.active_deck_id).toBe(first.id);
    expect(parsed.decks.map((deck) => deck.name)).toEqual(["First", "Second"]);
  });

  it("resolves only persisted custom groups for mainboard cards", () => {
    const entry = makeEntry(solRing, "mainboard");
    entry.categories = ["group-ramp"];

    expect(
      groupIdForEntry(entry, [{ id: "group-ramp", name: "Ramp" }]),
    ).toBe("group-ramp");
    expect(groupIdForEntry(entry, [])).toBe(UNASSIGNED_GROUP_ID);
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

  it("allows a second command-zone card only for recognized legal pairings", () => {
    const genericPartnerA = commanderCard(
      "Akiri, Line-Slinger",
      "Partner (You can have two commanders if both have partner.)",
    );
    const genericPartnerB = commanderCard(
      "Silas Renn, Seeker Adept",
      "Deathtouch\nPartner",
    );
    const backgroundChooser = commanderCard(
      "Wilson, Refined Grizzly",
      "Choose a Background (You can have a Background as a second commander.)",
    );
    const background = commanderCard(
      "Raised by Giants",
      "Commander creatures you own have base power and toughness 10/10.",
      "Legendary Enchantment — Background",
    );
    const doctor = commanderCard(
      "The Tenth Doctor",
      "Allons-y!",
      "Legendary Creature — Time Lord Doctor",
    );
    const companion = commanderCard(
      "Rose Tyler",
      "Doctor's companion (You can have two commanders if the other is the Doctor.)",
    );
    const friendsA = commanderCard("Eleven, the Mage", "Friends forever");
    const friendsB = commanderCard("Mike, the Dungeon Master", "Friends forever");

    expect(canShareCommandZone(genericPartnerA, genericPartnerB)).toBe(true);
    expect(canShareCommandZone(backgroundChooser, background)).toBe(true);
    expect(canShareCommandZone(doctor, companion)).toBe(true);
    expect(canShareCommandZone(friendsA, friendsB)).toBe(true);
    expect(canShareCommandZone(ghalta, counterspell)).toBe(false);

    expect(
      validateCommandZoneAddition(
        [makeEntry(ghalta, "command_zone")],
        counterspell,
      ),
    ).toMatchObject({ allowed: false });
    expect(
      validateCommandZoneAddition(
        [makeEntry(genericPartnerA, "command_zone")],
        genericPartnerB,
      ),
    ).toEqual({ allowed: true, reason: null });
  });

  it("requires Partner with cards to name each other and flags legacy invalid zones", () => {
    const pir = commanderCard(
      "Pir, Imaginative Rascal",
      "Partner with Toothy, Imaginary Friend (When this creature enters, target player may put Toothy into their hand.)",
    );
    const toothy = commanderCard(
      "Toothy, Imaginary Friend",
      "Partner with Pir, Imaginative Rascal",
    );
    const impostor = commanderCard(
      "Wrong Friend",
      "Partner with Pir, Imaginative Rascal",
    );

    expect(canShareCommandZone(pir, toothy)).toBe(true);
    expect(canShareCommandZone(pir, impostor)).toBe(false);
    expect(
      getCommandZoneProblem([
        makeEntry(ghalta, "command_zone"),
        makeEntry(counterspell, "command_zone"),
      ]),
    ).toBe(
      "Ghalta, Primal Hunger and Counterspell are not a legal commander pair.",
    );

    const duplicateQuantity = makeEntry(ghalta, "command_zone");
    duplicateQuantity.quantity = 2;
    expect(getCommandZoneProblem([duplicateQuantity])).toBe(
      "Each commander must appear exactly once in the command zone.",
    );
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
      section === "command_zone"
        ? [COMMAND_ZONE_GROUP_ID]
        : [UNASSIGNED_GROUP_ID],
  };
}

function commanderCard(
  name: string,
  oracleText: string,
  typeLine = "Legendary Creature — Human",
): CardSearchResult {
  const id = name.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  return {
    ...ghalta,
    oracle_id: `oracle-${id}`,
    scryfall_id: `printing-${id}`,
    name,
    type_line: typeLine,
    oracle_text: oracleText,
  };
}
