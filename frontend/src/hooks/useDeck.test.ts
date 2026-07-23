import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { UNASSIGNED_GROUP_ID } from "../domain/deck";
import { solRing } from "../test/fixtures";
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
});
