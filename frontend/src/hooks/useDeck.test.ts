import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { CardSearchResult } from "../domain/card";
import {
  COMMAND_ZONE_GROUP_ID,
  UNASSIGNED_GROUP_ID,
} from "../domain/deck";
import { counterspell, ghalta, solRing } from "../test/fixtures";
import { useDeck } from "./useDeck";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useDeck custom groups", () => {
  it("creates a group and moves a dropped card as one undoable change", () => {
    const { result } = renderHook(() => useDeck());

    act(() => result.current.addCard(solRing));
    act(() =>
      result.current.addCustomGroup("Ramp", solRing.scryfall_id),
    );

    const ramp = result.current.deck.custom_groups[0];
    const entry = result.current.deck.cards[0];
    expect(ramp?.name).toBe("Ramp");
    expect(entry?.categories).toEqual([ramp?.id]);
    expect(result.current.announcement).toBe(
      "Ramp group created and Sol Ring moved to it.",
    );

    act(() => result.current.undo());

    expect(result.current.deck.custom_groups).toEqual([]);
    expect(result.current.deck.cards[0]?.categories).toEqual([
      UNASSIGNED_GROUP_ID,
    ]);
  });

  it("deletes an active deck, selects a fallback, and can restore it", () => {
    const { result } = renderHook(() => useDeck());
    const originalId = result.current.deck.id;

    act(() => result.current.renameDeck("First deck"));
    act(() => result.current.createDeck());
    const deletedId = result.current.deck.id;

    act(() => result.current.deleteDeck(deletedId));

    expect(result.current.deck.id).toBe(originalId);
    expect(result.current.decks).toHaveLength(1);
    expect(result.current.deletedDeckName).toBe("Untitled Commander");

    act(() => result.current.restoreDeletedDeck());

    expect(result.current.deck.id).toBe(deletedId);
    expect(result.current.decks).toHaveLength(2);
    expect(result.current.deletedDeckName).toBeNull();
  });

  it("replaces a deleted final deck with an empty deck and removes that placeholder on restore", () => {
    const { result } = renderHook(() => useDeck());
    const originalId = result.current.deck.id;

    act(() => result.current.renameDeck("Only deck"));
    act(() => result.current.addCard(solRing));
    act(() => result.current.deleteDeck(originalId));

    expect(result.current.deck.id).not.toBe(originalId);
    expect(result.current.deck.cards).toEqual([]);
    expect(result.current.decks).toHaveLength(1);

    act(() => result.current.restoreDeletedDeck());

    expect(result.current.deck.id).toBe(originalId);
    expect(result.current.deck.cards[0]?.card.name).toBe("Sol Ring");
    expect(result.current.decks).toHaveLength(1);
  });

  it("rejects incompatible and third commanders but accepts a legal partner pair", () => {
    const partnerA = partnerCard("Partner One");
    const partnerB = partnerCard("Partner Two");
    const { result } = renderHook(() => useDeck());

    act(() =>
      result.current.addCard(ghalta, COMMAND_ZONE_GROUP_ID),
    );
    act(() =>
      result.current.addCard(counterspell, COMMAND_ZONE_GROUP_ID),
    );

    expect(result.current.deck.cards).toHaveLength(1);
    expect(result.current.announcementTone).toBe("error");
    expect(result.current.announcement).toContain(
      "cannot share the command zone",
    );

    act(() => result.current.removeCard(ghalta.scryfall_id));
    act(() =>
      result.current.addCard(partnerA, COMMAND_ZONE_GROUP_ID),
    );
    act(() =>
      result.current.addCard(partnerB, COMMAND_ZONE_GROUP_ID),
    );

    expect(
      result.current.deck.cards.filter(
        (entry) => entry.section === "command_zone",
      ),
    ).toHaveLength(2);
    expect(result.current.statistics.commandZoneProblem).toBeNull();

    act(() =>
      result.current.addCard(ghalta, COMMAND_ZONE_GROUP_ID),
    );
    expect(result.current.deck.cards).toHaveLength(2);
    expect(result.current.announcement).toContain(
      "already has two legal paired commanders",
    );

    act(() =>
      result.current.setQuantity(partnerA.scryfall_id, 2),
    );
    expect(result.current.deck.cards[0]?.quantity).toBe(1);
  });
});

function partnerCard(name: string): CardSearchResult {
  const id = name.toLocaleLowerCase().replaceAll(" ", "-");
  return {
    ...ghalta,
    oracle_id: `oracle-${id}`,
    scryfall_id: `printing-${id}`,
    name,
    oracle_text: "Partner",
  };
}
