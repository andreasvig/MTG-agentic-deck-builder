import { useCallback, useEffect, useState } from "react";

import type {
  DeckAgentChat,
  DeckAgentChatsByDeck,
  DeckAgentTranscriptEntry,
} from "../domain/agent";
import {
  DECK_AGENT_CHAT_STORAGE_KEY,
  EMPTY_DECK_AGENT_CHAT,
  parseStoredAgentChats,
  serializeAgentChats,
} from "../domain/agent";

/** One answered turn: the message, and what the provider charged for it. */
interface RecordedReply {
  entry: DeckAgentTranscriptEntry;
  costUsd: number | null;
  unpricedCalls: number;
}

export interface DeckAgentChats {
  /** The conversation belonging to the deck this hook was called with. */
  chat: DeckAgentChat;
  appendEntry: (deckId: string, entry: DeckAgentTranscriptEntry) => void;
  recordReply: (deckId: string, reply: RecordedReply) => void;
  setDraft: (deckId: string, draft: string) => void;
  /** Take an unanswered question back out, by content. See the implementation. */
  withdrawQuestion: (deckId: string, content: string) => void;
  clearChat: (deckId: string) => void;
}

/**
 * One conversation per deck, kept in the browser beside the decks themselves.
 *
 * Switching decks switches chat: a question about one deck has no business
 * following the user to another, and coming back to a deck should come back to
 * what was already said about it. The whole store is held here rather than one
 * conversation at a time, so a reply that lands after a deck switch can still be
 * filed against the deck it was asked about.
 */
export function useDeckAgentChats(deckId: string): DeckAgentChats {
  const [chats, setChats] = useState<DeckAgentChatsByDeck>(loadStoredChats);

  useEffect(() => {
    try {
      getLocalStorage()?.setItem(
        DECK_AGENT_CHAT_STORAGE_KEY,
        serializeAgentChats(chats),
      );
    } catch {
      // The conversation stays usable when storage is disabled or full.
    }
  }, [chats]);

  // Every mutator takes its deck explicitly instead of closing over the active
  // one. That is what makes a reply arriving after a deck switch land in the right
  // transcript rather than in whichever deck happens to be on screen.
  const appendEntry = useCallback(
    (id: string, entry: DeckAgentTranscriptEntry) => {
      setChats((current) => withEntry(current, id, entry));
    },
    [],
  );

  const recordReply = useCallback(
    (id: string, { entry, costUsd, unpricedCalls }: RecordedReply) => {
      setChats((current) => {
        const appended = withEntry(current, id, entry);
        const chat = appended[id];
        return {
          ...appended,
          [id]: {
            ...chat,
            // An unpriced turn adds nothing to the total and is counted instead,
            // so the badge can say the total is incomplete.
            spentUsd: chat.spentUsd + (costUsd ?? 0),
            unpricedCalls: chat.unpricedCalls + unpricedCalls,
          },
        };
      });
    },
    [],
  );

  const setDraft = useCallback((id: string, draft: string) => {
    setChats((current) => {
      const chat = current[id] ?? EMPTY_DECK_AGENT_CHAT;
      if (chat.draft === draft) {
        return current;
      }
      // Typing counts as using this deck, so it keeps its place in the store.
      return {
        ...current,
        [id]: { ...chat, draft, updatedAt: new Date().toISOString() },
      };
    });
  }, []);

  /**
   * Take an unanswered question back out of the transcript.
   *
   * For a turn the user cancelled before it got anywhere: the question goes back to
   * the composer to be edited, and leaving a copy behind would put it in the
   * transcript *and* in the draft, so sending again would ask it twice.
   *
   * It removes the last entry only when that entry is the question it was given, which
   * is a contract rather than a race: today the panel clears what a cancel acts on
   * before any reply is written, so nothing reaches this holding the wrong question.
   * Named rather than positional so that stays true of the next caller.
   */
  const withdrawQuestion = useCallback((id: string, content: string) => {
    setChats((current) => {
      const chat = current[id];
      const last = chat?.entries.at(-1);
      if (!chat || !last || last.message.role !== "user") {
        return current;
      }
      if (last.message.content !== content) {
        return current;
      }
      return {
        ...current,
        [id]: {
          ...chat,
          entries: chat.entries.slice(0, -1),
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }, []);

  const clearChat = useCallback((id: string) => {
    setChats((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== id),
      ),
    );
  }, []);

  return {
    chat: chats[deckId] ?? EMPTY_DECK_AGENT_CHAT,
    appendEntry,
    recordReply,
    setDraft,
    withdrawQuestion,
    clearChat,
  };
}

function withEntry(
  chats: DeckAgentChatsByDeck,
  deckId: string,
  entry: DeckAgentTranscriptEntry,
): DeckAgentChatsByDeck {
  const chat = chats[deckId] ?? EMPTY_DECK_AGENT_CHAT;
  return {
    ...chats,
    [deckId]: {
      ...chat,
      entries: [...chat.entries, entry],
      updatedAt: new Date().toISOString(),
    },
  };
}

function loadStoredChats(): DeckAgentChatsByDeck {
  try {
    return parseStoredAgentChats(
      getLocalStorage()?.getItem(DECK_AGENT_CHAT_STORAGE_KEY) ?? null,
    );
  } catch {
    // Treat blocked or malformed browser storage as no saved conversations.
    return {};
  }
}

function getLocalStorage(): Storage | null {
  if (
    typeof window === "undefined" ||
    typeof window.localStorage?.getItem !== "function" ||
    typeof window.localStorage?.setItem !== "function"
  ) {
    return null;
  }
  return window.localStorage;
}
