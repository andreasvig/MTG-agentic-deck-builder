import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import type { CardSearchResult } from "../domain/card";
import { getCardPrice } from "../domain/card";
import type { Deck, DeckCardEntry } from "../domain/deck";
import { createEmptyDeck, DECK_LIBRARY_STORAGE_KEY } from "../domain/deck";
import type { DeckEditEntry, DeckHistory } from "../domain/history";
import {
  createDeckHistory,
  DECK_HISTORY_STORAGE_KEY,
  parseDeckHistory,
} from "../domain/history";
import { counterspell, gamble, ghalta, solRing } from "../test/fixtures";
import type { DeckEdit, DeckEditOutcome, DeckEditPlanner } from "./useDeck";
import { useDeck } from "./useDeck";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useDeck placement", () => {
  it("moves a card into the command zone and back out as two undoable changes", () => {
    const { result } = renderHook(() => useDeck());

    act(() => result.current.addCard(ghalta));
    act(() =>
      result.current.moveCard(ghalta.scryfall_id, "command_zone"),
    );

    expect(result.current.deck.cards[0]?.section).toBe("command_zone");
    expect(result.current.announcement).toBe(
      "Ghalta, Primal Hunger moved to the command zone.",
    );

    act(() => result.current.moveCard(ghalta.scryfall_id, "mainboard"));

    expect(result.current.deck.cards[0]?.section).toBe("mainboard");
    expect(result.current.announcement).toBe(
      "Ghalta, Primal Hunger moved to the deck.",
    );

    act(() => result.current.undo());

    expect(result.current.deck.cards[0]?.section).toBe("command_zone");
  });

  it("declines a move to the section the card is already in", () => {
    const { result } = renderHook(() => useDeck());

    act(() => result.current.addCard(solRing));
    const before = result.current.deck.updated_at;
    act(() => result.current.moveCard(solRing.scryfall_id, "mainboard"));

    // Not an edit, so no history entry and nothing to undo back past the add.
    expect(result.current.deck.updated_at).toBe(before);
    expect(result.current.announcement).toBe("Sol Ring added to the deck.");
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
      result.current.addCard(ghalta, "command_zone"),
    );
    act(() =>
      result.current.addCard(counterspell, "command_zone"),
    );

    expect(result.current.deck.cards).toHaveLength(1);
    expect(result.current.announcementTone).toBe("error");
    expect(result.current.announcement).toContain(
      "cannot share the command zone",
    );

    act(() => result.current.removeCard(ghalta.scryfall_id));
    act(() =>
      result.current.addCard(partnerA, "command_zone"),
    );
    act(() =>
      result.current.addCard(partnerB, "command_zone"),
    );

    expect(
      result.current.deck.cards.filter(
        (entry) => entry.section === "command_zone",
      ),
    ).toHaveLength(2);
    expect(result.current.statistics.commandZoneProblem).toBeNull();

    act(() =>
      result.current.addCard(ghalta, "command_zone"),
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

describe("useDeck history", () => {
  it("records each mutator's change and replays it backwards on undo", () => {
    const { result } = renderHook(() => useDeck());
    // Every mutator gets a step, because the derivation is central: one that recorded
    // nothing would stop being undoable and only its own step would notice.
    const steps: { label: string; run: () => void }[] = [
      { label: "addCard", run: () => result.current.addCard(solRing) },
      // Into the command zone and back out again before the quantity changes, because a
      // commander may only have one copy: both mutators get a step and neither is refused.
      {
        label: "moveCard to the command zone",
        run: () =>
          result.current.moveCard(solRing.scryfall_id, "command_zone"),
      },
      {
        label: "moveCard back to the deck",
        run: () => result.current.moveCard(solRing.scryfall_id, "mainboard"),
      },
      {
        label: "setQuantity",
        run: () => result.current.setQuantity(solRing.scryfall_id, 3),
      },
      { label: "renameDeck", run: () => result.current.renameDeck("Gruul Stompy") },
      {
        label: "removeCard",
        run: () => result.current.removeCard(solRing.scryfall_id),
      },
    ];

    const shapes: string[] = [];
    for (const step of steps) {
      shapes.push(shapeOf(result.current.deck));
      act(step.run);
      expect(
        shapeOf(result.current.deck),
        `${step.label} must change the deck`,
      ).not.toBe(shapes[shapes.length - 1]);
      expect(result.current.canUndo, `${step.label} must be undoable`).toBe(true);
    }

    for (const step of [...steps].reverse()) {
      act(() => result.current.undo());
      expect(
        shapeOf(result.current.deck),
        `undoing ${step.label} must restore the deck it found`,
      ).toBe(shapes.pop());
    }
    // Undo pops the log rather than recording its inverse, so six edits undo exactly six
    // times and the seventh attempt finds an empty log.
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.announcement).toBe("Nothing to undo.");
    expect(shapeOf(result.current.deck)).toBe(
      shapeOf(createEmptyDeck(new Date(), "Untitled Commander")),
    );
  });

  it("undoes a change made before a remount, from history in localStorage", () => {
    const first = renderHook(() => useDeck());
    act(() => first.result.current.addCard(solRing));
    act(() => first.result.current.setQuantity(solRing.scryfall_id, 4));
    const deckId = first.result.current.deck.id;
    first.unmount();

    const second = renderHook(() => useDeck());

    expect(second.result.current.deck.id).toBe(deckId);
    expect(second.result.current.deck.cards[0]?.quantity).toBe(4);
    expect(second.result.current.canUndo).toBe(true);

    act(() => second.result.current.undo());

    expect(second.result.current.deck.cards[0]?.quantity).toBe(1);

    // This second undo reverses the *add*, which is a removal — so it reads no payload. What
    // it proves is that the list of changes survived storage. The pool surviving is a separate
    // claim, and it needs a removal to undo rather than an add; the test below is the one that
    // makes it.
    act(() => second.result.current.undo());

    expect(second.result.current.deck.cards).toEqual([]);
    expect(second.result.current.canUndo).toBe(false);
  });

  it("rebuilds a removed card from the pooled payload after a remount", () => {
    const first = renderHook(() => useDeck());
    act(() => first.result.current.addCard(solRing));
    act(() => first.result.current.addCard(counterspell));
    // Removing it is what puts the payload in the pool: `deriveDeckDiff` pools a card only as
    // it enters or leaves the deck, so undoing an add can never exercise the pool.
    act(() => first.result.current.removeCard(solRing.scryfall_id));
    const deckId = first.result.current.deck.id;
    first.unmount();

    const second = renderHook(() => useDeck());

    expect(second.result.current.deck.id).toBe(deckId);
    expect(cardNames(second.result.current.deck)).toEqual(["Counterspell"]);
    expect(second.result.current.canUndo).toBe(true);

    act(() => second.result.current.undo());

    // The whole `CardSearchResult` came back through JSON, not merely the card's name — an
    // entry restored without its details prices at nothing and disappears from both
    // validators, so deep equality against the fixture is the property that matters.
    const restored = second.result.current.deck.cards.find(
      (entry) => entry.card.scryfall_id === solRing.scryfall_id,
    );

    expect(restored?.card.details).toEqual(solRing);
    // And at the index it was cut from, ahead of the card that outlived it.
    expect(cardNames(second.result.current.deck)).toEqual([
      "Sol Ring",
      "Counterspell",
    ]);
    // Priced, which is the visible consequence of the details surviving.
    expect(second.result.current.statistics.price).toBeGreaterThan(0);
  });

  it("writes history under its own key and leaves the deck library alone", () => {
    const { result } = renderHook(() => useDeck());

    act(() => result.current.addCard(solRing));

    expect(DECK_HISTORY_STORAGE_KEY).toBe("manabase.deck-history.v1");
    const log = storedLog(result.current.deck.id);
    expect(log.sessions).toHaveLength(1);
    expect(log.sessions[0]?.actor).toBe("user");
    expect(recordedEdits(log)).toHaveLength(1);
    expect(log.cards[solRing.scryfall_id]?.name).toBe("Sol Ring");

    const library = window.localStorage.getItem(DECK_LIBRARY_STORAGE_KEY);
    expect(library).toContain('"name":"Sol Ring"');
    expect(library).not.toContain("sessions");
  });

  it("collects a payload the undo it belongs to has popped", () => {
    const { result } = renderHook(() => useDeck());

    act(() => result.current.addCard(solRing));
    act(() => result.current.removeCard(solRing.scryfall_id));

    // Removing pooled Sol Ring's details, because undoing that removal would have to rebuild
    // the card from them.
    const deckId = result.current.deck.id;
    expect(Object.keys(storedLog(deckId).cards)).toEqual([solRing.scryfall_id]);

    act(() => result.current.undo());
    act(() => result.current.undo());

    // Undo pops the entry rather than recording an inverse, so once both entries are gone
    // nothing can ever read that payload again and keeping it is pure quota. Nothing asserted
    // this before, so a mutant that skipped the collection leaked for the deck's whole life
    // with the suite still green.
    expect(recordedEdits(storedLog(deckId))).toEqual([]);
    expect(storedLog(deckId).cards).toEqual({});
  });

  it("does not offer an undo whose pooled card details are gone", () => {
    const first = renderHook(() => useDeck());
    act(() => first.result.current.addCard(solRing));
    act(() => first.result.current.removeCard(solRing.scryfall_id));
    const deckId = first.result.current.deck.id;
    first.unmount();

    // What a prune leaves behind: the entries stay readable and the payload pool is gone.
    const log = storedLog(deckId);
    expect(recordedEdits(log)).toHaveLength(2);
    window.localStorage.setItem(
      DECK_HISTORY_STORAGE_KEY,
      JSON.stringify({ [deckId]: { ...log, cards: {} } }),
    );

    const second = renderHook(() => useDeck());

    // Read depth and undo depth are separate: the removal is still named in the log, and it
    // can no longer be replayed, so the button must not offer it.
    expect(recordedEdits(storedLog(deckId))[1]?.cards[0]?.name).toBe("Sol Ring");
    expect(second.result.current.canUndo).toBe(false);

    act(() => second.result.current.undo());

    expect(second.result.current.announcementTone).toBe("error");
    expect(second.result.current.announcement).toContain("Sol Ring");
    expect(second.result.current.deck.cards).toEqual([]);
  });

  it("keeps the deck usable when a stored card has no cached details", () => {
    window.localStorage.setItem(
      DECK_LIBRARY_STORAGE_KEY,
      JSON.stringify(
        storedLibraryHolding({
          card: {
            oracle_id: solRing.oracle_id,
            scryfall_id: solRing.scryfall_id,
            name: solRing.name,
          },
          quantity: 2,
          section: "mainboard",
        }),
      ),
    );

    // Stored entries are not required to carry `details`, and pricing one that does not used
    // to throw inside the statistics memo and take the whole board with it.
    const { result } = renderHook(() => useDeck());

    expect(result.current.deck.cards[0]?.card.details).toBeUndefined();
    expect(result.current.statistics.cardCount).toBe(2);
    expect(result.current.statistics.price).toBe(0);
    expect(result.current.statistics.averageMana).toBe(0);

    // Zero is the only figure this deck could produce, so on its own the assertion above
    // cannot tell "the guard skipped the detail-less entry" from "pricing is broken and
    // returns zero for everything". Adding a *different* priced card separates them: the
    // total must be that card's alone, which pins the intended behaviour — a detail-less
    // entry is skipped, so the total under-reports rather than crashing or zeroing.
    //
    // It has to be a different card. Adding `solRing` here merges into the stored entry by
    // printing and keeps its detail-less `CardReference` rather than backfilling the details,
    // so the total would stay at zero and this assertion would prove nothing.
    act(() => result.current.addCard(counterspell));

    expect(result.current.statistics.cardCount).toBe(3);
    expect(result.current.statistics.price).toBe(getCardPrice(counterspell));
    expect(result.current.statistics.price).toBeGreaterThan(0);
  });

  it("archives a deleted deck's history and restores it with the deck", () => {
    const { result } = renderHook(() => useDeck());
    const deckId = result.current.deck.id;

    act(() => result.current.addCard(solRing));
    act(() => result.current.createDeck());
    act(() => result.current.selectDeck(deckId));
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.deleteDeck(deckId));

    expect(result.current.deck.id).not.toBe(deckId);
    expect(result.current.canUndo).toBe(false);
    expect(storedLog(deckId).sessions).toEqual([]);

    act(() => result.current.restoreDeletedDeck());

    expect(result.current.deck.id).toBe(deckId);
    expect(recordedEdits(storedLog(deckId))).toHaveLength(1);
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());

    expect(result.current.deck.cards).toEqual([]);
  });
});

describe("useDeck applied edits", () => {
  it("applies a multi-card edit as one history entry and one undo step", () => {
    const { result } = renderHook(() => useDeck());
    act(() => result.current.addCard(counterspell));

    act(() =>
      result.current.applyEdit(
        () => ({
          changes: [
            { card: solRing, quantity: 1 },
            { card: gamble, quantity: 2, section: "mainboard" },
            { card: counterspell, quantity: 0 },
          ],
          reason: "swapping the weakest card for two rocks",
        }),
        "agent",
      ),
    );

    expect(cardNames(result.current.deck)).toEqual(["Sol Ring", "Gamble"]);
    expect(result.current.statistics.cardCount).toBe(3);
    expect(result.current.announcement).toBe(
      "Edit applied: 3 added, 1 removed, 3 cards now.",
    );

    const log = storedLog(result.current.deck.id);
    const recorded = recordedEdits(log);
    expect(recorded).toHaveLength(2);
    expect(recorded[1]?.cards).toHaveLength(3);
    expect(recorded[1]?.reason).toBe("swapping the weakest card for two rocks");
    // The actor sits on the session, so an agent edit cannot join the user's.
    expect(log.sessions.map((session) => session.actor)).toEqual([
      "user",
      "agent",
    ]);

    act(() => result.current.undo());

    expect(cardNames(result.current.deck)).toEqual(["Counterspell"]);
    expect(result.current.deck.cards[0]?.quantity).toBe(1);
  });

  it("refuses an edit the validators reject, applying nothing and recording nothing", () => {
    const { result } = renderHook(() => useDeck());
    act(() => result.current.addCard(ghalta, "command_zone"));
    const before = shapeOf(result.current.deck);
    const recordedBefore = recordedEdits(
      storedLog(result.current.deck.id),
    ).length;

    act(() =>
      result.current.applyEdit(
        () => ({
          changes: [
            { card: solRing, quantity: 1 },
            { card: counterspell, quantity: 1, section: "command_zone" },
          ],
          reason: "a second commander that cannot pair",
        }),
        "agent",
      ),
    );

    expect(result.current.announcementTone).toBe("error");
    expect(result.current.announcement).toContain("cannot share the command zone");
    // Sol Ring was legal and came first. It must still not be in the deck: a half-applied
    // edit would leave history recording an intent that did not happen.
    expect(cardNames(result.current.deck)).not.toContain("Sol Ring");
    expect(shapeOf(result.current.deck)).toBe(before);
    expect(recordedEdits(storedLog(result.current.deck.id))).toHaveLength(
      recordedBefore,
    );
  });

  it("reports a refusal to the caller with the reason it announced", () => {
    const { result } = renderHook(() => useDeck());
    act(() => result.current.addCard(ghalta, "command_zone"));
    const before = shapeOf(result.current.deck);
    const recordedBefore = recordedEdits(
      storedLog(result.current.deck.id),
    ).length;

    let refused: DeckEditOutcome | undefined;
    act(() => {
      refused = result.current.applyEdit(
        () => ({
          changes: [
            { card: solRing, quantity: 1 },
            { card: counterspell, quantity: 1, section: "command_zone" },
          ],
          reason: "a second commander that cannot pair",
        }),
        "agent",
      );
    });

    // Dispatching told the caller nothing, so whoever asked recorded the edit as made.
    // The verdict comes back instead, and it is the *same* sentence the announcement
    // carries — a second wording would be a second thing to keep in step.
    expect(refused).toEqual({
      applied: false,
      reason: result.current.announcement,
    });
    expect(refused).toEqual({
      applied: false,
      reason: expect.stringContaining("cannot share the command zone"),
    });
    expect(result.current.announcementTone).toBe("error");
    // Reported and refused, not reported and applied: the deck and the log are exactly
    // as the refusal found them.
    expect(shapeOf(result.current.deck)).toBe(before);
    expect(recordedEdits(storedLog(result.current.deck.id))).toHaveLength(
      recordedBefore,
    );

    let accepted: DeckEditOutcome | undefined;
    act(() => {
      accepted = result.current.applyEdit(
        () => ({ changes: [{ card: solRing, quantity: 1 }] }),
        "agent",
      );
    });

    // And an edit the deck takes says so, or every applied block would read as refused. It
    // comes back with what the deck recorded, not merely with the fact that it did: the
    // entry's own id, and the diff the deck derived from itself before and after. That is
    // what anything describing the edit is written from, and it is the very entry the log
    // holds — one derivation, handed to the caller rather than repeated beside it.
    const recordedEntry = recordedEdits(storedLog(result.current.deck.id)).at(-1);
    expect(accepted).toEqual({
      applied: true,
      recorded: { editId: recordedEntry?.id, diff: expect.any(Object) },
    });
    expect(
      accepted?.applied === true ? accepted.recorded?.diff.cards : null,
    ).toEqual(recordedEntry?.cards);
    expect(cardNames(result.current.deck)).toContain("Sol Ring");
    expect(recordedEdits(storedLog(result.current.deck.id))).toHaveLength(
      recordedBefore + 1,
    );
  });

  it("rejects a malformed or unplaceable change, changing nothing", () => {
    const { result } = renderHook(() => useDeck());

    act(() =>
      result.current.applyEdit(
        () => ({ changes: [{ card: solRing, quantity: 100 }] }),
        "agent",
      ),
    );
    expect(result.current.announcementTone).toBe("error");
    expect(result.current.deck.cards).toEqual([]);

    act(() =>
      result.current.applyEdit(
        () => ({ changes: [{ card: solRing, quantity: Number.NaN }] }),
        "agent",
      ),
    );
    expect(result.current.announcement).toContain("whole number");
    expect(result.current.deck.cards).toEqual([]);

    // There is no "unknown placement" refusal left to test: a section is one of two
    // values, the typed API cannot express a third, and an event naming one is refused by
    // the reader in `domain/agent.ts` before the deck is ever asked.
    expect(result.current.deck.cards).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });

  it("applies the same edit twice as one recorded change", () => {
    const { result } = renderHook(() => useDeck());
    const edit: DeckEdit = {
      changes: [{ card: solRing, quantity: 1 }],
      reason: "one rock",
    };

    act(() => result.current.applyEdit(() => edit, "agent"));
    act(() => result.current.applyEdit(() => edit, "agent"));

    expect(result.current.deck.cards).toHaveLength(1);
    expect(result.current.deck.cards[0]?.quantity).toBe(1);
    expect(result.current.announcement).toBe(
      "The deck already matched that edit, so nothing changed.",
    );
    expect(recordedEdits(storedLog(result.current.deck.id))).toHaveLength(1);
  });

  it("judges a second edit in the same tick against what the first one left", () => {
    const { result } = renderHook(() => useDeck());
    const seen: Array<string[]> = [];
    const commanderEdit = (card: CardSearchResult): DeckEditPlanner => (open) => {
      seen.push(open.cards.map((entry) => entry.card.name));
      return {
        changes: [{ card, quantity: 1, section: "command_zone" }],
        reason: `${card.name} leads this deck`,
      };
    };

    let first: DeckEditOutcome | undefined;
    let second: DeckEditOutcome | undefined;
    // Both in one tick, with no render between them — which is how they arrive, since one
    // pass of the stream reader hands over every event the response carried.
    act(() => {
      first = result.current.applyEdit(commanderEdit(ghalta), "agent");
      second = result.current.applyEdit(commanderEdit(counterspell), "agent");
    });

    // The second edit was resolved and judged against the deck the first one produced. Both
    // halves matter: an edit resolved against the deck as it was at the start of the tick
    // reads a card the first edit removed, and a verdict reached there calls this refusal an
    // application — and then something durable says the deck did what it turned down.
    expect(seen).toEqual([[], ["Ghalta, Primal Hunger"]]);
    expect(first?.applied).toBe(true);
    expect(second).toEqual({
      applied: false,
      reason: expect.stringContaining("cannot share the command zone"),
    });
    expect(cardNames(result.current.deck)).toEqual(["Ghalta, Primal Hunger"]);

    // One recorded edit, and it is the one the accepted edit reported. So whatever describes
    // that edit is the only thing that may offer to undo it.
    const recorded = recordedEdits(storedLog(result.current.deck.id));
    expect(recorded).toHaveLength(1);
    expect(first?.applied === true ? first.recorded?.editId : null).toBe(
      recorded[0]?.id,
    );
    expect(result.current.lastRecordedEditId).toBe(recorded[0]?.id);
  });

  it("resolves an agent edit on top of a user change made in the same tick", () => {
    const { result } = renderHook(() => useDeck());
    act(() => result.current.addCard(gamble));

    let seenQuantity: number | undefined;
    act(() => {
      result.current.setQuantity(gamble.scryfall_id, 3);
      result.current.applyEdit((open) => {
        seenQuantity = open.cards.find(
          (entry) => entry.card.scryfall_id === gamble.scryfall_id,
        )?.quantity;
        return { changes: [{ card: solRing, quantity: 1 }], reason: "some ramp" };
      }, "agent");
    });

    // Every change to the deck goes through one store, so an agent edit resolved in the same
    // tick as a drag sees the drag. Not seeing it would apply the edit to a deck that no
    // longer exists and quietly undo what the user just did.
    expect(seenQuantity).toBe(3);
    expect(result.current.deck.cards[0]?.quantity).toBe(3);
    expect(cardNames(result.current.deck)).toEqual(["Gamble", "Sol Ring"]);
    expect(recordedEdits(storedLog(result.current.deck.id))).toHaveLength(3);
  });

  it("applies an edit once when the hook renders in StrictMode", () => {
    const { result } = renderHook(() => useDeck(), { wrapper: StrictMode });

    act(() =>
      result.current.applyEdit(
        () => ({ changes: [{ card: solRing, quantity: 2 }] }),
        "agent",
      ),
    );

    expect(result.current.deck.cards).toHaveLength(1);
    expect(result.current.deck.cards[0]?.quantity).toBe(2);
    expect(recordedEdits(storedLog(result.current.deck.id))).toHaveLength(1);

    act(() => result.current.undo());

    expect(result.current.deck.cards).toEqual([]);
  });
});

/**
 * Everything a diff models, as one comparable value: the fields `updated_at` is not one of,
 * because the reducer restamps it on an undo and comparing it would fail every restoration.
 */
function shapeOf(deck: Deck): string {
  return JSON.stringify({ name: deck.name, cards: deck.cards });
}

function cardNames(deck: Deck): string[] {
  return deck.cards.map((entry) => entry.card.name);
}

function recordedEdits(log: DeckHistory): DeckEditEntry[] {
  return log.sessions.flatMap((session) => session.edits);
}

/** One deck's log, read back out of storage the way a reload would read it. */
function storedLog(deckId: string): DeckHistory {
  const raw = window.localStorage.getItem(DECK_HISTORY_STORAGE_KEY);
  const envelope: unknown = raw === null ? null : JSON.parse(raw);
  const candidate =
    typeof envelope === "object" && envelope !== null
      ? (envelope as Record<string, unknown>)[deckId]
      : null;
  return parseDeckHistory(candidate, createDeckHistory(deckId));
}

/** A stored library built by the real factory, holding one entry a test wants to pin. */
function storedLibraryHolding(entry: DeckCardEntry): unknown {
  const deck = createEmptyDeck(new Date(), "Stored deck");
  return {
    active_deck_id: deck.id,
    decks: [{ ...deck, cards: [entry] }],
  };
}

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
