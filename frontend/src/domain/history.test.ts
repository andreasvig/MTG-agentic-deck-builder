import { describe, expect, it } from "vitest";

import type { CardSearchResult } from "./card";
import type { Deck, DeckCardEntry } from "./deck";
import {
  COMMAND_ZONE_GROUP_ID,
  placementForGroup,
  UNASSIGNED_GROUP_ID,
} from "./deck";
import type {
  DeckDiff,
  DeckDiffApplyFailure,
  DeckDiffApplyResult,
  DeckDiffDerivation,
  DeckEditEntry,
  DeckHistory,
  DeckHistoryActor,
} from "./history";
import {
  appendToHistory,
  applyDeckDiff,
  createDeckHistory,
  DECK_HISTORY_PAYLOAD_CAP,
  DECK_HISTORY_SESSION_CAP,
  DECK_HISTORY_STORAGE_KEY,
  deriveDeckDiff,
  invertDeckDiff,
  isEmptyDeckDiff,
  parseDeckHistory,
  pruneHistory,
} from "./history";
import { counterspell, gamble, ghalta, solRing } from "../test/fixtures";

const CREATED_AT = "2026-08-01T09:00:00.000Z";
const BEFORE_UPDATED_AT = "2026-08-01T09:00:00.000Z";
const AFTER_UPDATED_AT = "2026-08-01T09:05:00.000Z";
const SESSION_START = "2026-08-01T14:00:00.000Z";

/**
 * Every mutable field of `Deck` gets a row here, because the derivation is only complete
 * for the fields it is asked about: a field with no row would stop being undone and no
 * assertion would notice. Adding a twelfth axis is one line.
 */
const diffCases: { label: string; before: Deck; after: Deck }[] = [
  {
    label: "an added card",
    before: baseDeck(),
    after: edited((deck) => ({
      ...deck,
      cards: [...deck.cards, makeEntry(gamble, UNASSIGNED_GROUP_ID)],
    })),
  },
  {
    label: "a card added at the front of the list",
    before: baseDeck(),
    after: edited((deck) => ({
      ...deck,
      cards: [makeEntry(gamble, UNASSIGNED_GROUP_ID), ...deck.cards],
    })),
  },
  {
    label: "a card removed from the middle of the list",
    before: baseDeck(),
    after: edited((deck) => ({
      ...deck,
      cards: deck.cards.filter(
        (entry) => entry.card.scryfall_id !== solRing.scryfall_id,
      ),
    })),
  },
  {
    label: "a quantity change",
    before: baseDeck(),
    after: edited((deck) =>
      withEntry(deck, solRing.scryfall_id, { quantity: 3 }),
    ),
  },
  {
    label: "a section move",
    before: baseDeck(),
    after: edited((deck) =>
      withEntry(deck, ghalta.scryfall_id, {
        ...placementForGroup(UNASSIGNED_GROUP_ID),
      }),
    ),
  },
  {
    label: "a group move",
    before: baseDeck(),
    after: edited((deck) =>
      withEntry(deck, solRing.scryfall_id, {
        ...placementForGroup(UNASSIGNED_GROUP_ID),
      }),
    ),
  },
  {
    label: "a category change",
    before: baseDeck(),
    after: edited((deck) =>
      withEntry(deck, solRing.scryfall_id, {
        categories: ["group-ramp", "group-secondary"],
      }),
    ),
  },
  {
    label: "a created group holding a moved card",
    before: baseDeck(),
    after: edited((deck) =>
      withEntry(
        {
          ...deck,
          custom_groups: [...deck.custom_groups, { id: "group-draw", name: "Draw" }],
        },
        counterspell.scryfall_id,
        { ...placementForGroup("group-draw") },
      ),
    ),
  },
  {
    label: "a renamed group",
    before: baseDeck(),
    after: edited((deck) => ({
      ...deck,
      custom_groups: [{ id: "group-ramp", name: "Ramp package" }],
    })),
  },
  {
    label: "a group inserted ahead of the existing one",
    before: baseDeck(),
    after: edited((deck) => ({
      ...deck,
      custom_groups: [{ id: "group-draw", name: "Draw" }, ...deck.custom_groups],
    })),
  },
  {
    label: "a deck rename",
    before: baseDeck(),
    after: edited((deck) => ({ ...deck, name: "Naya Beats" })),
  },
  {
    label: "every axis at once",
    before: baseDeck(),
    after: edited((deck) =>
      withEntry(
        {
          ...deck,
          name: "Naya Beats",
          custom_groups: [
            { id: "group-draw", name: "Draw" },
            { id: "group-ramp", name: "Ramp package" },
          ],
          cards: [
            ...deck.cards.filter(
              (entry) => entry.card.scryfall_id !== solRing.scryfall_id,
            ),
            makeEntry(gamble, UNASSIGNED_GROUP_ID, 2),
          ],
        },
        counterspell.scryfall_id,
        { ...placementForGroup("group-draw"), quantity: 4 },
      ),
    ),
  },
];

describe("deck history derivation", () => {
  it.each(diffCases)(
    "restores the deck by inverting the diff for $label",
    ({ before, after }) => {
      const { diff, payloads } = deriveDeckDiff(before, after);

      const restored = applied(
        applyDeckDiff(after, invertDeckDiff(stamp(diff)), payloads),
      );

      // `updated_at` is the one mutable field the diff excludes on purpose: the reducer
      // stamps it on every mutation, so recording it would make each inversion fight the
      // reducer over a field neither means to restore.
      expect(restored).toEqual({ ...before, updated_at: after.updated_at });
    },
  );

  it.each(diffCases)(
    "reproduces the deck by applying the diff for $label forward",
    ({ before, after }) => {
      const { diff, payloads } = deriveDeckDiff(before, after);

      const reapplied = applied(applyDeckDiff(before, stamp(diff), payloads));

      expect(reapplied).toEqual({ ...after, updated_at: before.updated_at });
    },
  );

  it("derives one change for one edit to a hundred-card deck", () => {
    const cards = Array.from({ length: 100 }, (_, index) =>
      makeEntry(printing(index), UNASSIGNED_GROUP_ID),
    );
    const before = { ...baseDeck(), cards };
    const after = {
      ...before,
      updated_at: AFTER_UPDATED_AT,
      cards: cards.filter((_, index) => index !== 40),
    };

    const { diff, payloads } = deriveDeckDiff(before, after);

    // Cutting card 40 shifts fifty-nine positions. Position is a restoration hint, not a
    // change, so exactly one card is reported — and the inversion still puts it back where
    // it was rather than at the end.
    expect(diff.cards).toHaveLength(1);
    expect(diff.cards[0]?.scryfall_id).toBe("printing-40");
    expect(diff.groups).toBeUndefined();
    expect(diff.name).toBeUndefined();
    expect(
      applied(applyDeckDiff(after, invertDeckDiff(stamp(diff)), payloads)),
    ).toEqual({ ...before, updated_at: after.updated_at });
  });

  it("summarises a swap with the copy counts and both names, and reverses it on inversion", () => {
    const before = baseDeck();
    const after = edited((deck) => ({
      ...deck,
      cards: [
        ...deck.cards.filter(
          (entry) => entry.card.scryfall_id !== solRing.scryfall_id,
        ),
        makeEntry(gamble, UNASSIGNED_GROUP_ID),
      ],
    }));

    const { diff } = deriveDeckDiff(before, after);

    // Pinned as properties rather than as the exact string. The rendering carries two
    // non-ASCII glyphs — U+2212 MINUS SIGN and U+00B7 MIDDLE DOT — and pinning them makes
    // retuning the presentation a test failure with no behaviour change. What must hold is
    // that both names appear, the counts appear, and inverting swaps which name is the
    // addition. `summary` is display text; its shape is not a contract.
    const inverted = invertDeckDiff(stamp(diff)).summary;

    for (const summary of [diff.summary, inverted]) {
      expect(summary).toContain("Sol Ring");
      expect(summary).toContain("Gamble");
      expect(summary).toContain("1");
    }
    // Sol Ring left and Gamble arrived, so the sense reverses under inversion. Compared by
    // relative position, which survives any separator or verb the presentation picks.
    expect(diff.summary.indexOf("Sol Ring")).toBeLessThan(
      diff.summary.indexOf("Gamble"),
    );
    expect(inverted).not.toBe(diff.summary);
    expect(cutNames(diff.summary)).toEqual(["Sol Ring"]);
    expect(cutNames(inverted)).toEqual(["Gamble"]);
  });

  it("carries the gameplay identity and the name so a change reads without the catalog", () => {
    const before = baseDeck();
    const after = edited((deck) => ({
      ...deck,
      cards: deck.cards.filter(
        (entry) => entry.card.scryfall_id !== solRing.scryfall_id,
      ),
    }));

    const { diff, payloads } = deriveDeckDiff(before, after);

    expect(diff.cards[0]).toEqual({
      oracle_id: solRing.oracle_id,
      scryfall_id: solRing.scryfall_id,
      name: "Sol Ring",
      before: {
        quantity: 1,
        section: "mainboard",
        categories: ["group-ramp"],
        index: 1,
      },
      after: null,
    });
    expect(payloads).toEqual({ [solRing.scryfall_id]: solRing });
  });
});

describe("deck history application", () => {
  it("refuses to restore a card whose pooled payload was pruned", () => {
    const before = baseDeck();
    const after = edited((deck) => ({
      ...deck,
      cards: deck.cards.filter(
        (entry) => entry.card.scryfall_id !== solRing.scryfall_id,
      ),
    }));
    const { diff } = deriveDeckDiff(before, after);
    const inverted = invertDeckDiff(stamp(diff));

    const failure = refused(applyDeckDiff(after, inverted, {}));

    expect(failure.problem).toBe("missing_payload");
    expect(failure.scryfall_ids).toEqual([solRing.scryfall_id]);
    expect(failure.message).toContain("Sol Ring");
    // The entry that could not be replayed is still readable, which is the whole point of
    // denormalising the name and keeping the counts on the change.
    expect(inverted.cards[0]?.name).toBe("Sol Ring");
    expect(inverted.cards[0]?.after?.quantity).toBe(1);
  });

  it("applies a placement change with no pooled payload at all", () => {
    const before = baseDeck();
    const after = edited((deck) =>
      withEntry(deck, solRing.scryfall_id, {
        ...placementForGroup(UNASSIGNED_GROUP_ID),
      }),
    );
    const { diff, payloads } = deriveDeckDiff(before, after);

    // The card never leaves the deck, so it keeps its own `CardReference` and the pool is
    // not consulted. This is the control for the refusal above: the refusal must fire only
    // when a card genuinely has to be rebuilt.
    const moved = applied(applyDeckDiff(before, stamp(diff), {}));

    expect(moved.cards[1]?.categories).toEqual([UNASSIGNED_GROUP_ID]);
    expect(moved.cards[1]?.card.details).toBe(solRing);
    // And it is not *pooled* either, which is a separate claim from not being consulted:
    // pooling a payload for every quantity change, section move and category change would
    // spend kilobytes of quota per edit that no replay ever reads. Nothing asserted this
    // until Phase 2's audit went looking for the mutant that survives without it.
    expect(payloads).toEqual({});
  });

  it("is idempotent, so a retried edit lands once", () => {
    const before = baseDeck();
    const after = edited((deck) => ({
      ...deck,
      cards: [...deck.cards, makeEntry(gamble, UNASSIGNED_GROUP_ID)],
    }));
    const { diff, payloads } = deriveDeckDiff(before, after);
    const entry = stamp(diff);

    const once = applied(applyDeckDiff(before, entry, payloads));
    const twice = applied(applyDeckDiff(once, entry, payloads));

    expect(twice).toEqual(once);
  });
});

describe("deck history sessions", () => {
  it("derives nothing from a mutation that changed nothing, and refuses to record it", () => {
    const deck = baseDeck();
    const { diff, payloads } = deriveDeckDiff(deck, {
      ...deck,
      updated_at: AFTER_UPDATED_AT,
    });
    const history = createDeckHistory(deck.id);

    const appended = appendToHistory(history, {
      entry: stamp(diff),
      payloads,
      actor: "user",
      newSessionId: "session-2",
    });

    expect(diff.cards).toEqual([]);
    expect(isEmptyDeckDiff(diff)).toBe(true);
    expect(appended).toBe(history);
    expect(appended.sessions).toEqual([]);
  });

  it.each([
    { gap: 179, sessions: 1 },
    { gap: 180, sessions: 1 },
    { gap: 181, sessions: 2 },
  ])(
    "records a user edit $gap seconds after the last one across $sessions session(s)",
    ({ gap, sessions }) => {
      const seeded = seededHistory("user", atSeconds(0));
      const { diff, payloads } = additionDiff();

      const appended = appendToHistory(seeded, {
        entry: stamp(diff, "edit-2", atSeconds(gap)),
        payloads,
        actor: "user",
        newSessionId: "session-2",
      });

      expect(appended.sessions).toHaveLength(sessions);
      expect(appended.sessions.at(-1)?.ended_at).toBe(atSeconds(gap));
    },
  );

  it("opens a new session for an agent edit five seconds into a user session", () => {
    const seeded = seededHistory("user", atSeconds(0));
    const { diff, payloads } = additionDiff();

    const appended = appendToHistory(seeded, {
      entry: stamp(diff, "edit-2", atSeconds(5)),
      payloads,
      actor: "agent",
      newSessionId: "session-2",
    });

    expect(appended.sessions).toHaveLength(2);
    expect(appended.sessions[1]?.actor).toBe("agent");
    expect(appended.sessions[1]?.started_at).toBe(atSeconds(5));
    expect(appended.sessions[0]).toEqual(seeded.sessions[0]);
  });

  it("pools one payload per printing however often it is added and cut", () => {
    const withSolRing = baseDeck();
    const withoutSolRing = {
      ...withSolRing,
      cards: withSolRing.cards.filter(
        (entry) => entry.card.scryfall_id !== solRing.scryfall_id,
      ),
    };
    let history = createDeckHistory(withSolRing.id);
    let offset = 0;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (const [before, after] of [
        [withoutSolRing, withSolRing],
        [withSolRing, withoutSolRing],
      ]) {
        const { diff, payloads } = deriveDeckDiff(before, after);
        history = appendToHistory(history, {
          entry: stamp(diff, `edit-${offset}`, atSeconds(offset * 10)),
          payloads,
          actor: "user",
          newSessionId: "session-1",
        });
        offset += 1;
      }
    }

    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0]?.edits).toHaveLength(6);
    expect(Object.keys(history.cards)).toEqual([solRing.scryfall_id]);
    expect(Object.keys(history.cards)).toHaveLength(1);
  });
});

describe("deck history pruning", () => {
  it("drops the oldest session and the payloads only it referenced", () => {
    const history = additionHistory();

    const pruned = pruneHistory(history, 3, DECK_HISTORY_PAYLOAD_CAP);

    expect(history.sessions).toHaveLength(4);
    expect(pruned.sessions.map((session) => session.id)).toEqual([
      "session-1",
      "session-2",
      "session-3",
    ]);
    expect(Object.keys(pruned.cards).sort()).toEqual(
      [ghalta, counterspell, gamble].map((card) => card.scryfall_id).sort(),
    );
    expect(pruned.cards[solRing.scryfall_id]).toBeUndefined();
  });

  it("keeps a retained entry readable after its payload is gone", () => {
    const pruned = pruneHistory(additionHistory(), DECK_HISTORY_SESSION_CAP, 2);

    // Read depth and undo depth are separate on purpose: the two oldest edits keep their
    // names, counts, times and reasons and lose only the 3KB payload replay would have
    // needed.
    expect(pruned.sessions).toHaveLength(4);
    expect(Object.keys(pruned.cards).sort()).toEqual(
      [counterspell, gamble].map((card) => card.scryfall_id).sort(),
    );
    const oldest = pruned.sessions[0].edits[0];
    expect(oldest.id).toBe("edit-0");
    expect(oldest.at).toBe(atSeconds(0));
    expect(oldest.reason).toBe("stocking the deck");
    expect(oldest.cards[0]?.name).toBe("Sol Ring");
    expect(oldest.cards[0]?.after?.quantity).toBe(1);
    // Readable, and no longer replayable: replaying it forward would have to rebuild
    // Sol Ring from the payload the prune dropped.
    expect(
      refused(
        applyDeckDiff(
          { ...baseDeck(), cards: [], custom_groups: [] },
          oldest,
          pruned.cards,
        ),
      ).problem,
    ).toBe("missing_payload");
  });

  it("empties the log at a cap of zero without losing its identity", () => {
    const pruned = pruneHistory(additionHistory(), 0, 0);

    expect(pruned.deck_id).toBe("deck-1");
    expect(pruned.sessions).toEqual([]);
    expect(pruned.cards).toEqual({});
  });
});

describe("stored deck history", () => {
  it("names its own storage key, separate from the deck library", () => {
    expect(DECK_HISTORY_STORAGE_KEY).toBe("manabase.deck-history.v1");
  });

  it("falls back whole for missing or malformed stored history", () => {
    const fallback = createDeckHistory("deck-1");

    expect(parseDeckHistory(null, fallback)).toBe(fallback);
    expect(parseDeckHistory("{broken", fallback)).toBe(fallback);
    expect(parseDeckHistory({ deck_id: "deck-1" }, fallback)).toBe(fallback);
    expect(
      parseDeckHistory(
        { deck_id: "deck-1", sessions: [{ id: "session-1" }], cards: {} },
        fallback,
      ),
    ).toBe(fallback);
  });

  it("round-trips a written history through JSON", () => {
    const written = additionHistory();

    expect(
      parseDeckHistory(
        JSON.parse(JSON.stringify(written)),
        createDeckHistory("deck-1"),
      ),
    ).toEqual(written);
  });
});

function baseDeck(): Deck {
  return {
    id: "deck-1",
    name: "Gruul Stompy",
    format: "commander",
    cards: [
      makeEntry(ghalta, COMMAND_ZONE_GROUP_ID),
      makeEntry(solRing, "group-ramp"),
      makeEntry(counterspell, UNASSIGNED_GROUP_ID),
    ],
    custom_groups: [{ id: "group-ramp", name: "Ramp" }],
    created_at: CREATED_AT,
    updated_at: BEFORE_UPDATED_AT,
  };
}

/** The deck a mutator would have produced: changed, and stamped with a new `updated_at`. */
function edited(change: (deck: Deck) => Deck): Deck {
  return { ...change(baseDeck()), updated_at: AFTER_UPDATED_AT };
}

function makeEntry(
  card: CardSearchResult,
  groupId: string,
  quantity = 1,
): DeckCardEntry {
  return {
    card: {
      oracle_id: card.oracle_id,
      scryfall_id: card.scryfall_id,
      name: card.name,
      details: card,
    },
    quantity,
    ...placementForGroup(groupId),
  };
}

function withEntry(
  deck: Deck,
  scryfallId: string,
  patch: Partial<DeckCardEntry>,
): Deck {
  return {
    ...deck,
    cards: deck.cards.map((entry) =>
      entry.card.scryfall_id === scryfallId ? { ...entry, ...patch } : entry,
    ),
  };
}

function printing(index: number): CardSearchResult {
  return {
    ...solRing,
    oracle_id: `oracle-${index}`,
    scryfall_id: `printing-${index}`,
    name: `Card ${index}`,
  };
}

function stamp(diff: DeckDiff, id = "edit-1", at = AFTER_UPDATED_AT): DeckEditEntry {
  return { id, at, ...diff };
}

function atSeconds(offset: number): string {
  return new Date(Date.parse(SESSION_START) + offset * 1000).toISOString();
}

/** One user edit adding a card, the smallest non-empty diff the session tests can record. */
function additionDiff(): DeckDiffDerivation {
  const before = baseDeck();
  return deriveDeckDiff(
    before,
    edited((deck) => ({
      ...deck,
      cards: [...deck.cards, makeEntry(gamble, UNASSIGNED_GROUP_ID)],
    })),
  );
}

function seededHistory(actor: DeckHistoryActor, at: string): DeckHistory {
  const { diff, payloads } = additionDiff();
  return appendToHistory(createDeckHistory("deck-1"), {
    entry: stamp(diff, "edit-1", at),
    payloads,
    actor,
    newSessionId: "session-1",
  });
}

/**
 * Four sessions an hour apart, each adding one distinct printing, so every pooled payload
 * belongs to exactly one session and pruning can be asserted by id.
 */
function additionHistory(): DeckHistory {
  let history = createDeckHistory("deck-1");
  let deck: Deck = { ...baseDeck(), cards: [], custom_groups: [] };
  [solRing, ghalta, counterspell, gamble].forEach((card, index) => {
    const after: Deck = {
      ...deck,
      updated_at: atSeconds(index * 3600),
      cards: [...deck.cards, makeEntry(card, UNASSIGNED_GROUP_ID)],
    };
    const { diff, payloads } = deriveDeckDiff(deck, after);
    history = appendToHistory(history, {
      entry: {
        ...stamp(diff, `edit-${index}`, atSeconds(index * 3600)),
        reason: "stocking the deck",
      },
      payloads,
      actor: "user",
      newSessionId: `session-${index}`,
    });
    deck = after;
  });
  return history;
}

function applied(result: DeckDiffApplyResult): Deck {
  if (!result.ok) {
    throw new Error(`the diff was refused: ${result.message}`);
  }
  return result.deck;
}

function refused(result: DeckDiffApplyResult): DeckDiffApplyFailure {
  if (result.ok) {
    throw new Error("the diff applied where a refusal was expected");
  }
  return result;
}

/**
 * Read back the card names a summary marks as cuts.
 *
 * This is the **only** place the tests know how a summary renders. `summary` is display
 * text carrying two non-ASCII glyphs, and an assertion that pinned the whole string would
 * fail on any rephrasing while proving nothing about behaviour. Centralising the coupling
 * here means retuning the presentation touches one function instead of every assertion —
 * the same reason the backend's `read_deck` tests parse the curve rather than string-match
 * it.
 */
function cutNames(summary: string): string[] {
  return summary
    .split("·")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("−"))
    .map((part) => part.slice(1).trim());
}
