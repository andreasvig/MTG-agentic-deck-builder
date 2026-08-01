import { Bot, ChevronDown, RotateCcw, SendHorizontal, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DeckAgentDeckSnapshot,
  DeckAgentMessage,
  DeckAgentToolCall,
} from "../domain/agent";
import { formatModelCostUsd } from "../domain/agent";
import type { CardSearchResult } from "../domain/card";
import { useDeckAgentChats } from "../hooks/useDeckAgentChats";
import { apiClient, type ApiClient } from "../lib/api";
import { AgentAnswer } from "./AgentAnswer";

/** The turn in progress: what has been read, and what has been written so far. */
interface LiveTurn {
  text: string;
  toolCalls: DeckAgentToolCall[];
}

const NO_LIVE_TURN: LiveTurn = { text: "", toolCalls: [] };

interface DeckAgentPanelProps {
  client?: ApiClient;
  debugEnabled?: boolean;
  /** Whose conversation this is. Each deck keeps its own, saved in the browser. */
  deckId: string;
  /** The open deck, read by the agent's tools. Absent when none is open. */
  deck?: DeckAgentDeckSnapshot | null;
  /** Open a card the answer named, in the same inspector the board uses. */
  onOpenCard?: (card: CardSearchResult) => void;
}

/**
 * The deck agent in the reserved right workspace.
 *
 * The transcript lives in the browser rather than on the server: the agent has no
 * session of its own, so every turn posts the whole conversation back and **Reset
 * chat** is simply forgetting it locally. It is kept per deck, so switching decks
 * switches conversation. The deck snapshot travels the same way, which is why the
 * agent's tools always read the deck as it is right now.
 *
 * A turn is streamed: each tool call shows the moment it runs, and the answer
 * appears as it is written. The stream is presentation only — the turn is committed
 * from the finished reply, so what is stored never depends on what was on screen.
 */
export function DeckAgentPanel({
  client = apiClient,
  debugEnabled = false,
  deckId,
  deck = null,
  onOpenCard,
}: DeckAgentPanelProps) {
  const { chat, appendEntry, recordReply, setDraft, clearChat } =
    useDeckAgentChats(deckId);
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState<LiveTurn>(NO_LIVE_TURN);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const entries = chat.entries;
  // The unsent question belongs to the deck it is about, so it waits in that
  // deck's chat rather than following the user to the next one.
  const draft = chat.draft;

  // Switching decks abandons a question already in flight rather than answering it
  // into a deck the user has left. The question itself stays in the transcript it
  // was asked in, so going back and sending again retries it.
  useEffect(() => {
    setPending(false);
    setLive(NO_LIVE_TURN);
    setError(null);
    return () => {
      pendingRequest.current?.abort();
      pendingRequest.current = null;
    };
  }, [deckId]);

  useEffect(() => {
    const element = transcript.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [entries, live, pending]);

  const resetChat = useCallback(() => {
    pendingRequest.current?.abort();
    pendingRequest.current = null;
    // The spend belongs to the conversation being reset, not to the session, so
    // dropping the conversation drops its total with it.
    clearChat(deckId);
    setPending(false);
    setLive(NO_LIVE_TURN);
    setError(null);
  }, [clearChat, deckId]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || pending || !client.streamDeckAgentChat) {
      return;
    }
    // The sent transcript has to include this turn, because the reply is answered
    // from the messages alone.
    const conversation: DeckAgentMessage[] = [
      ...entries.map((entry) => entry.message),
      { role: "user", content },
    ];
    // Captured for the whole turn: the answer belongs to the deck the question was
    // asked about, even if the request outlives the user's attention on it.
    const turnDeckId = deckId;
    const controller = new AbortController();
    pendingRequest.current = controller;
    appendEntry(turnDeckId, {
      message: { role: "user", content },
      toolCalls: [],
      cardLinks: [],
    });
    setDraft(turnDeckId, "");
    setPending(true);
    setLive(NO_LIVE_TURN);
    setError(null);
    try {
      const reply = await client.streamDeckAgentChat(
        conversation,
        deck,
        {
          onText: (chunk) => {
            setLive((current) => ({ ...current, text: current.text + chunk }));
          },
          onToolCall: (call) => {
            // Text written before a tool call was preamble, not the answer: the
            // committed turn keeps only the final round's prose, so the live view
            // drops it here and ends up showing exactly what gets stored.
            setLive((current) => ({
              text: "",
              toolCalls: [...current.toolCalls, call],
            }));
          },
        },
        controller.signal,
        debugEnabled,
      );
      if (controller.signal.aborted) {
        return;
      }
      // Counted rather than ignored, so a total that is missing a completion says
      // so instead of quietly reading low.
      const cost = typeof reply.cost_usd === "number" ? reply.cost_usd : null;
      const unpriced =
        typeof reply.unpriced_call_count === "number"
          ? reply.unpriced_call_count
          : 0;
      const missingWholeTurn = cost === null && unpriced === 0 ? 1 : 0;
      recordReply(turnDeckId, {
        entry: {
          message: reply.message,
          toolCalls: reply.tool_calls,
          cardLinks: reply.card_links,
        },
        costUsd: cost,
        unpricedCalls: unpriced + missingWholeTurn,
      });
    } catch (caught: unknown) {
      if (
        controller.signal.aborted ||
        (caught instanceof DOMException && caught.name === "AbortError")
      ) {
        return;
      }
      // The question stays in the transcript so it can be retried by sending
      // again, rather than being lost with the failure.
      setError(
        caught instanceof Error
          ? caught.message
          : "The deck agent is temporarily unavailable.",
      );
    } finally {
      if (pendingRequest.current === controller) {
        pendingRequest.current = null;
        setPending(false);
        // The turn is committed — or failed — so the live copy has served its
        // purpose. Leaving it would show the answer twice.
        setLive(NO_LIVE_TURN);
      }
    }
  }, [
    appendEntry,
    client,
    debugEnabled,
    deck,
    deckId,
    draft,
    entries,
    pending,
    recordReply,
    setDraft,
  ]);

  if (!client.streamDeckAgentChat) {
    return null;
  }

  return (
    <section className="deck-agent" aria-labelledby="deck-agent-heading">
      <header className="deck-agent__header">
        <h2 id="deck-agent-heading">
          <Bot aria-hidden="true" size={15} />
          Deck agent
        </h2>
        {debugEnabled ? (
          <span
            className="deck-agent__spend"
            title={
              chat.unpricedCalls > 0
                ? `${chat.unpricedCalls} model call(s) reported no cost`
                : "What this conversation has cost so far"
            }
          >
            {formatModelCostUsd(chat.spentUsd)}
            {chat.unpricedCalls > 0 ? "+" : ""}
          </span>
        ) : null}
        <button
          className="deck-agent__reset"
          type="button"
          disabled={entries.length === 0 && !error}
          onClick={resetChat}
        >
          <RotateCcw aria-hidden="true" size={13} />
          Reset chat
        </button>
      </header>

      <div
        className="deck-agent__transcript"
        ref={transcript}
        role="log"
        aria-label="Deck agent conversation"
        aria-live="polite"
      >
        {entries.length === 0 ? (
          <p className="deck-agent__empty">
            Ask about the deck you are building. The agent can read your deck and
            look cards up, but it cannot change anything.
          </p>
        ) : (
          entries.map((entry, index) => (
            <div key={`${index}-${entry.message.role}`}>
              {entry.toolCalls.map((call, callIndex) => (
                <ToolCallLine
                  call={call}
                  debugEnabled={debugEnabled}
                  key={`${callIndex}-${call.signature}`}
                />
              ))}
              <article
                className={`deck-agent__message deck-agent__message--${entry.message.role}`}
              >
                <span className="deck-agent__author">
                  {entry.message.role === "user" ? "You" : "Agent"}
                </span>
                <p>
                  {entry.message.role === "assistant" ? (
                    <AgentAnswer
                      text={entry.message.content}
                      links={entry.cardLinks}
                      client={client}
                      onOpenCard={onOpenCard}
                    />
                  ) : (
                    // The user's own words are never parsed: braces they typed are
                    // braces they meant.
                    entry.message.content
                  )}
                </p>
              </article>
            </div>
          ))
        )}
        {/*
          * The turn in progress, hidden from assistive technology: a live region
          * that announced every chunk would be unusable. The committed turn is
          * announced once, whole, the moment it lands.
          */}
        {live.toolCalls.length > 0 || live.text ? (
          <div aria-hidden="true">
            {live.toolCalls.map((call, callIndex) => (
              <ToolCallLine
                call={call}
                debugEnabled={debugEnabled}
                key={`live-${callIndex}-${call.signature}`}
              />
            ))}
            {live.text ? (
              <article className="deck-agent__message deck-agent__message--assistant">
                <span className="deck-agent__author">Agent</span>
                <p>
                  {/*
                    * Parsed with no links yet: nothing is resolved until the turn
                    * commits. The words are therefore identical to the committed
                    * ones — braces already gone — and only the ability to open a
                    * card arrives at the end.
                    */}
                  <AgentAnswer text={live.text} client={client} />
                  <span className="deck-agent__caret" />
                </p>
              </article>
            ) : null}
          </div>
        ) : null}
        {pending && !live.text ? (
          <p className="deck-agent__thinking" role="status">
            Thinking…
          </p>
        ) : null}
        {error ? (
          <p className="deck-agent__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <form
        className="deck-agent__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Message the deck agent"
          placeholder="Ask the deck agent"
          rows={2}
          maxLength={8_000}
          value={draft}
          onChange={(event) => setDraft(deckId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="deck-agent__send"
          type="submit"
          disabled={pending || draft.trim().length === 0}
          aria-label="Send message"
          title="Send message"
        >
          <SendHorizontal aria-hidden="true" size={16} />
        </button>
      </form>
    </section>
  );
}

/**
 * One tool the agent ran, above the answer it produced.
 *
 * A plain line by default. With debug mode on it opens onto what the model asked
 * for and the exact text it read back — the two things that explain an answer.
 * Turns that were sent with debug off carry no payload, so they stay plain lines
 * rather than opening onto nothing.
 */
function ToolCallLine({
  call,
  debugEnabled,
}: {
  call: DeckAgentToolCall;
  debugEnabled: boolean;
}) {
  const title = call.detail ?? "What the agent read to answer";
  const payloads: Array<[string, string, string]> = [];
  if (debugEnabled && call.arguments_json) {
    payloads.push([
      "Call",
      "arguments the model sent",
      prettyJson(call.arguments_json),
    ]);
  }
  if (debugEnabled && call.result) {
    payloads.push(["Result", "exact text returned to the agent", call.result]);
  }

  if (payloads.length === 0) {
    return (
      <p
        className={
          call.ok
            ? "deck-agent__tool"
            : "deck-agent__tool deck-agent__tool--failed"
        }
        title={title}
      >
        <Wrench aria-hidden="true" size={11} />
        <code className="deck-agent__tool-signature">{call.signature}</code>
        {call.ok ? null : <span> — failed</span>}
      </p>
    );
  }

  return (
    <details
      className={
        call.ok
          ? "deck-agent__tool-call"
          : "deck-agent__tool-call deck-agent__tool-call--failed"
      }
    >
      <summary title={title}>
        <Wrench aria-hidden="true" size={11} />
        <code className="deck-agent__tool-signature">{call.signature}</code>
        {call.ok ? null : <span>failed</span>}
        <ChevronDown aria-hidden="true" size={12} />
      </summary>
      <div className="deck-agent__tool-body">
        {payloads.map(([label, hint, text]) => (
          <details className="deck-agent__tool-payload" key={label} open>
            <summary>
              <strong>{label}</strong>
              <span>{hint}</span>
            </summary>
            <pre>{text}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

/** Indent JSON when it is JSON, and show it as it arrived when it is not. */
function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
