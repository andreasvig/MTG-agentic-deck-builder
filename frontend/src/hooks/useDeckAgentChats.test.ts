import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { DeckAgentTranscriptEntry } from "../domain/agent";
import { useDeckAgentChats } from "./useDeckAgentChats";

beforeEach(() => {
  window.localStorage.clear();
});

function entry(
  role: "user" | "assistant",
  content: string,
): DeckAgentTranscriptEntry {
  return { message: { role, content }, toolCalls: [], cardLinks: [] };
}

describe("recordInterruptedTurn", () => {
  it("appends the turn and counts it as a call nobody priced", () => {
    const { result } = renderHook(() => useDeckAgentChats("deck-a"));

    act(() => {
      result.current.appendEntry("deck-a", entry("user", "what ramp?"));
      result.current.recordInterruptedTurn("deck-a", {
        ...entry("assistant", "Reading your deck"),
        interrupted: true,
      });
    });

    expect(
      result.current.chat.entries.map((held) => [
        held.message.content,
        held.interrupted,
      ]),
    ).toEqual([
      ["what ramp?", undefined],
      ["Reading your deck", true],
    ]);
    // The turn spent money — every tool round is a completion — and the figure for it
    // arrives on `done`, which a cancelled turn never sees. So the total says it is
    // incomplete rather than reading as though the turn were free.
    expect(result.current.chat.spentUsd).toBe(0);
    expect(result.current.chat.unpricedCalls).toBe(1);
  });

  it("is the other half of the cancel, so it never takes the question back", () => {
    const { result } = renderHook(() => useDeckAgentChats("deck-a"));

    act(() => {
      result.current.appendEntry("deck-a", entry("user", "what ramp?"));
      result.current.recordInterruptedTurn("deck-a", {
        ...entry("assistant", ""),
        interrupted: true,
      });
    });

    // A cancel either keeps what streamed or hands the question back, never both. And if
    // a caller did call both, the withdraw would decline on its own: the last entry is no
    // longer the question it was given. The exclusivity is belt as well as braces.
    act(() => result.current.withdrawQuestion("deck-a", "what ramp?"));
    expect(
      result.current.chat.entries.map((held) => held.message.role),
    ).toEqual(["user", "assistant"]);
  });
});

describe("withdrawQuestion", () => {
  /**
   * Its guard is not reachable from the panel — a turn's only appender is the reply
   * that finishes it, and finishing clears what a cancel would act on. So it is tested
   * here, against the contract it actually states, rather than through a UI race that
   * cannot currently happen. What it is protecting against is a caller, not a user.
   */
  it("takes back the question it was given, and only that", () => {
    const { result } = renderHook(() => useDeckAgentChats("deck-a"));

    act(() => {
      result.current.appendEntry("deck-a", entry("user", "what ramp?"));
      result.current.appendEntry("deck-a", entry("user", "waht rmap?"));
    });

    // Not the last entry because it is last: because it is the question named.
    act(() => result.current.withdrawQuestion("deck-a", "what ramp?"));
    expect(result.current.chat.entries).toHaveLength(2);

    act(() => result.current.withdrawQuestion("deck-a", "waht rmap?"));
    expect(
      result.current.chat.entries.map((held) => held.message.content),
    ).toEqual(["what ramp?"]);
  });

  it("declines to take back an answer, or anything from a deck with no chat", () => {
    const { result } = renderHook(() => useDeckAgentChats("deck-a"));

    act(() => {
      result.current.appendEntry("deck-a", entry("user", "what ramp?"));
      result.current.appendEntry("deck-a", entry("assistant", "Add {Sol Ring}."));
    });

    // An answer is never a question being taken back, whatever it says.
    act(() => result.current.withdrawQuestion("deck-a", "Add {Sol Ring}."));
    act(() => result.current.withdrawQuestion("deck-b", "what ramp?"));
    expect(
      result.current.chat.entries.map((held) => held.message.content),
    ).toEqual(["what ramp?", "Add {Sol Ring}."]);
  });
});
