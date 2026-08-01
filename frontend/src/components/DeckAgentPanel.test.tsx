import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import type {
  DeckAgentCardLink,
  DeckAgentChatReply,
  DeckAgentMessage,
  DeckAgentToolCall,
} from "../domain/agent";
import {
  ApiError,
  type ApiClient,
  type DeckAgentStreamHandlers,
} from "../lib/api";
import { DeckAgentPanel } from "./DeckAgentPanel";

/**
 * A client whose streamed turn resolves straight to its finished reply.
 *
 * Most tests care about what a completed turn leaves behind, not about the
 * progress on the way there, so this emits nothing and simply answers. Arguments
 * land in the same order the real client takes them:
 * `(messages, deck, handlers, signal, debug)`.
 */
function client(
  streamDeckAgentChat?: ApiClient["streamDeckAgentChat"],
): ApiClient {
  return {
    getHealth: vi.fn(),
    searchCards: vi.fn(),
    streamDeckAgentChat,
  } as unknown as ApiClient;
}

/** A turn the test drives: emit progress, then finish it. */
function drivenStream() {
  let handlers: DeckAgentStreamHandlers | null = null;
  let settle: ((reply: DeckAgentChatReply) => void) | null = null;
  const chat = vi.fn().mockImplementation(
    (
      _messages: DeckAgentMessage[],
      _deck: unknown,
      given: DeckAgentStreamHandlers,
    ) => {
      handlers = given;
      return new Promise<DeckAgentChatReply>((resolve) => {
        settle = resolve;
      });
    },
  );
  return {
    chat,
    async text(chunk: string) {
      await act(async () => handlers?.onText(chunk));
    },
    async tool(call: DeckAgentToolCall) {
      await act(async () => handlers?.onToolCall(call));
    },
    async finish(reply: DeckAgentChatReply) {
      await act(async () => settle?.(reply));
    },
  };
}

function reply(
  content: string,
  cost: number | null = 0.0012,
  toolCalls: DeckAgentToolCall[] = [],
  unpricedCalls = 0,
  cardLinks: DeckAgentCardLink[] = [],
): DeckAgentChatReply {
  return {
    message: { role: "assistant", content },
    model: "openai/gpt-5.6-luna",
    replayed_message_count: 1,
    cost_usd: cost,
    unpriced_call_count: unpricedCalls,
    tool_calls: toolCalls,
    card_links: cardLinks,
  };
}

function toolCall(
  signature: string,
  overrides: Partial<DeckAgentToolCall> = {},
): DeckAgentToolCall {
  return {
    name: signature.split("(")[0],
    signature,
    ok: true,
    detail: null,
    arguments_json: null,
    result: null,
    ...overrides,
  };
}

// Conversations are saved per deck in the browser, so one test's transcript would
// otherwise be waiting for the next test that renders the same deck.
beforeEach(() => {
  window.localStorage.clear();
});

it("sends the message and shows the reply", async () => {
  const chat = vi.fn().mockResolvedValue(reply("Play Sol Ring."));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What ramp should I run?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));

  expect(await screen.findByText("Play Sol Ring.")).toBeInTheDocument();
  expect(screen.getByText("What ramp should I run?")).toBeInTheDocument();
  const sent = chat.mock.calls[0][0] as DeckAgentMessage[];
  expect(sent).toEqual([{ role: "user", content: "What ramp should I run?" }]);
  // The composer empties so the same question cannot be sent twice by accident.
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("");
});

it("remembers the conversation by replaying it on the next turn", async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce(reply("Sol Ring."))
    .mockResolvedValueOnce(reply("Then Arcane Signet."));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);
  const composer = screen.getByLabelText("Message the deck agent");

  await userEvent.type(composer, "Best ramp?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");
  await userEvent.type(composer, "And after that?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Then Arcane Signet.");

  // The agent holds no session, so the whole transcript has to be posted back.
  expect(chat.mock.calls[1][0]).toEqual([
    { role: "user", content: "Best ramp?" },
    { role: "assistant", content: "Sol Ring." },
    { role: "user", content: "And after that?" },
  ]);
});

it("sends on Enter and adds a newline on Shift+Enter", async () => {
  const chat = vi.fn().mockResolvedValue(reply("Sol Ring."));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);
  const composer = screen.getByLabelText("Message the deck agent");

  await userEvent.type(composer, "first{Shift>}{Enter}{/Shift}second");
  expect(chat).not.toHaveBeenCalled();
  expect(composer).toHaveValue("first\nsecond");

  await userEvent.type(composer, "{Enter}");
  await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
  expect(chat.mock.calls[0][0]).toEqual([
    { role: "user", content: "first\nsecond" },
  ]);
});

it("keeps the failed question in the transcript and reports the error", async () => {
  const chat = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError("The deck agent is temporarily unavailable.", 503),
    )
    .mockResolvedValueOnce(reply("Sol Ring."));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Best ramp?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The deck agent is temporarily unavailable.",
  );
  expect(screen.getByText("Best ramp?")).toBeInTheDocument();

  // Sending again retries with the failed turn still in the conversation.
  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Try again",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(chat.mock.calls[1][0]).toEqual([
    { role: "user", content: "Best ramp?" },
    { role: "user", content: "Try again" },
  ]);
});

it("forgets the conversation when the chat is reset", async () => {
  const chat = vi.fn().mockResolvedValue(reply("Sol Ring."));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);
  const reset = screen.getByRole("button", { name: "Reset chat" });
  expect(reset).toBeDisabled();

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Best ramp?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");
  await userEvent.click(reset);

  expect(screen.queryByText("Sol Ring.")).not.toBeInTheDocument();
  expect(screen.queryByText("Best ramp?")).not.toBeInTheDocument();
  expect(reset).toBeDisabled();

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Starting over",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
  // A reset conversation must not smuggle the old turns back to the model.
  expect(chat.mock.calls[1][0]).toEqual([
    { role: "user", content: "Starting over" },
  ]);
});

it("shows a pending state and refuses a second concurrent send", async () => {
  let release: (value: DeckAgentChatReply) => void = () => {};
  const chat = vi.fn().mockImplementation(
    () =>
      new Promise<DeckAgentChatReply>((resolve) => {
        release = resolve;
      }),
  );
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Best ramp?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));

  expect(await screen.findByRole("status")).toHaveTextContent("Thinking…");
  expect(screen.getByLabelText("Send message")).toBeDisabled();

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Second question",
  );
  await userEvent.keyboard("{Enter}");
  expect(chat).toHaveBeenCalledTimes(1);

  release(reply("Sol Ring."));
  await screen.findByText("Sol Ring.");
  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
});

it("will not send a blank message", async () => {
  const chat = vi.fn();
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);

  await userEvent.type(screen.getByLabelText("Message the deck agent"), "   ");

  expect(screen.getByLabelText("Send message")).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(chat).not.toHaveBeenCalled();
});

it("renders nothing when the client cannot chat", () => {
  const { container } = render(<DeckAgentPanel deckId="deck-a" client={client(undefined)} />);

  expect(container).toBeEmptyDOMElement();
});

it("adds up what the conversation costs, only while debug mode is on", async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce(reply("Sol Ring.", 0.0012))
    .mockResolvedValueOnce(reply("Arcane Signet.", 0.0033));
  const { rerender } = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled={false} />,
  );
  const composer = screen.getByLabelText("Message the deck agent");

  await userEvent.type(composer, "Best ramp?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");
  // Off by default: a price the user did not ask to see stays hidden.
  expect(screen.queryByText("$0.0012")).not.toBeInTheDocument();

  rerender(<DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />);
  expect(screen.getByText("$0.0012")).toBeInTheDocument();

  await userEvent.type(composer, "And after that?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Arcane Signet.");
  expect(screen.getByText("$0.0045")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  // The spend belongs to the conversation, so resetting it clears the total.
  expect(screen.getByText("$0.0000")).toBeInTheDocument();
});

it("marks a total that is missing an unreported turn", async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce(reply("Sol Ring.", 0.002))
    .mockResolvedValueOnce(reply("Arcane Signet.", null));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />);
  const composer = screen.getByLabelText("Message the deck agent");

  await userEvent.type(composer, "Best ramp?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");
  await userEvent.type(composer, "And after that?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Arcane Signet.");

  // A turn the provider did not price must not silently read as free.
  expect(screen.getByText("$0.0020+")).toBeInTheDocument();
});

it("shows one line per tool the agent ran, above its answer", async () => {
  const chat = vi.fn().mockResolvedValue(
    reply("You are light on ramp.", 0.0009, [
      toolCall("read_deck()"),
      toolCall("see_cards(Sol Ring, Llanowar Elves · rules, prices)"),
    ]),
  );
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What am I missing?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("You are light on ramp.");

  // The user asked to see the tool name as a small line of text in the chat.
  expect(screen.getByText("read_deck()")).toBeInTheDocument();
  expect(
    screen.getByText("see_cards(Sol Ring, Llanowar Elves · rules, prices)"),
  ).toBeInTheDocument();
});

it("marks a tool call that failed without losing the answer", async () => {
  const chat = vi.fn().mockResolvedValue(
    reply("I could not read the deck.", 0.0009, [
      toolCall("read_deck()", { ok: false, detail: "catalog unavailable" }),
    ]),
  );
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What am I missing?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("I could not read the deck.");

  const line = screen.getByText("read_deck()").closest("p");
  expect(line).toHaveClass("deck-agent__tool--failed");
  expect(line).toHaveAttribute("title", "catalog unavailable");
});

it("posts the open deck so the tools can read it", async () => {
  const chat = vi.fn().mockResolvedValue(reply("Sol Ring."));
  const deck = {
    name: "Ghalta Stompy",
    cards: [
      {
        scryfall_id: "aaaaaaaa-2222-4222-8222-222222222222",
        quantity: 1,
        section: "mainboard" as const,
      },
    ],
  };
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} deck={deck} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What am I missing?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");

  // The backend holds no deck, so the snapshot travels with every turn.
  expect(chat.mock.calls[0][1]).toEqual(deck);
});

it("tool lines belong to their own turn and are cleared by a reset", async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce(reply("First.", 0.001, [toolCall("read_deck()")]))
    .mockResolvedValueOnce(reply("Second.", 0.001, []));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);
  const composer = screen.getByLabelText("Message the deck agent");

  await userEvent.type(composer, "One?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("First.");
  await userEvent.type(composer, "Two?");
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Second.");

  // The second turn used no tools, so the first turn's line must not follow it.
  expect(screen.getAllByText("read_deck()")).toHaveLength(1);

  await userEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  expect(screen.queryByText("read_deck()")).not.toBeInTheDocument();
});

it("counts every unpriced model call in a turn, not just the turn", async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce(reply("Sol Ring.", 0.002, [toolCall("read_deck()")], 1));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Best ramp?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");

  // A turn that used tools paid for several completions; one went unpriced, so the
  // total says it is incomplete rather than reading low.
  expect(screen.getByText("$0.0020+")).toBeInTheDocument();
});

it("keeps one conversation per deck and comes back to it", async () => {
  const chat = vi
    .fn()
    .mockResolvedValueOnce(reply("Ghalta wants ramp.", 0.0012))
    .mockResolvedValueOnce(reply("Atraxa wants counters.", 0.0034));
  const { rerender } = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What does this deck need?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Ghalta wants ramp.");
  expect(screen.getByText("$0.0012")).toBeInTheDocument();

  // Another deck starts empty rather than inheriting the first deck's questions.
  rerender(<DeckAgentPanel deckId="deck-b" client={client(chat)} debugEnabled />);
  expect(screen.queryByText("Ghalta wants ramp.")).not.toBeInTheDocument();
  expect(screen.queryByText("What does this deck need?")).not.toBeInTheDocument();
  expect(screen.getByText("$0.0000")).toBeInTheDocument();

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "And this one?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Atraxa wants counters.");
  // The second deck's turn is answered from its own transcript, not the first's.
  expect(chat.mock.calls[1][0]).toEqual([
    { role: "user", content: "And this one?" },
  ]);

  // Going back returns the whole conversation, spend included.
  rerender(<DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />);
  expect(screen.getByText("Ghalta wants ramp.")).toBeInTheDocument();
  expect(screen.queryByText("Atraxa wants counters.")).not.toBeInTheDocument();
  expect(screen.getByText("$0.0012")).toBeInTheDocument();
});

it("shows the answer as it is written, then commits it once", async () => {
  const stream = drivenStream();
  render(<DeckAgentPanel deckId="deck-a" client={client(stream.chat)} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Best ramp?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  expect(await screen.findByRole("status")).toHaveTextContent("Thinking…");

  await stream.text("Sol Ring, ");
  // Text on screen replaces "Thinking…": the turn is no longer silent.
  expect(screen.getByText(/Sol Ring,/)).toBeInTheDocument();
  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  await stream.text("then Arcane Signet.");
  expect(
    screen.getByText("Sol Ring, then Arcane Signet."),
  ).toBeInTheDocument();

  await stream.finish(reply("Sol Ring, then Arcane Signet."));
  // Exactly once: the streamed copy is replaced by the committed turn rather than
  // left behind next to it.
  expect(
    screen.getAllByText("Sol Ring, then Arcane Signet."),
  ).toHaveLength(1);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("shows a tool call while it runs and drops the preamble it interrupted", async () => {
  const stream = drivenStream();
  render(<DeckAgentPanel deckId="deck-a" client={client(stream.chat)} />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What am I missing?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));

  await stream.text("Let me look at your deck.");
  await stream.tool(toolCall("read_deck()"));
  // The call is on screen before the turn has finished — that is the whole point.
  expect(screen.getByText("read_deck()")).toBeInTheDocument();
  // And the text that preceded it was not the answer, so it does not survive as
  // one: the committed turn keeps only the final round's prose.
  expect(
    screen.queryByText("Let me look at your deck."),
  ).not.toBeInTheDocument();

  await stream.text("You are light on ramp.");
  await stream.finish(reply("You are light on ramp.", 0.0009, [toolCall("read_deck()")]));

  // One line and one answer, not two of either.
  expect(screen.getAllByText("read_deck()")).toHaveLength(1);
  expect(screen.getAllByText("You are light on ramp.")).toHaveLength(1);
});

it("abandons a half-streamed turn when the deck changes", async () => {
  const stream = drivenStream();
  const { rerender } = render(
    <DeckAgentPanel deckId="deck-a" client={client(stream.chat)} />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Deck A question",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await stream.text("Half an answer");
  expect(screen.getByText(/Half an answer/)).toBeInTheDocument();

  rerender(<DeckAgentPanel deckId="deck-b" client={client(stream.chat)} />);
  // Half an answer about another deck has no business showing here, and it is not
  // stored either — only a finished turn is.
  expect(screen.queryByText(/Half an answer/)).not.toBeInTheDocument();
  rerender(<DeckAgentPanel deckId="deck-a" client={client(stream.chat)} />);
  expect(screen.getByText("Deck A question")).toBeInTheDocument();
  expect(screen.queryByText(/Half an answer/)).not.toBeInTheDocument();
});

it("leaves an unsent question with the deck it is about", async () => {
  const chat = vi.fn().mockResolvedValue(reply("Sol Ring."));
  const { rerender, unmount } = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Should I cut a land?",
  );

  rerender(<DeckAgentPanel deckId="deck-b" client={client(chat)} />);
  // The half-written question does not follow the user to another deck.
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("");
  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What is this deck?",
  );

  rerender(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue(
    "Should I cut a land?",
  );

  // It is saved with the conversation, so a reload does not lose it either.
  unmount();
  const reloaded = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} />,
  );
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue(
    "Should I cut a land?",
  );

  // Sending clears only that deck's draft.
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("");
  reloaded.rerender(<DeckAgentPanel deckId="deck-b" client={client(chat)} />);
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue(
    "What is this deck?",
  );
});

it("resets one deck's conversation without touching another's", async () => {
  const chat = vi.fn().mockResolvedValue(reply("Sol Ring."));
  const { rerender } = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Deck A question",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");

  rerender(<DeckAgentPanel deckId="deck-b" client={client(chat)} />);
  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Deck B question",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Deck B question");
  await userEvent.click(screen.getByRole("button", { name: "Reset chat" }));
  expect(screen.queryByText("Deck B question")).not.toBeInTheDocument();

  rerender(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);
  expect(screen.getByText("Deck A question")).toBeInTheDocument();
});

it("reloads the conversation it saved in the browser", async () => {
  const chat = vi.fn().mockResolvedValue(
    reply("Sol Ring.", 0.0012, [toolCall("read_deck()")]),
  );
  const { unmount } = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Best ramp?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");
  unmount();

  // A fresh mount is what a reload looks like: the transcript, its tool lines and
  // its spend all come back from storage.
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />);
  expect(screen.getByText("Best ramp?")).toBeInTheDocument();
  expect(screen.getByText("Sol Ring.")).toBeInTheDocument();
  expect(screen.getByText("read_deck()")).toBeInTheDocument();
  expect(screen.getByText("$0.0012")).toBeInTheDocument();
});

it("abandons a reply when the deck changes rather than answering into it", async () => {
  let release: (value: DeckAgentChatReply) => void = () => {};
  const chat = vi.fn().mockImplementation(
    () =>
      new Promise<DeckAgentChatReply>((resolve) => {
        release = resolve;
      }),
  );
  const { rerender } = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Deck A question",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByRole("status");

  rerender(<DeckAgentPanel deckId="deck-b" client={client(chat)} />);
  // The pending state belonged to the deck that was left behind.
  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  // Resolved inside `act` so the reply is fully processed before absence is
  // asserted — an absence checked before the update lands proves nothing.
  await act(async () => {
    release(reply("Answer for deck A."));
  });
  expect(screen.queryByText("Answer for deck A.")).not.toBeInTheDocument();

  // Nor did it arrive in the deck it was asked about: the request was abandoned,
  // and the question is still there to send again.
  rerender(<DeckAgentPanel deckId="deck-a" client={client(chat)} />);
  expect(screen.getByText("Deck A question")).toBeInTheDocument();
  expect(screen.queryByText("Answer for deck A.")).not.toBeInTheDocument();
});

it("opens a tool call onto its arguments and its result, in debug mode", async () => {
  const chat = vi.fn().mockResolvedValue(
    reply("You have 30 Forests.", 0.0009, [
      toolCall("read_deck()", {
        arguments_json: "{}",
        result: 'Deck "Ghalta Stompy" — 35 cards.\n\nLand (30)\n  30x Forest',
      }),
    ]),
  );
  const { rerender } = render(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "How many lands?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("You have 30 Forests.");

  // The turn asked for the payloads, so the tool line is expandable.
  expect(chat.mock.calls[0][4]).toBe(true);
  const line = screen.getByText("read_deck()").closest("details");
  expect(line).toHaveClass("deck-agent__tool-call");
  expect(line).toContainElement(screen.getByText("Call"));
  expect(line).toContainElement(screen.getByText("Result"));
  expect(screen.getByText(/30x Forest/)).toBeInTheDocument();

  // Debug mode off is the plain line again: nothing to open, nothing to read.
  rerender(
    <DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled={false} />,
  );
  expect(screen.getByText("read_deck()").closest("details")).toBeNull();
  expect(screen.queryByText(/30x Forest/)).not.toBeInTheDocument();
});

it("marks an expandable tool call that failed and still shows what it returned", async () => {
  const chat = vi.fn().mockResolvedValue(
    reply("I could not read the deck.", 0.0009, [
      toolCall("read_deck()", {
        ok: false,
        detail: "catalog unavailable",
        arguments_json: "{}",
        result: "The local card catalog is unavailable, so the deck cannot be read.",
      }),
    ]),
  );
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What am I missing?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("I could not read the deck.");

  // A failed call is the one most worth opening, so it stays expandable and marked.
  const line = screen.getByText("read_deck()").closest("details");
  expect(line).toHaveClass("deck-agent__tool-call--failed");
  expect(line).toContainElement(screen.getByText("failed"));
  expect(
    screen.getByText(/The local card catalog is unavailable/),
  ).toBeInTheDocument();
});

it("leaves a tool call plain when the turn carried no payloads", async () => {
  const chat = vi
    .fn()
    .mockResolvedValue(reply("Sol Ring.", 0.0009, [toolCall("read_deck()")]));
  render(<DeckAgentPanel deckId="deck-a" client={client(chat)} debugEnabled />);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Best ramp?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Sol Ring.");

  // Debug mode is on, but this reply has nothing to show: an expander that opens
  // onto an empty box would claim the payload was empty rather than absent.
  expect(screen.getByText("read_deck()").closest("details")).toBeNull();
  expect(screen.getByText("read_deck()").closest("p")).toHaveClass(
    "deck-agent__tool",
  );
});
