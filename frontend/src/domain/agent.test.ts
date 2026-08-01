import { describe, expect, it } from "vitest";

import { solRing } from "../test/fixtures";
import type {
  DeckAgentChat,
  DeckAgentDeckEdit,
  DeckAgentTranscriptEntry,
} from "./agent";
import {
  parseStoredAgentChats,
  readDeckAgentDeckEdit,
  serializeAgentChats,
  summarizeDeckEdit,
  toDeckAgentHistory,
} from "./agent";
import type { DeckCardChange, DeckHistory, DeckSession } from "./history";
import { DECK_HISTORY_SESSION_CAP } from "./history";

function entry(
  content: string,
  overrides: Partial<DeckAgentTranscriptEntry["toolCalls"][number]> = {},
  withTool = true,
): DeckAgentTranscriptEntry {
  return {
    message: { role: "assistant", content },
    cardLinks: [],
    toolCalls: withTool
      ? [
          {
            name: "read_deck",
            signature: "read_deck()",
            ok: true,
            detail: null,
            arguments_json: "{}",
            result: "Deck listing",
            ...overrides,
          },
        ]
      : [],
  };
}

function chat(
  entries: DeckAgentTranscriptEntry[],
  updatedAt = "2026-07-31T10:00:00.000Z",
  draft = "",
): DeckAgentChat {
  return { entries, spentUsd: 0.0012, unpricedCalls: 1, draft, updatedAt };
}

function roundTrip(chats: Record<string, DeckAgentChat>) {
  return parseStoredAgentChats(serializeAgentChats(chats));
}

describe("agent chat storage", () => {
  it("round-trips a conversation with its spend and its tool payloads", () => {
    const stored = roundTrip({ "deck-a": chat([entry("Sol Ring.")]) });

    expect(stored["deck-a"]).toEqual(chat([entry("Sol Ring.")]));
  });

  it("treats unreadable storage as no conversations", () => {
    expect(parseStoredAgentChats(null)).toEqual({});
    expect(parseStoredAgentChats("")).toEqual({});
    expect(parseStoredAgentChats("{oh no")).toEqual({});
    expect(parseStoredAgentChats("[]")).toEqual({});
    expect(parseStoredAgentChats(JSON.stringify({ version: 1 }))).toEqual({});
  });

  it("drops a turn whose message is not a message, keeping the rest", () => {
    const raw = JSON.stringify({
      version: 1,
      chats: {
        "deck-a": {
          entries: [
            { message: { role: "wizard", content: "hi" }, toolCalls: [] },
            { message: { role: "user", content: "Best ramp?" }, toolCalls: [] },
          ],
          spentUsd: -3,
          unpricedCalls: "many",
          updatedAt: 7,
        },
      },
    });

    // A negative spend and a non-numeric count are read as zero rather than
    // trusted, because they would otherwise show up in the badge as fact.
    expect(parseStoredAgentChats(raw)).toEqual({
      "deck-a": {
        entries: [
          // Stored before card links existed, so it reads back with none rather
          // than being dropped: an old conversation is still a conversation.
          { message: { role: "user", content: "Best ramp?" }, toolCalls: [], cardLinks: [] },
        ],
        spentUsd: 0,
        unpricedCalls: 0,
        draft: "",
        updatedAt: "",
      },
    });
  });

  it("keeps a deck that has only an unsent draft", () => {
    const stored = roundTrip({
      "deck-a": chat([], "2026-07-31T10:00:00.000Z", "should I cut a land?"),
      // Nothing said and nothing typed is not a conversation.
      "deck-b": chat([], "2026-07-31T09:00:00.000Z"),
    });

    expect(stored["deck-a"].draft).toBe("should I cut a land?");
    expect(stored["deck-b"]).toBeUndefined();
  });

  it("holds a restored draft to the length the composer accepts", () => {
    const raw = JSON.stringify({
      version: 1,
      chats: {
        "deck-a": { entries: [], draft: "q".repeat(9_000), updatedAt: "" },
      },
    });

    // Restoring more than the composer allows would leave text that cannot be sent.
    expect(parseStoredAgentChats(raw)["deck-a"].draft).toHaveLength(8_000);
  });

  it("keeps the newest decks' conversations when there are too many", () => {
    const chats = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [
        `deck-${index}`,
        chat(
          [entry(`Answer ${index}.`, {}, false)],
          `2026-07-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
        ),
      ]),
    );

    const stored = roundTrip(chats);

    expect(Object.keys(stored)).toHaveLength(12);
    expect(stored["deck-14"]).toBeDefined();
    expect(stored["deck-0"]).toBeUndefined();
    expect(stored["deck-2"]).toBeUndefined();
  });

  it("drops tool payloads before it drops what was said", () => {
    // Four turns whose results alone are ~400KB — twice the whole budget.
    const heavy = Array.from({ length: 4 }, (_, index) =>
      entry(`Answer ${index}.`, { result: "x".repeat(100_000) }),
    );

    const stored = roundTrip({ "deck-a": chat(heavy) });

    expect(stored["deck-a"].entries.map((held) => held.message.content)).toEqual([
      "Answer 0.",
      "Answer 1.",
      "Answer 2.",
      "Answer 3.",
    ]);
    // The transcript survived whole; the diagnostics are what paid for it. The
    // newest turn — the one being looked at — is the one that keeps them, and the
    // rest read as absent, which is what a restored turn's payloads now are.
    const kept = stored["deck-a"].entries;
    expect(kept.at(-1)?.toolCalls[0].result).toHaveLength(100_000);
    for (const held of kept.slice(0, -1)) {
      expect(held.toolCalls[0].result).toBeNull();
      expect(held.toolCalls[0].arguments_json).toBeNull();
      // The line the user reads is never what gets dropped.
      expect(held.toolCalls[0].signature).toBe("read_deck()");
    }
  });

  it("drops the oldest turns once even the bare transcript will not fit", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      entry(`Answer ${index}: ${"y".repeat(10_000)}`, {}, false),
    );

    const stored = roundTrip({ "deck-a": chat(many) });

    const kept = stored["deck-a"].entries;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(40);
    // Newest-first spending means the last thing said is the last thing lost.
    expect(kept.at(-1)?.message.content).toContain("Answer 39:");
    expect(
      kept.some((held) => held.message.content.startsWith("Answer 0:")),
    ).toBe(false);
  });

  it("round-trips an applied edit block, and reads an old turn as having none", () => {
    const edited: DeckAgentTranscriptEntry = {
      ...entry("Swapped in a rock.", {}, false),
      appliedEdits: [
        {
          reason: "Swapping in two rocks for the weakest ramp.",
          addedCopies: 2,
          removedCopies: 2,
          added: ["Sol Ring", "Arcane Signet"],
          removed: ["Wayfarer's Bauble", "Rampant Growth"],
          moved: [],
        },
      ],
    };

    const stored = roundTrip({ "deck-a": chat([edited]) });

    expect(stored["deck-a"].entries[0]).toEqual(edited);
    // A turn stored before the agent could edit anything did not edit anything, so it
    // reads back with the field absent rather than with an empty list claiming it did.
    const plain = roundTrip({ "deck-a": chat([entry("Just talking.", {}, false)]) });
    expect(plain["deck-a"].entries[0].appliedEdits).toBeUndefined();
  });

  it("spends the budget on the active deck before an older one", () => {
    const heavy = Array.from({ length: 30 }, (_, index) =>
      entry(`Old ${index}: ${"z".repeat(10_000)}`, {}, false),
    );

    const stored = roundTrip({
      "deck-old": chat(heavy, "2026-07-01T10:00:00.000Z"),
      "deck-active": chat([entry("Just asked.", {}, false)], "2026-07-31T10:00:00.000Z"),
    });

    expect(stored["deck-active"].entries).toHaveLength(1);
    expect(stored["deck-old"].entries.length).toBeLessThan(30);
  });
});

/** The event as the backend emits it: an add carrying its card, and a cut that cannot. */
function deckEditEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    deck_name: "Gruul Stompy",
    reason: "Swapping in two rocks for the weakest ramp.",
    changes: [
      {
        scryfall_id: solRing.scryfall_id,
        name: solRing.name,
        quantity: 1,
        previous_quantity: 0,
        card: solRing,
      },
      {
        scryfall_id: "printing-rampant-growth",
        name: "Rampant Growth",
        quantity: 0,
        previous_quantity: 1,
      },
    ],
    ...overrides,
  };
}

describe("agent deck edits", () => {
  it("reads a resolved edit, keeping the card payload only where it is needed", () => {
    const edit = readDeckAgentDeckEdit(deckEditEvent());

    expect(edit).toEqual({
      deck_name: "Gruul Stompy",
      reason: "Swapping in two rocks for the weakest ramp.",
      changes: [
        {
          scryfall_id: solRing.scryfall_id,
          name: solRing.name,
          quantity: 1,
          previous_quantity: 0,
          card: solRing,
        },
        {
          scryfall_id: "printing-rampant-growth",
          name: "Rampant Growth",
          quantity: 0,
          previous_quantity: 1,
        },
      ],
    });
  });

  it("refuses a malformed edit whole rather than applying part of it", () => {
    const good = deckEditEvent().changes as unknown[];
    const malformed: unknown[] = [
      // Not an event payload at all.
      null,
      "deck_edit",
      {},
      // No reason, which is the field that makes history worth reading.
      { ...deckEditEvent(), reason: 7 },
      // No changes: an edit that changes nothing is not an edit.
      { ...deckEditEvent(), changes: [] },
      // A hundred is a whole deck replaced; a hundred and one is not an edit this
      // backend can have produced.
      {
        ...deckEditEvent(),
        changes: Array.from({ length: 101 }, () => good[0]),
      },
      // Rejected, never coerced: a quantity that quietly became zero deletes a card.
      { ...deckEditEvent(), changes: [{ ...(good[0] as object), quantity: "one" }] },
      { ...deckEditEvent(), changes: [{ ...(good[0] as object), quantity: 1.5 }] },
      { ...deckEditEvent(), changes: [{ ...(good[0] as object), quantity: 100 }] },
      {
        ...deckEditEvent(),
        changes: [{ ...(good[0] as object), previous_quantity: null }],
      },
      // Adding copies without the card to add: the deck's validators read fields only
      // the payload carries, so this cannot be applied.
      {
        ...deckEditEvent(),
        changes: [{ ...(good[0] as object), card: undefined }],
      },
      { ...deckEditEvent(), changes: [{ ...(good[0] as object), card: { name: "Sol Ring" } }] },
    ];

    for (const candidate of malformed) {
      expect(readDeckAgentDeckEdit(candidate)).toBeNull();
    }

    // One unreadable change refuses the whole edit, so the readable one beside it is
    // not applied on its own. A half-applied edit records an intent that did not happen.
    expect(
      readDeckAgentDeckEdit({
        ...deckEditEvent(),
        changes: [good[0], { ...(good[1] as object), name: 42 }],
      }),
    ).toBeNull();
  });

  it("counts copies in and copies out, and a move as neither", () => {
    const edit = readDeckAgentDeckEdit(
      deckEditEvent({
        changes: [
          {
            scryfall_id: solRing.scryfall_id,
            name: solRing.name,
            quantity: 2,
            previous_quantity: 0,
            card: solRing,
          },
          {
            scryfall_id: "printing-rampant-growth",
            name: "Rampant Growth",
            quantity: 0,
            previous_quantity: 2,
          },
          {
            scryfall_id: "printing-arcane-signet",
            name: "Arcane Signet",
            quantity: 1,
            previous_quantity: 1,
            group: "Ramp",
          },
        ],
      }),
    ) as DeckAgentDeckEdit;

    expect(summarizeDeckEdit(edit)).toEqual({
      reason: "Swapping in two rocks for the weakest ramp.",
      addedCopies: 2,
      removedCopies: 2,
      added: ["Sol Ring"],
      removed: ["Rampant Growth"],
      // Same count, new group. The backend drops a change the deck already satisfies,
      // so what is left at an unchanged count moved rather than did nothing.
      moved: ["Arcane Signet"],
    });
  });
});

/** One recorded card change, in the shape the browser writes to storage. */
function recordedChange(
  name: string,
  before: DeckCardChange["before"],
  after: DeckCardChange["after"],
): DeckCardChange {
  return {
    oracle_id: `oracle-${name}`,
    scryfall_id: `printing-${name}`,
    name,
    before,
    after,
  };
}

/** One minute apart, which is well inside the session window and never reused. */
function recordedAt(index: number): string {
  return new Date(Date.UTC(2026, 6, 31, 10, 0, 0) + index * 60_000).toISOString();
}

function recordedSession(
  index: number,
  actor: "user" | "agent",
  changes: DeckCardChange[],
  reason?: string,
): DeckSession {
  const at = recordedAt(index);
  return {
    id: `session-${index}`,
    actor,
    started_at: at,
    ended_at: at,
    edits: [
      {
        id: `edit-${index}`,
        at,
        summary: "+1 / −0",
        cards: changes,
        ...(reason ? { reason } : {}),
      },
    ],
  };
}

function storedHistory(sessions: DeckSession[]): string {
  const history: DeckHistory = {
    deck_id: "deck-a",
    sessions,
    cards: {},
  };
  return JSON.stringify({ "deck-a": history });
}

describe("posted deck history", () => {
  it("projects a recorded edit into what the agent reads, naming the group", () => {
    const raw = storedHistory([
      recordedSession(
        1,
        "agent",
        [
          recordedChange(
            "Sol Ring",
            null,
            { quantity: 2, section: "mainboard", categories: ["group-ramp"], index: 4 },
          ),
          recordedChange(
            "Rampant Growth",
            { quantity: 1, section: "mainboard", categories: ["unassigned"], index: 1 },
            null,
          ),
        ],
        "Swapping in two rocks for the weakest ramp.",
      ),
    ]);

    expect(
      toDeckAgentHistory(raw, "deck-a", [{ id: "group-ramp", name: "Ramp" }]),
    ).toEqual({
      sessions: [
        {
          actor: "agent",
          started_at: recordedAt(1),
          ended_at: recordedAt(1),
          edits: [
            {
              at: recordedAt(1),
              reason: "Swapping in two rocks for the weakest ramp.",
              cards: [
                {
                  name: "Sol Ring",
                  // No `before`: the card was not in the deck. The group travels as the
                  // name on screen, never the id the deck files it under.
                  after: { quantity: 2, section: "mainboard", group: "Ramp" },
                },
                {
                  name: "Rampant Growth",
                  // Unfiled, so no group at all rather than the internal placeholder.
                  before: { quantity: 1, section: "mainboard" },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("keeps the newest sessions inside the cap the backend accepts", () => {
    const change = recordedChange("Sol Ring", null, {
      quantity: 1,
      section: "mainboard",
      categories: ["unassigned"],
      index: 0,
    });
    const raw = storedHistory(
      Array.from({ length: DECK_HISTORY_SESSION_CAP + 12 }, (_, index) =>
        recordedSession(index, "user", [change]),
      ),
    );

    const posted = toDeckAgentHistory(raw, "deck-a", []);

    // A request over the bound is refused whole, which would fail the chat turn rather
    // than the history — so the browser prunes before it asks.
    expect(posted.sessions).toHaveLength(DECK_HISTORY_SESSION_CAP);
    // Oldest session first, and what was dropped is the oldest of them.
    expect(posted.sessions[0].started_at).toBe(recordedAt(12));
    expect(posted.sessions.at(-1)?.started_at).toBe(
      recordedAt(DECK_HISTORY_SESSION_CAP + 11),
    );
  });

  it("keeps the total edit count and one edit's card count inside their bounds", () => {
    const change = recordedChange("Sol Ring", null, {
      quantity: 1,
      section: "mainboard",
      categories: ["unassigned"],
      index: 0,
    });
    const busy = recordedSession(1, "user", [change]);
    busy.edits = Array.from({ length: 600 }, (_, index) => ({
      id: `edit-${index}`,
      at: recordedAt(index),
      summary: "+1 / −0",
      cards: [change],
    }));
    const wide = recordedSession(2, "agent", []);
    wide.edits = [
      {
        id: "edit-wide",
        at: recordedAt(700),
        summary: "+300 / −0",
        cards: Array.from({ length: 300 }, (_, index) =>
          recordedChange(`Card ${index}`, null, {
            quantity: 1,
            section: "mainboard",
            categories: ["unassigned"],
            index,
          }),
        ),
      },
    ];

    const posted = toDeckAgentHistory(storedHistory([busy, wide]), "deck-a", []);

    // The session cap alone would let fifty sessions of six hundred edits through, and
    // a request over either bound is refused whole — which fails the chat turn rather
    // than the history.
    const total = posted.sessions.reduce(
      (sum, session) => sum + session.edits.length,
      0,
    );
    expect(total).toBe(500);
    // Spent newest-first: the newest session keeps its edit, the older one is trimmed.
    expect(posted.sessions.at(-1)?.edits).toHaveLength(1);
    expect(posted.sessions.at(-1)?.edits[0].cards).toHaveLength(250);
  });

  it("reads an absent, unreadable or unrecorded history as nothing recorded", () => {
    expect(toDeckAgentHistory(null, "deck-a", [])).toEqual({ sessions: [] });
    expect(toDeckAgentHistory("{oh no", "deck-a", [])).toEqual({ sessions: [] });
    expect(toDeckAgentHistory("[]", "deck-a", [])).toEqual({ sessions: [] });
    // Another deck's log is not this deck's history.
    expect(
      toDeckAgentHistory(
        storedHistory([recordedSession(1, "user", [])]),
        "deck-b",
        [],
      ),
    ).toEqual({ sessions: [] });
  });
});
