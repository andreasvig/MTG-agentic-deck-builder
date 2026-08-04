import { describe, expect, it } from "vitest";

import { solRing } from "../test/fixtures";
import type { DeckSection } from "./deck";
import type {
  DeckAgentChat,
  DeckAgentToolCall,
  DeckAgentTranscriptEntry,
} from "./agent";
import {
  buildAgentMessages,
  isRefusedDeckEdit,
  parseStoredAgentChats,
  readDeckAgentDeckEdit,
  readDeckAgentDeckTextEdit,
  refusedDeckEdit,
  serializeAgentChats,
  summarizeDeckEditRecord,
  toDeckAgentHistory,
  toDeckSnapshot,
} from "./agent";
import type {
  DeckCardChange,
  DeckCardPlacement,
  DeckDiff,
  DeckHistory,
  DeckSession,
} from "./history";

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

/** One tool line as a finished turn stores it: replayable, with its id and payloads. */
function storedCall(
  overrides: Partial<DeckAgentToolCall> = {},
): DeckAgentToolCall {
  return {
    name: "read_deck",
    signature: "read_deck()",
    ok: true,
    detail: null,
    id: "call-1",
    arguments_json: "{}",
    result: "Deck listing",
    ...overrides,
  };
}

/** One cancelled turn as the panel commits it: the calls that ran, and any prose. */
function interrupted(
  content: string,
  calls: DeckAgentToolCall[],
): DeckAgentTranscriptEntry {
  return {
    message: { role: "assistant", content },
    cardLinks: [],
    toolCalls: calls,
    interrupted: true,
  };
}

/** One question, as the panel appends it before sending. */
function asked(content: string): DeckAgentTranscriptEntry {
  return { message: { role: "user", content }, toolCalls: [], cardLinks: [] };
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
    // Four turns whose results alone are ~400KB — twice the whole budget. Every one of
    // them was answered, which is what makes newest-first the order: an answered turn's
    // payloads are diagnostics, so the one being looked at is the one worth keeping.
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

  it("keeps an interrupted turn's payloads and sheds every answered turn's", () => {
    // The same four 100KB turns, except the newest was cancelled. Its payloads are what
    // its replay is made of, so they are the ones the budget buys.
    const heavy = [
      entry("Answer 0.", { result: "x".repeat(100_000) }),
      entry("Answer 1.", { result: "x".repeat(100_000) }),
      entry("Answer 2.", { result: "x".repeat(100_000) }),
      interrupted("Reading the deck", [
        storedCall({ result: "x".repeat(100_000) }),
      ]),
    ];

    const kept = roundTrip({ "deck-a": chat(heavy) })["deck-a"].entries;

    expect(kept).toHaveLength(4);
    expect(kept.at(-1)?.interrupted).toBe(true);
    expect(kept.at(-1)?.toolCalls[0].result).toHaveLength(100_000);
    for (const held of kept.slice(0, -1)) {
      expect(held.toolCalls[0].result).toBeNull();
      expect(held.toolCalls[0].arguments_json).toBeNull();
    }
  });

  it("buys the interrupted turn's payloads back before a newer answered turn's", () => {
    // The inversion, where newest-first and interrupted-first disagree: the cancelled
    // turn is the *oldest*, and three answered turns after it want the same budget.
    // Only one 100KB payload fits, and it belongs to the turn that cannot be replayed
    // without it.
    const heavy = [
      interrupted("Reading the deck", [
        storedCall({ result: "x".repeat(100_000) }),
      ]),
      entry("Answer 1.", { result: "x".repeat(100_000) }),
      entry("Answer 2.", { result: "x".repeat(100_000) }),
      entry("Answer 3.", { result: "x".repeat(100_000) }),
    ];

    const kept = roundTrip({ "deck-a": chat(heavy) })["deck-a"].entries;

    expect(kept).toHaveLength(4);
    expect(kept[0].toolCalls[0].result).toHaveLength(100_000);
    expect(kept[0].toolCalls[0].arguments_json).toBe("{}");
    for (const held of kept.slice(1)) {
      expect(held.toolCalls[0].result).toBeNull();
    }
  });

  it("round-trips an interrupted turn, including a call whose result is gone", () => {
    const cancelled = interrupted("Checking the curve", [
      storedCall({ id: "call-a", deckRevision: "2026-08-03T09:00:00.000Z" }),
      storedCall({
        id: "call-b",
        name: "see_cards",
        signature: "see_cards(Sol Ring · rules)",
        // Already shed once, so what comes back has to still be a readable turn.
        arguments_json: null,
        result: null,
      }),
    ]);

    const stored = roundTrip({ "deck-a": chat([cancelled]) })["deck-a"].entries;

    expect(stored[0]).toEqual(cancelled);
    expect(stored[0].interrupted).toBe(true);
    expect(stored[0].toolCalls[0].id).toBe("call-a");
    expect(stored[0].toolCalls[0].deckRevision).toBe("2026-08-03T09:00:00.000Z");
    expect(stored[0].toolCalls[1].result).toBeNull();
    // A turn an older build stored has neither field, and reads back with neither
    // rather than with a null claiming the backend reported one.
    const older = roundTrip({ "deck-a": chat([entry("Answered.")]) })["deck-a"]
      .entries[0];
    expect(older.interrupted).toBeUndefined();
    expect(older.toolCalls[0].id).toBeUndefined();
    expect(older.toolCalls[0].deckRevision).toBeUndefined();
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
          // The recorded entry this block describes. The deck's log survives a reload too,
          // so this edit is still its newest recorded change afterwards — and without the
          // id the restored block could no longer prove that and would lose its Undo.
          editId: "edit-7",
        },
      ],
    };

    const stored = roundTrip({ "deck-a": chat([edited]) });

    expect(stored["deck-a"].entries[0]).toEqual(edited);
    expect(stored["deck-a"].entries[0].appliedEdits?.[0].editId).toBe("edit-7");
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

describe("posted agent messages", () => {
  it("posts an answered conversation as the prose it always did", () => {
    const messages = buildAgentMessages([
      asked("What am I missing?"),
      { ...entry("You are light on ramp."), toolCalls: [storedCall()] },
      asked("And the curve?"),
    ]);

    // An answered turn's tools are not replayed: its prose is the answer written from
    // them, so handing them back would pay twice for a reading already used.
    expect(messages).toEqual([
      { role: "user", content: "What am I missing?" },
      { role: "assistant", content: "You are light on ramp." },
      { role: "user", content: "And the curve?" },
    ]);
  });

  it("replays an interrupted turn as its calls, their results, and its prose", () => {
    const messages = buildAgentMessages([
      asked("What am I missing?"),
      interrupted("Sol Ring is the first thing", [
        storedCall({ id: "call-a", result: "Deck listing" }),
        storedCall({
          id: "call-b",
          name: "see_cards",
          signature: "see_cards(Sol Ring · rules)",
          arguments_json: '{"cards":["Sol Ring"]}',
          result: "Sol Ring — {1}, Artifact",
        }),
      ]),
      asked("Carry on."),
    ]);

    expect(messages).toEqual([
      { role: "user", content: "What am I missing?" },
      {
        role: "assistant",
        tool_calls: [
          // Renamed on the way out — the turn's index and the call's, in front of the
          // id the model used. See `replayCallId`.
          { id: "t1c0:call-a", name: "read_deck", arguments_json: "{}" },
          {
            id: "t1c1:call-b",
            name: "see_cards",
            arguments_json: '{"cards":["Sol Ring"]}',
          },
        ],
      },
      { role: "tool", tool_call_id: "t1c0:call-a", content: "Deck listing" },
      {
        role: "tool",
        tool_call_id: "t1c1:call-b",
        content: "Sol Ring — {1}, Artifact",
      },
      { role: "assistant", content: "Sol Ring is the first thing" },
      { role: "user", content: "Carry on." },
    ]);
    // The ids are the pairing, not the order: every call is answered by the `tool`
    // message that names it, and nothing answers a call that was not made.
    const called = messages[1].tool_calls?.map((call) => call.id) ?? [];
    const answered = messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id);
    expect(called).toEqual(["t1c0:call-a", "t1c1:call-b"]);
    expect(answered).toEqual(called);
  });

  it("frames a call whose result is gone instead of posting an unanswered one", () => {
    const messages = buildAgentMessages([
      interrupted("Halfway through", [
        storedCall({ id: "call-a", result: "Deck listing" }),
        storedCall({
          id: "call-b",
          name: "see_cards",
          signature: "see_cards(Sol Ring · rules)",
          // Shed by the storage budget, so there is no result to hand back.
          arguments_json: null,
          result: null,
        }),
        storedCall({
          id: "call-c",
          name: "search_cards",
          signature: "search_cards(mana rocks)",
          arguments_json: '{"query":"mana rocks"}',
          result: "12 cards",
        }),
        // Arguments kept and the result dropped, which is the order the backend sheds
        // in: the call is known and its answer is not, and only the answer decides.
        storedCall({
          id: "call-d",
          name: "search_web",
          signature: "search_web(budget ramp)",
          arguments_json: '{"query":"budget ramp"}',
          result: null,
        }),
      ]),
      asked("Carry on."),
    ]);

    // The resultless call appears in neither list — an unanswered `tool_calls` entry is
    // a 422, and a `tool` message with nothing in it is another — and the turn instead
    // says what ran, in the words the user watched appear.
    expect(messages[0].tool_calls?.map((call) => call.id)).toEqual([
      "t0c0:call-a",
      "t0c2:call-c",
    ]);
    expect(
      messages.filter((message) => message.role === "tool").map((m) => m.tool_call_id),
    ).toEqual(["t0c0:call-a", "t0c2:call-c"]);
    expect(messages[3]).toEqual({
      role: "assistant",
      content:
        "interrupted after see_cards(Sol Ring · rules), search_web(budget ramp)\n\nHalfway through",
    });
    expect(JSON.stringify(messages)).not.toContain("call-b");
    expect(JSON.stringify(messages)).not.toContain("call-d");
  });

  it("replays a turn whose payloads are all gone as framing alone", () => {
    // What a turn stored by the build before this one looks like: no id, no payloads.
    const older = interrupted("", [
      {
        name: "read_deck",
        signature: "read_deck()",
        ok: true,
        detail: null,
        arguments_json: null,
        result: null,
      },
      {
        name: "see_cards",
        signature: "see_cards(Sol Ring · rules)",
        ok: true,
        detail: null,
        arguments_json: null,
        result: null,
      },
    ]);

    const messages = buildAgentMessages([older, asked("Carry on.")]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "interrupted after read_deck(), see_cards(Sol Ring · rules)",
      },
      { role: "user", content: "Carry on." },
    ]);
  });

  it("frames a call the backend answered but never identified", () => {
    // A result with no id cannot be paired with anything, so it is framing too: a
    // `tool` message has to name the call it answers.
    const messages = buildAgentMessages([
      interrupted("Read it", [
        { ...storedCall(), id: undefined },
        // Nor can one whose arguments are only whitespace: they are parsed rather than
        // read, so a value the provider cannot parse is no better than a missing one.
        storedCall({
          id: "call-b",
          signature: "read_history()",
          arguments_json: "   ",
        }),
      ]),
      asked("Carry on."),
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "interrupted after read_deck(), read_history()\n\nRead it",
      },
      { role: "user", content: "Carry on." },
    ]);
  });

  it("posts a replayed result byte for byte, whitespace and all", () => {
    const messages = buildAgentMessages([
      interrupted("", [
        storedCall({ result: "\n  Deck listing\n  Sol Ring — {1}\n" }),
      ]),
      asked("Carry on."),
    ]);

    // Not stripped and not reflowed: the model has to read back exactly what it read
    // the first time, and the contract exempts a `tool` message from the prose rules
    // for that reason. Trimming it here would have quietly rewritten a deck listing.
    expect(messages[1]).toEqual({
      role: "tool",
      tool_call_id: "t0c0:call-1",
      content: "\n  Deck listing\n  Sol Ring — {1}\n",
    });
  });

  it("lets a replayed result run to the length the reply carried it at", () => {
    const messages = buildAgentMessages([
      interrupted("", [
        storedCall({ result: "d".repeat(20_000) }),
        storedCall({ id: "call-2", result: "e".repeat(30_000) }),
      ]),
      asked("Carry on."),
    ]);

    // A five-hundred-card `read_deck` listing is three times the prose bound, and the
    // backend takes all of it: holding a result to the prose bound would have made the
    // largest decks the ones whose replay silently loses two thirds of the deck.
    expect(messages[1].content).toHaveLength(20_000);
    // Past the payload bound it is truncated, with the marker in the backend's own
    // words, because a result that lies about being complete is read as an observation.
    const overlong = messages[2].content ?? "";
    expect(overlong).toHaveLength(24_000);
    expect(overlong.endsWith("… truncated, 6,000 characters more")).toBe(true);
    // Prose keeps the prose bound, which is the control that the two did not merge.
    const wordy = buildAgentMessages([
      interrupted("f".repeat(9_000), []),
      asked("Carry on."),
    ]);
    expect(wordy[0].content).toHaveLength(8_000);
  });

  it("pairs a replayed call to its result by id, not by position", () => {
    // Ids deliberately out of positional order, and one call shed from the middle, so
    // an implementation that indexed the stored calls would name the wrong ones.
    const messages = buildAgentMessages([
      interrupted("", [
        storedCall({ id: "call-9", signature: "read_deck()", result: "nine" }),
        storedCall({
          id: "call-4",
          signature: "see_cards(Sol Ring)",
          result: null,
        }),
        storedCall({ id: "call-3", signature: "read_history()", result: "three" }),
        storedCall({ id: "call-7", signature: "search_cards(rocks)", result: "seven" }),
      ]),
      asked("Carry on."),
    ]);

    expect(messages[0].tool_calls?.map((call) => call.id)).toEqual([
      "t0c0:call-9",
      "t0c2:call-3",
      "t0c3:call-7",
    ]);
    expect(
      messages
        .filter((message) => message.role === "tool")
        .map((message) => [message.tool_call_id, message.content]),
    ).toEqual([
      ["t0c0:call-9", "nine"],
      ["t0c2:call-3", "three"],
      ["t0c3:call-7", "seven"],
    ]);
  });

  it("replays two turns that reused one call id, each under its own name", () => {
    // A provider that numbers its call ids per completion hands two interrupted turns
    // the same `call-1`, and the backend matches ids across the whole request: asked for
    // twice is a 422 that fails the turn. The id is transport rather than provenance —
    // both halves are written here — so both turns keep their replay under distinct
    // names instead of the older one being traded for framing.
    const messages = buildAgentMessages([
      interrupted("First go", [storedCall({ result: "older listing" })]),
      asked("Again?"),
      interrupted("Second go", [storedCall({ result: "newer listing" })]),
      asked("Carry on."),
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        tool_calls: [
          { id: "t0c0:call-1", name: "read_deck", arguments_json: "{}" },
        ],
      },
      { role: "tool", tool_call_id: "t0c0:call-1", content: "older listing" },
      { role: "assistant", content: "First go" },
      { role: "user", content: "Again?" },
      {
        role: "assistant",
        tool_calls: [
          { id: "t2c0:call-1", name: "read_deck", arguments_json: "{}" },
        ],
      },
      { role: "tool", tool_call_id: "t2c0:call-1", content: "newer listing" },
      { role: "assistant", content: "Second go" },
      { role: "user", content: "Carry on." },
    ]);
    // Every id asked for once, every answer naming a call that was asked for, and the
    // two turns' names distinct — which is the whole of the backend's pairing rule.
    const askedFor = messages.flatMap(
      (message) => message.tool_calls?.map((call) => call.id) ?? [],
    );
    const answered = messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id);
    expect(new Set(askedFor).size).toBe(askedFor.length);
    expect(answered).toEqual(askedFor);
    // The id the model used is still legible behind the prefix, so a 422 naming one can
    // be found in the transcript.
    expect(askedFor.every((id) => id?.endsWith(":call-1"))).toBe(true);
  });

  it("replays two calls of one turn that share a stored id", () => {
    // The other collision axis, and the reason the call's own position is in the name:
    // a store holding one id twice inside a single turn would otherwise ask for it
    // twice, which the backend refuses whole.
    const messages = buildAgentMessages([
      interrupted("", [
        storedCall({ result: "first" }),
        storedCall({ signature: "read_history()", result: "second" }),
      ]),
      asked("Carry on."),
    ]);

    expect(messages[0].tool_calls?.map((call) => call.id)).toEqual([
      "t0c0:call-1",
      "t0c1:call-1",
    ]);
    expect(
      messages
        .filter((message) => message.role === "tool")
        .map((message) => [message.tool_call_id, message.content]),
    ).toEqual([
      ["t0c0:call-1", "first"],
      ["t0c1:call-1", "second"],
    ]);
  });

  it("holds a renamed call id inside the length the contract allows", () => {
    const messages = buildAgentMessages([
      interrupted("", [storedCall({ id: "c".repeat(250) })]),
      asked("Carry on."),
    ]);

    const id = messages[0].tool_calls?.[0].id ?? "";
    expect(id).toHaveLength(200);
    expect(id.startsWith("t0c0:")).toBe(true);
    // Truncating the tail cannot collide with anything: the prefix alone is unique.
    expect(messages[1].tool_call_id).toBe(id);
  });

  it("sheds the oldest replays to framing before the request runs out of messages", () => {
    // Twenty cancelled turns of fifty calls each is 1,040 messages, and the request may
    // carry a thousand. Every one of them is stored, so the budget has to choose.
    const heavy = Array.from({ length: 20 }, (_, turn) =>
      interrupted(
        `Turn ${turn}`,
        Array.from({ length: 50 }, (_, call) =>
          storedCall({
            id: `t${turn}-c${call}`,
            name: "see_cards",
            signature: `see_cards(card ${call})`,
            result: "rules text",
          }),
        ),
      ),
    );

    const messages = buildAgentMessages([...heavy, asked("Carry on.")]);

    expect(messages.length).toBeLessThanOrEqual(1_000);
    // Nothing is dropped: every turn still says what it ran, and the newest — the one
    // the next question follows on from — is the one that keeps its replay.
    expect(messages.filter((message) => message.role === "tool")).toHaveLength(
      19 * 50,
    );
    expect(messages.at(-2)).toEqual({
      role: "assistant",
      content: "Turn 19",
    });
    expect(messages[0]).toEqual({
      role: "assistant",
      content: `interrupted after ${Array.from(
        { length: 50 },
        (_, call) => `see_cards(card ${call})`,
      ).join(", ")}\n\nTurn 0`,
    });
    expect(messages.at(-1)).toEqual({ role: "user", content: "Carry on." });
  });

  it("leaves out the oldest turns when even the framing will not fit", () => {
    const many = Array.from({ length: 1_200 }, (_, index) =>
      asked(`Question ${index}`),
    );

    const messages = buildAgentMessages(many);

    // A request over the bound is refused whole, so the oldest turns are left out —
    // which is what the backend's own history window would have done to them anyway.
    expect(messages).toHaveLength(1_000);
    expect(messages[0]).toEqual({ role: "user", content: "Question 200" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "Question 1199" });
  });

  it("posts the deck revision a call recorded, and nothing when it recorded none", () => {
    const withRevision = buildAgentMessages([
      interrupted("", [storedCall({ deckRevision: "2026-08-03T09:00:00.000Z" })]),
      asked("Carry on."),
    ]);
    const without = buildAgentMessages([
      interrupted("", [storedCall()]),
      asked("Carry on."),
    ]);

    expect(withRevision[0].tool_calls?.[0]).toEqual({
      id: "t0c0:call-1",
      name: "read_deck",
      arguments_json: "{}",
      deck_revision: "2026-08-03T09:00:00.000Z",
    });
    // Absent rather than empty: "the browser could not say" is not "the deck has not
    // changed", and only the backend knows which tools the difference matters for.
    expect(without[0].tool_calls?.[0].deck_revision).toBeUndefined();
  });

  it("frames the calls past the number one message may carry", () => {
    const many = Array.from({ length: 52 }, (_, index) =>
      storedCall({
        id: `call-${index}`,
        signature: `see_cards(card ${index})`,
        name: "see_cards",
      }),
    );

    const messages = buildAgentMessages([interrupted("", many), asked("Go on.")]);

    expect(messages[0].tool_calls).toHaveLength(50);
    expect(messages.at(-2)).toEqual({
      role: "assistant",
      content: "interrupted after see_cards(card 50), see_cards(card 51)",
    });
  });

  it("says nothing for an interrupted turn that read nothing and wrote nothing", () => {
    // Nothing happened, so there is nothing to hand back — and an assistant message
    // with empty content is a rejected request rather than a silence.
    expect(buildAgentMessages([interrupted("", []), asked("Go on.")])).toEqual([
      { role: "user", content: "Go on." },
    ]);
  });
});

describe("posted deck snapshot", () => {
  it("carries the deck's revision when it is given one, and omits it otherwise", () => {
    expect(toDeckSnapshot("Gruul Stompy", [], "2026-08-03T09:00:00.000Z")).toEqual({
      name: "Gruul Stompy",
      cards: [],
      updated_at: "2026-08-03T09:00:00.000Z",
    });
    // The control that the default did not shift: a caller with no revision posts a
    // snapshot with no revision, which the backend reads as "could not say".
    expect(toDeckSnapshot("Gruul Stompy", [])).toEqual({
      name: "Gruul Stompy",
      cards: [],
    });
  });

  it("posts a non-empty deck description with the snapshot", () => {
    expect(
      toDeckSnapshot(
        "Gruul Stompy",
        [],
        "2026-08-03T09:00:00.000Z",
        "High power, simple turns, little instant-speed interaction.",
      ),
    ).toMatchObject({
      name: "Gruul Stompy",
      description:
        "High power, simple turns, little instant-speed interaction.",
    });
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
  it("reads a bounded name and description replacement whole", () => {
    expect(
      readDeckAgentDeckTextEdit({
        deck_name: "Untitled Commander",
        reason: "capturing the user's intent",
        name: "Low-Friction Kinnan",
        description: "cEDH, but easy to pilot with short combo turns.",
      }),
    ).toEqual({
      deck_name: "Untitled Commander",
      reason: "capturing the user's intent",
      name: "Low-Friction Kinnan",
      description: "cEDH, but easy to pilot with short combo turns.",
    });
    expect(
      readDeckAgentDeckTextEdit({
        deck_name: "Untitled Commander",
        reason: "nothing",
      }),
    ).toBeNull();
    expect(
      readDeckAgentDeckTextEdit({
        deck_name: "Untitled Commander",
        reason: "too much",
        description: "x".repeat(2_001),
      }),
    ).toBeNull();
  });

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
      // A section outside the two the deck has. Refused rather than read as "not the
      // command zone", because that reading would take the user's commander out of it on
      // an edit whose placement field was garbage.
      {
        ...deckEditEvent(),
        changes: [{ ...(good[0] as object), section: "sideboard" }],
      },
      { ...deckEditEvent(), changes: [{ ...(good[0] as object), section: 7 }] },
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

  it("reads a section the deck knows, and treats an absent one as no placement at all", () => {
    const changes = deckEditEvent().changes as unknown[];

    const commander = readDeckAgentDeckEdit({
      ...deckEditEvent(),
      changes: [{ ...(changes[0] as object), section: "command_zone" }],
    });
    expect(commander?.changes[0].section).toBe("command_zone");

    // Absent stays absent through the reader. The applier reads that as "leave placement
    // alone", and a `mainboard` filled in here would be a placement nobody asked for.
    const plain = readDeckAgentDeckEdit(deckEditEvent());
    expect(plain?.changes[0]).not.toHaveProperty("section");
    expect(
      readDeckAgentDeckEdit({
        ...deckEditEvent(),
        changes: [{ ...(changes[0] as object), section: null }],
      })?.changes[0],
    ).not.toHaveProperty("section");
  });

  it("counts copies in and copies out, and a move as neither", () => {
    const diff: DeckDiff = {
      summary: "+2 / −4",
      cards: [
        recordedChange("Sol Ring", null, placed(2)),
        recordedChange("Rampant Growth", placed(2), null),
        // Same count, new section: a card made the commander is neither in nor out.
        recordedChange("Arcane Signet", placed(1), placed(1, "command_zone")),
        // The deck held three copies and ended with one. Two copies out, which no request
        // could have said: the one that produced this asked for a quantity of 1 while
        // believing the deck held 1, and is therefore a request for nothing at all.
        recordedChange("Gamble", placed(3), placed(1)),
      ],
    };

    expect(
      summarizeDeckEditRecord(
        diff,
        "Swapping in two rocks for the weakest ramp.",
        "edit-7",
      ),
    ).toEqual({
      reason: "Swapping in two rocks for the weakest ramp.",
      addedCopies: 2,
      removedCopies: 4,
      added: ["Sol Ring"],
      removed: ["Rampant Growth", "Gamble"],
      // Same count on both sides. A derivation records a card only when something about it
      // changed, so what is left at an unchanged count moved rather than did nothing.
      moved: ["Arcane Signet"],
      // The entry it describes, which is what decides whether it may carry an Undo.
      editId: "edit-7",
    });
  });

  it("records a refusal as a block that names nothing and holds no entry", () => {
    const refused = refusedDeckEdit(
      "Counterspell cannot share the command zone with Ghalta, Primal Hunger.",
    );

    // The deck's own sentence, and no claim of any kind about the cards the edit named.
    expect(refused).toEqual({
      reason:
        "Counterspell cannot share the command zone with Ghalta, Primal Hunger.",
      addedCopies: 0,
      removedCopies: 0,
      added: [],
      removed: [],
      moved: [],
    });
    expect(isRefusedDeckEdit(refused)).toBe(true);
    // No entry, because nothing was recorded — which is what keeps the Undo off it.
    expect(refused.editId).toBeUndefined();

    // And an edit the deck did record is never read as one. Every recorded edit changed at
    // least one card, and that card lands in one of the three lists, so the shapes cannot
    // collide however the block is stored and read back.
    const applied = summarizeDeckEditRecord(
      { summary: "+1 / −0", cards: [recordedChange("Sol Ring", null, placed(1))] },
      "You have no ramp at all.",
      "edit-1",
    );
    expect(isRefusedDeckEdit(applied)).toBe(false);
  });
});

/** One side of a recorded change. `index` is a position hint the summary never reads. */
function placed(
  quantity: number,
  section: DeckSection = "mainboard",
): DeckCardPlacement {
  return { quantity, section, index: 0 };
}

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

function storedHistory(
  sessions: DeckSession[],
  at?: string | null,
): string {
  const history: DeckHistory = {
    deck_id: "deck-a",
    sessions,
    cards: {},
    // The tip unless a test says otherwise: a log with a cursor behind it is the special
    // case, and every test that does not care about travel is about a deck that has
    // everything applied.
    at:
      at === undefined
        ? (sessions.at(-1)?.edits.at(-1)?.id ?? null)
        : at,
  };
  return JSON.stringify({ "deck-a": history });
}

describe("posted deck history", () => {
  it("projects a recorded edit into what the agent reads", () => {
    const raw = storedHistory([
      recordedSession(
        1,
        "agent",
        [
          recordedChange(
            "Sol Ring",
            null,
            { quantity: 2, section: "mainboard", index: 4 },
          ),
          recordedChange(
            "Rampant Growth",
            { quantity: 1, section: "mainboard", index: 1 },
            null,
          ),
        ],
        "Swapping in two rocks for the weakest ramp.",
      ),
    ]);

    expect(toDeckAgentHistory(raw, "deck-a")).toEqual({
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
                  // No `before`: the card was not in the deck. A placement is a count and
                  // a section — `index` is a restoration hint and does not travel.
                  after: { quantity: 2, section: "mainboard" },
                },
                {
                  name: "Rampant Growth",
                  before: { quantity: 1, section: "mainboard" },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("marks the edits the deck has stepped back past, and only those", () => {
    const stepped = storedHistory(
      [
        recordedSession(1, "user", [recordedChange("Sol Ring", null, placed(1))]),
        recordedSession(2, "agent", [
          recordedChange("Gamble", null, placed(1)),
        ]),
      ],
      // The cursor sits on the first session's edit, so the second one is undone.
      "edit-1",
    );

    const posted = toDeckAgentHistory(stepped, "deck-a");

    // Posted rather than filtered out: "put that back" is the question an undone edit
    // answers, and a history that dropped them would leave the agent unable to see what
    // the user had just reversed.
    expect(posted.sessions[0].edits[0]).not.toHaveProperty("undone");
    expect(posted.sessions[1].edits[0].undone).toBe(true);
  });

  it("marks nothing when the deck stands at the newest edit", () => {
    const posted = toDeckAgentHistory(
      storedHistory([
        recordedSession(1, "user", [recordedChange("Sol Ring", null, placed(1))]),
      ]),
      "deck-a",
    );

    // The control. `undone` is omitted rather than sent as false, so the ordinary edit
    // costs no bytes — and a mutant that marked every edit would pass a check that only
    // looked for the flag on the undone one.
    expect(posted.sessions[0].edits[0]).not.toHaveProperty("undone");
  });

  it("keeps the newest sessions inside the cap the backend accepts", () => {
    const change = recordedChange("Sol Ring", null, {
      quantity: 1,
      section: "mainboard",
      index: 0,
    });
    const raw = storedHistory(
      Array.from({ length: 62 }, (_, index) =>
        recordedSession(index, "user", [change]),
      ),
    );

    const posted = toDeckAgentHistory(raw, "deck-a");

    // A request over the bound is refused whole, which would fail the chat turn rather
    // than the history — so the browser prunes before it asks.
    //
    // Pinned to the literal 50, deliberately, and NOT to `DECK_HISTORY_SESSION_CAP`.
    // That constant is storage depth and exists to be tuned against the localStorage
    // budget; this number is the backend's `MAX_HISTORY_SESSIONS`, and exceeding it 422s
    // the turn. Asserting against the shared symbol would have let a quota-motivated
    // change to read depth silently break every conversation with this test still green.
    expect(posted.sessions).toHaveLength(50);
    // Oldest session first, and what was dropped is the oldest of them.
    expect(posted.sessions[0].started_at).toBe(recordedAt(12));
    expect(posted.sessions.at(-1)?.started_at).toBe(recordedAt(61));
  });

  it("keeps the total edit count and one edit's card count inside their bounds", () => {
    const change = recordedChange("Sol Ring", null, {
      quantity: 1,
      section: "mainboard",
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
            index,
          }),
        ),
      },
    ];

    const posted = toDeckAgentHistory(storedHistory([busy, wide]), "deck-a");

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

  it("truncates a long reason and card name to the length the backend accepts", () => {
    const change = recordedChange("N".repeat(400), null, {
      quantity: 1,
      section: "mainboard",
      index: 0,
    });
    const session = recordedSession(1, "agent", []);
    session.edits = [
      {
        id: "edit-long",
        at: recordedAt(1),
        summary: "+1 / −0",
        reason: "R".repeat(500),
        cards: [change],
      },
    ];

    const posted = toDeckAgentHistory(storedHistory([session]), "deck-a");
    const edit = posted.sessions[0].edits[0];

    // `ShortLabel` is 200 characters and a request over it is refused whole, so an
    // unbounded model reason would fail the whole chat turn. Nothing exercised this
    // before: no fixture carried a label anywhere near the bound.
    expect(edit.reason).toHaveLength(200);
    expect(edit.cards[0].name).toHaveLength(200);
  });

  it("drops a stored change the backend would refuse rather than failing the turn", () => {
    // None of these is producible by `deriveDeckDiff`. They are what a corrupted or
    // hand-edited log can hold, and `parseDeckHistory` validates the container rather
    // than every leaf. A rejected request is refused whole, so one bad change would stop
    // the agent answering at all for this deck instead of costing it some history.
    const good = recordedChange("Sol Ring", null, {
      quantity: 1,
      section: "mainboard",
      index: 0,
    });
    const session = recordedSession(1, "user", []);
    session.edits = [
      {
        id: "edit-corrupt",
        at: recordedAt(1),
        summary: "+1 / −0",
        cards: [
          good,
          // Changed nothing, which the backend's own validator refuses.
          { ...good, name: "Neither Side", before: null, after: null },
          // Blank after stripping, so shorter than `ShortLabel` allows.
          { ...good, name: "   " },
          // Outside the copy bounds, and not an integer.
          { ...good, name: "Too Many", after: { ...good.after!, quantity: 400 } },
          { ...good, name: "Fractional", after: { ...good.after!, quantity: 1.5 } },
          // A section the backend's Literal does not know.
          {
            ...good,
            name: "Nowhere",
            after: { ...good.after!, section: "sideboard" as never },
          },
        ],
      },
    ];

    const posted = toDeckAgentHistory(storedHistory([session]), "deck-a");

    expect(posted.sessions[0].edits[0].cards.map((card) => card.name)).toEqual([
      "Sol Ring",
    ]);
  });

  it("reads an absent, unreadable or unrecorded history as nothing recorded", () => {
    expect(toDeckAgentHistory(null, "deck-a")).toEqual({ sessions: [] });
    expect(toDeckAgentHistory("{oh no", "deck-a")).toEqual({ sessions: [] });
    expect(toDeckAgentHistory("[]", "deck-a")).toEqual({ sessions: [] });
    // Another deck's log is not this deck's history.
    expect(
      toDeckAgentHistory(storedHistory([recordedSession(1, "user", [])]), "deck-b"),
    ).toEqual({ sessions: [] });
  });
});
