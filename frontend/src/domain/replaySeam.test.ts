// The app's `tsconfig` sets `types: ["vite/client"]` — a browser bundle has no `node:fs`
// — so the platform this one test file needs is pulled in per file rather than added to
// what every other file typechecks against. `process` is imported for the same reason:
// nothing here should depend on a global that only exists under the test runner.
/// <reference types="node" />
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import type {
  DeckAgentDeckSnapshot,
  DeckAgentRequestMessage,
  DeckAgentToolCall,
  DeckAgentTranscriptEntry,
} from "./agent";
import { buildAgentMessages, toDeckSnapshot } from "./agent";
import type { DeckCardEntry } from "./deck";

/**
 * The browser half of the cross-side seam check.
 *
 * Three defects in the replay work lived only between this side and the backend's
 * request contract: a payload bound the two sides disagreed about, a call id this side
 * could emit twice that the backend now refuses, and the fix for that id which shed a
 * whole turn. Every one of them shipped green, because this side's tests validated its
 * own output against its own assumptions and the backend's validated its own input
 * against its own — and nothing anywhere fed one to the other.
 *
 * So this file writes what `buildAgentMessages` really produces to
 * `contracts/replay-seam/`, and `backend/tests/test_replay_seam.py` validates those same
 * files with `DeckAgentChatRequest.model_validate`. The files on disk are the contract:
 * neither side imports the other, neither restates the other's bounds, and a change to
 * the request shape fails here until the corpus is regenerated deliberately.
 *
 * The corpus sits outside both `frontend/` and `backend/` because neither owns it. It is
 * committed, so a `pytest` run needs no build step on this side — a check that only runs
 * when someone remembers to run it is not a check.
 *
 * What this file asserts is what the browser *emitted*: exact lengths, byte-for-byte
 * text, message counts. The pairing and role rules are deliberately **not** restated
 * here; they belong to the backend, and asserting them on both sides would rebuild the
 * duplicate-assumption problem the corpus exists to remove.
 */

/**
 * The repository both halves of the seam live in, found by looking for both of them.
 *
 * Walked up from the working directory rather than derived from this file's own URL:
 * under a jsdom environment `import.meta.url` is not a `file:` URL, so the usual
 * `fileURLToPath` spelling throws. Anchored on the two directory names because that is
 * exactly what makes a directory the root of this repository — and it holds whether the
 * suite is run from `frontend/` or from the root.
 */
function repositoryRoot(): string {
  let directory = process.cwd();
  while (
    !existsSync(join(directory, "backend")) ||
    !existsSync(join(directory, "frontend"))
  ) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`no repository root above ${process.cwd()}`);
    }
    directory = parent;
  }
  return directory;
}

/** Where the corpus lives: `<repo>/contracts/replay-seam/`. */
const CORPUS_DIR = join(repositoryRoot(), "contracts", "replay-seam");

/** Set `UPDATE_FIXTURES=1` to rewrite the corpus from the current code. */
const UPDATING = process.env.UPDATE_FIXTURES === "1";

/** The one-liner every failure below names, so nobody has to find it. */
const REGENERATE =
  "cd frontend && UPDATE_FIXTURES=1 npm test -- --run src/domain/replaySeam.test.ts";

/** One tool line as a turn stores it: replayable, with its id and both payloads. */
function storedCall(overrides: Partial<DeckAgentToolCall> = {}): DeckAgentToolCall {
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

/** One turn that finished, whose prose is the answer written from its calls. */
function answered(
  content: string,
  calls: DeckAgentToolCall[] = [],
): DeckAgentTranscriptEntry {
  return {
    message: { role: "assistant", content },
    cardLinks: [],
    toolCalls: calls,
  };
}

/** One question, as the panel appends it before sending. */
function asked(content: string): DeckAgentTranscriptEntry {
  return { message: { role: "user", content }, toolCalls: [], cardLinks: [] };
}

/**
 * A `read_deck` result of an exact length, in the shape a real one has.
 *
 * Repeating one deck line rather than one character, so a reviewer opening a 24,000-char
 * fixture can see what it is meant to be.
 */
function listing(length: number): string {
  const line = "1 Sol Ring {1} Artifact\n";
  return line.repeat(Math.ceil(length / line.length)).slice(0, length);
}

/** A 250-char stored id — the longest the backend's `ToolCallId` would take whole. */
const LONG_STORED_ID = `call-${"9".repeat(245)}`;

/** One deck entry with a real Scryfall id, because the snapshot's field is a `UUID`. */
const solRingEntry: DeckCardEntry = {
  card: {
    oracle_id: "9c0f7a44-0a29-4b3f-9a2f-6a8a6b1c3d55",
    scryfall_id: "b6ff7a89-c1f1-4a53-a8c1-7e3d3a0f2f11",
    name: "Sol Ring",
  },
  quantity: 1,
  section: "command_zone",
};

/** One case of the corpus: a transcript, and what its fixture file is evidence of. */
interface SeamCase {
  /** The fixture's file name, and the id the backend's parametrised test reports. */
  name: string;
  /** Which real defect this shape is the fingerprint of. */
  fingerprints: string;
  entries: DeckAgentTranscriptEntry[];
  /** Posted alongside the messages, for the cases where the deck is part of the shape. */
  deck?: DeckAgentDeckSnapshot;
}

const CASES: SeamCase[] = [
  {
    name: "answered-conversation",
    fingerprints:
      "The negative control. Every turn here was answered, so its prose already says " +
      "what its tools found and nothing is replayed: the request must be plain " +
      "{role, content} throughout, with no tool_calls and no tool_call_id anywhere — " +
      "even though the answered turn stored a call id and a result.",
    entries: [
      asked("What am I missing?"),
      answered("You are light on ramp.", [storedCall({ id: "call-1" })]),
      asked("And the curve?"),
    ],
  },
  {
    name: "reused-call-id-across-two-interrupted-turns",
    fingerprints:
      "Defect 2. A provider numbering its call ids per completion hands every " +
      "interrupted turn the same 'call-1', and the backend matches ids across the whole " +
      "request — so posting the stored id would have made the second cancel in a " +
      "conversation 422 every later turn in that deck. The posted ids must differ.",
    entries: [
      asked("What am I missing?"),
      interrupted("Reading the deck first", [storedCall({ id: "call-1" })]),
      asked("Carry on."),
      interrupted("Looking that up", [
        storedCall({
          id: "call-1",
          name: "search_web",
          signature: "search_web(budget edh ramp)",
          arguments_json: '{"query":"budget edh ramp"}',
          result: "Three articles on budget ramp.",
        }),
      ]),
      asked("And now?"),
    ],
  },
  {
    name: "reused-call-id-within-one-turn",
    fingerprints:
      "The second collision axis: one interrupted turn whose store holds the same id " +
      "twice. A turn-level namespace alone would post both calls under one id, which is " +
      "the same 422 as defect 2 from inside a single turn.",
    entries: [
      asked("What am I missing?"),
      interrupted("Two lookups in", [
        storedCall({ id: "call-1" }),
        storedCall({
          id: "call-1",
          name: "see_cards",
          signature: "see_cards(Sol Ring · rules)",
          arguments_json: '{"cards":["Sol Ring"]}',
          result: "Sol Ring — {1}, Artifact",
        }),
      ]),
      asked("Carry on."),
    ],
  },
  {
    name: "result-at-the-payload-bound",
    fingerprints:
      "Defect 1. A 24,000-char replayed result — exactly what the backend's " +
      "MAX_TOOL_PAYLOAD_CHARS allows a reply to carry out. It must travel back whole: " +
      "holding it to the prose bound instead truncated it to 8,000 and made the largest " +
      "decks the ones a replay silently loses two thirds of.",
    entries: [
      asked("List the deck."),
      interrupted("", [storedCall({ result: listing(24_000) })]),
      asked("Carry on."),
    ],
  },
  {
    name: "result-over-the-payload-bound",
    fingerprints:
      "The other side of defect 1: a 30,000-char result, longer than the wire takes. It " +
      "is truncated to the bound with a visible marker rather than posted whole (a 422 " +
      "that fails the turn) or cut silently (a payload that lies about being complete).",
    entries: [
      asked("List the deck."),
      interrupted("", [storedCall({ result: listing(30_000) })]),
      asked("Carry on."),
    ],
  },
  {
    name: "result-keeps-its-whitespace",
    fingerprints:
      "A result with leading and trailing whitespace, which must travel byte for byte: " +
      "the model has to read back exactly what it read the first time, so a tool " +
      "message is exempt from the stripping and the non-blank rule prose keeps. Carries " +
      "the deck snapshot and the call's deck_revision too, because that comparison is " +
      "the other half of this seam and its UUID field is the other half of this shape.",
    entries: [
      asked("List the deck."),
      interrupted("", [
        storedCall({
          result: "\n  Deck listing\n",
          deckRevision: "2026-08-03T09:00:00.000Z",
        }),
      ]),
      asked("Carry on."),
    ],
    deck: toDeckSnapshot(
      "Gruul Stompy",
      [solRingEntry],
      "2026-08-03T09:00:00.000Z",
    ),
  },
  {
    name: "shed-payload-framed-not-posted",
    fingerprints:
      "A call whose payload the storage budget shed. It has no result, so it must be " +
      "framed in prose rather than posted as a call: an unanswered tool_calls entry is " +
      "a 422 that fails the whole turn instead of degrading it. Its sibling, which kept " +
      "its result, still replays.",
    entries: [
      asked("What am I missing?"),
      interrupted("Halfway through", [
        storedCall({ id: "call-a" }),
        storedCall({
          id: "call-b",
          name: "search_web",
          signature: "search_web(budget edh ramp)",
          arguments_json: null,
          result: null,
        }),
      ]),
      asked("Carry on."),
    ],
  },
  {
    name: "long-stored-call-id",
    fingerprints:
      "A 250-char stored id, held twice in one turn. The posted form must keep the " +
      "prefix that carries the uniqueness and truncate the tail: dropping the prefix " +
      "instead posts both calls under one id, and truncating nothing posts 255 " +
      "characters into a 200-char ToolCallId.",
    entries: [
      asked("What am I missing?"),
      interrupted("Two lookups in", [
        storedCall({ id: LONG_STORED_ID }),
        storedCall({
          id: LONG_STORED_ID,
          name: "see_cards",
          signature: "see_cards(Sol Ring · rules)",
          arguments_json: '{"cards":["Sol Ring"]}',
          result: "Sol Ring — {1}, Artifact",
        }),
      ]),
      asked("Carry on."),
    ],
  },
  {
    name: "message-ceiling",
    fingerprints:
      "The ceiling: twenty interrupted turns of fifty calls each, plus a question. One " +
      "interrupted turn expands to fifty-one messages, so the request has to be " +
      "budgeted by message count as well as by characters — the backend takes 1,000 " +
      "messages and exceeding it is not a shorter request, it is a 422 that fails every " +
      "turn in this deck until the transcript is cleared. The oldest turn falls back to " +
      "framing so the rest keep their replay.",
    entries: [
      ...Array.from({ length: 20 }, (_, turn) => [
        asked(`Question ${turn}`),
        interrupted(
          "",
          Array.from({ length: 50 }, (_, position) =>
            storedCall({
              id: `call-${position}`,
              name: "see_cards",
              signature: `see_cards(card ${position})`,
              arguments_json: `{"cards":["C${position}"]}`,
              result: `C${position} — {1}, Artifact`,
            }),
          ),
        ),
      ]).flat(),
      asked("Carry on."),
    ],
  },
  {
    name: "message-floor-overflow",
    fingerprints:
      "The floor: 1,201 answered entries, which post one message each and so overflow " +
      "the ceiling before any replay is even considered. The oldest are left out " +
      "entirely — which is what the backend's own history window would have done to " +
      "them — and exactly 1,000 remain, ending with the user's question.",
    entries: [
      asked("Question 0"),
      ...Array.from({ length: 600 }, (_, index) => [
        answered(`Answer ${index}`),
        asked(`Question ${index + 1}`),
      ]).flat(),
    ],
  },
];

/** One fixture file, as it sits on disk. */
interface SeamFixture {
  case: string;
  fingerprints: string;
  /** The headline number, so a diff says what changed before it says how. */
  message_count: number;
  request: {
    messages: DeckAgentRequestMessage[];
    deck?: DeckAgentDeckSnapshot;
  };
}

function build(seam: SeamCase): SeamFixture {
  const messages = buildAgentMessages(seam.entries);
  return {
    case: seam.name,
    fingerprints: seam.fingerprints,
    message_count: messages.length,
    request: { messages, ...(seam.deck ? { deck: seam.deck } : {}) },
  };
}

/** Pretty-printed and newline-terminated, so a regeneration diffs as a review. */
function render(fixture: SeamFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function fixturePath(name: string): string {
  return join(CORPUS_DIR, `${name}.json`);
}

describe("the replay seam corpus", () => {
  for (const seam of CASES) {
    it(`matches what the browser posts for ${seam.name}`, () => {
      const expected = render(build(seam));
      if (UPDATING) {
        mkdirSync(CORPUS_DIR, { recursive: true });
        writeFileSync(fixturePath(seam.name), expected, "utf8");
      }
      let onDisk: string;
      try {
        onDisk = readFileSync(fixturePath(seam.name), "utf8");
      } catch {
        onDisk = "";
      }
      expect(
        onDisk,
        `contracts/replay-seam/${seam.name}.json is missing or stale. The backend ` +
          `validates that file, so regenerate it deliberately and read the diff:\n  ` +
          REGENERATE,
      ).toBe(expected);
    });
  }

  it("holds exactly the cases this file builds, and no rotted leftovers", () => {
    const wanted = CASES.map((seam) => `${seam.name}.json`).sort();
    if (UPDATING) {
      mkdirSync(CORPUS_DIR, { recursive: true });
      for (const found of readdirSync(CORPUS_DIR)) {
        if (found.endsWith(".json") && !wanted.includes(found)) {
          rmSync(join(CORPUS_DIR, found));
        }
      }
    }
    // Read defensively rather than letting an `ENOENT` stand in for the message: a
    // corpus that is not there at all is the same fault as one that is out of date, and
    // it has the same one-line fix.
    const found = (existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR) : [])
      .filter((entry) => entry.endsWith(".json"))
      .sort();

    // A file nobody builds any more is worse than a missing one: the backend keeps
    // validating it and reports the seam as covered by a shape this side stopped
    // producing.
    expect(
      found,
      `contracts/replay-seam/ does not hold the cases this file builds. Regenerate:\n  ${REGENERATE}`,
    ).toEqual(wanted);
  });
});

describe("what the corpus is evidence of", () => {
  /**
   * The properties each fixture exists to carry, asserted on the built request rather
   * than on the file, so a regeneration cannot quietly bless a corpus that no longer
   * fingerprints its defect. Only what the browser emitted — the pairing and role rules
   * are the backend's, and restating them here would rebuild the duplicated assumption
   * this whole check exists to remove.
   */
  function built(name: string): SeamFixture {
    const seam = CASES.find((candidate) => candidate.name === name);
    if (!seam) {
      throw new Error(`no such case: ${name}`);
    }
    return build(seam);
  }

  it("posts an answered conversation as prose and nothing else", () => {
    const { request } = built("answered-conversation");

    expect(request.messages).toEqual([
      { role: "user", content: "What am I missing?" },
      { role: "assistant", content: "You are light on ramp." },
      { role: "user", content: "And the curve?" },
    ]);
  });

  it("gives two interrupted turns' identical stored ids two posted ones", () => {
    const { request } = built("reused-call-id-across-two-interrupted-turns");
    const posted = request.messages.flatMap(
      (message) => message.tool_calls?.map((call) => call.id) ?? [],
    );

    expect(posted).toEqual(["t1c0:call-1", "t3c0:call-1"]);
    expect(new Set(posted).size).toBe(posted.length);
  });

  it("gives one turn's two identical stored ids two posted ones", () => {
    const { request } = built("reused-call-id-within-one-turn");
    const posted = request.messages[1].tool_calls?.map((call) => call.id) ?? [];

    expect(posted).toEqual(["t1c0:call-1", "t1c1:call-1"]);
  });

  it("posts a result at the payload bound whole", () => {
    const { request } = built("result-at-the-payload-bound");
    const result = request.messages.find((message) => message.role === "tool");

    expect(result?.content).toHaveLength(24_000);
    expect(result?.content).not.toContain("truncated");
  });

  it("truncates a result past the payload bound to the bound, saying so", () => {
    const { request } = built("result-over-the-payload-bound");
    const result = request.messages.find((message) => message.role === "tool");

    expect(result?.content).toHaveLength(24_000);
    expect(result?.content).toContain("… truncated, 6,000 characters more");
  });

  it("posts a result's leading and trailing whitespace byte for byte", () => {
    const { request } = built("result-keeps-its-whitespace");
    const result = request.messages.find((message) => message.role === "tool");

    expect(result?.content).toBe("\n  Deck listing\n");
    expect(request.messages[1].tool_calls?.[0].deck_revision).toBe(
      "2026-08-03T09:00:00.000Z",
    );
    expect(request.deck?.updated_at).toBe("2026-08-03T09:00:00.000Z");
  });

  it("frames the shed call and posts only the one that kept its result", () => {
    const { request } = built("shed-payload-framed-not-posted");

    expect(request.messages[1].tool_calls?.map((call) => call.id)).toEqual([
      "t1c0:call-a",
    ]);
    expect(request.messages[3]).toEqual({
      role: "assistant",
      content: "interrupted after search_web(budget edh ramp)\n\nHalfway through",
    });
    // The shed call is absent under every spelling, not merely unanswered.
    expect(JSON.stringify(request.messages)).not.toContain("call-b");
  });

  it("keeps a 250-char id's posted prefix and truncates its tail", () => {
    const { request } = built("long-stored-call-id");
    const posted = request.messages[1].tool_calls?.map((call) => call.id) ?? [];

    expect(posted[0]).toBe(`t1c0:${LONG_STORED_ID.slice(0, 195)}`);
    expect(posted[1]).toBe(`t1c1:${LONG_STORED_ID.slice(0, 195)}`);
    expect(posted[0]).toHaveLength(200);
    expect(new Set(posted).size).toBe(2);
  });

  it("stays inside the message ceiling, framing the turn that will not fit", () => {
    const { request } = built("message-ceiling");
    const replayed = request.messages.filter(
      (message) => (message.tool_calls?.length ?? 0) > 0,
    );

    expect(request.messages.length).toBeLessThanOrEqual(1_000);
    expect(request.messages).toHaveLength(991);
    // Nineteen of the twenty turns replay; the oldest falls back to framing so the
    // nineteen the next question follows on from keep theirs.
    expect(replayed).toHaveLength(19);
    expect(request.messages[1]).toEqual({
      role: "assistant",
      content: expect.stringContaining("interrupted after see_cards(card 0)"),
    });
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: "Carry on.",
    });
  });

  it("sheds the oldest entries when the floor alone overflows", () => {
    const { request } = built("message-floor-overflow");

    expect(request.messages).toHaveLength(1_000);
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: "Question 600",
    });
    // The oldest 201 entries are out of the request entirely, which is what the
    // backend's own history window would have done to them.
    expect(request.messages[0]).toEqual({
      role: "assistant",
      content: "Answer 100",
    });
  });
});
