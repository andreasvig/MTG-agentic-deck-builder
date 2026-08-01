import { describe, expect, it } from "vitest";

import type { DeckAgentChat, DeckAgentTranscriptEntry } from "./agent";
import { parseStoredAgentChats, serializeAgentChats } from "./agent";

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
