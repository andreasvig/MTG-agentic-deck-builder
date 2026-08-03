import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import type {
  DeckAgentAppliedEdit,
  DeckAgentCardLink,
  DeckAgentChatReply,
  DeckAgentDeckEdit,
  DeckAgentDeckHistory,
  DeckAgentDeckSnapshot,
  DeckAgentMessage,
  DeckAgentRequestMessage,
  DeckAgentToolCall,
} from "../domain/agent";
import {
  DECK_AGENT_CHAT_STORAGE_KEY,
  parseStoredAgentChats,
} from "../domain/agent";
import {
  ApiError,
  type ApiClient,
  type DeckAgentStreamHandlers,
} from "../lib/api";
import { CARD_NAME_DRAG_TYPE } from "../domain/card";
import { dataTransfer, solRing } from "../test/fixtures";
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
    async deckEdit(edit: DeckAgentDeckEdit) {
      await act(async () => handlers?.onDeckEdit?.(edit));
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

/** One resolved swap: two rocks in, the two weakest pieces of ramp out. */
function deckEdit(overrides: Partial<DeckAgentDeckEdit> = {}): DeckAgentDeckEdit {
  const arcaneSignet = {
    ...solRing,
    oracle_id: "oracle-arcane-signet",
    scryfall_id: "printing-arcane-signet",
    name: "Arcane Signet",
  };
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
        scryfall_id: arcaneSignet.scryfall_id,
        name: arcaneSignet.name,
        quantity: 1,
        previous_quantity: 0,
        card: arcaneSignet,
      },
      {
        scryfall_id: "printing-wayfarers-bauble",
        name: "Wayfarer's Bauble",
        quantity: 0,
        previous_quantity: 1,
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

/**
 * What the deck did with `deckEdit()`, as the deck itself would report it.
 *
 * The panel writes its block from this and never from the event, so a test that drives the
 * event has to supply the answer too — the same way the real deck answers with the diff it
 * derived and the id of the entry it recorded.
 */
function appliedSwap(editId = "edit-1"): DeckAgentAppliedEdit {
  return {
    reason: "Swapping in two rocks for the weakest ramp.",
    addedCopies: 2,
    removedCopies: 2,
    added: ["Sol Ring", "Arcane Signet"],
    removed: ["Wayfarer's Bauble", "Rampant Growth"],
    moved: [],
    editId,
  };
}

it("drops an edit that arrives after the user has switched decks", async () => {
  const stream = drivenStream();
  const onDeckEdit = vi.fn().mockReturnValue(appliedSwap());
  const { rerender } = render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={onDeckEdit}
      onUndoDeckEdit={vi.fn()}
      undoableEditId="edit-1"
    />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Fix my ramp",
  );
  await userEvent.click(screen.getByLabelText("Send message"));

  // The user moves to another deck while the turn is still open. Switching aborts the
  // request, and a spec-compliant fetch then errors the body, so in the real client this
  // frame never arrives — but the panel must not depend on that. What it would cost is an
  // agent edit applied to the deck the user is now looking at and written into that deck's
  // history as though they had asked for it.
  rerender(
    <DeckAgentPanel
      deckId="deck-b"
      client={client(stream.chat)}
      onDeckEdit={onDeckEdit}
      onUndoDeckEdit={vi.fn()}
      undoableEditId="edit-1"
    />,
  );

  await stream.deckEdit(deckEdit());

  expect(onDeckEdit).not.toHaveBeenCalled();
  expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
  expect(screen.queryByText("Not applied")).not.toBeInTheDocument();
});

it("hands a streamed deck edit to the deck and says what it applied", async () => {
  const stream = drivenStream();
  const onDeckEdit = vi.fn().mockReturnValue(appliedSwap());
  const { unmount } = render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={onDeckEdit}
      onUndoDeckEdit={vi.fn()}
      undoableEditId="edit-1"
    />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Fix my ramp",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await stream.text("Swapping in two rocks for the weakest ramp.");
  await stream.deckEdit(deckEdit());

  // The panel does not change the deck itself — it hands the resolved edit outward,
  // exactly as it hands a card name to the inspector.
  expect(onDeckEdit).toHaveBeenCalledTimes(1);
  expect(onDeckEdit).toHaveBeenCalledWith(deckEdit());
  // And it is on screen the moment the deck has it, in the past tense: the change has
  // already happened, so there is nothing here to confirm.
  expect(screen.getByText("Applied: +2 / −2")).toBeInTheDocument();

  await stream.finish(reply("Swapping in two rocks for the weakest ramp."));

  // Once, not twice: the streamed block is replaced by the committed one rather than
  // left beside it.
  expect(screen.getAllByText("Applied: +2 / −2")).toHaveLength(1);
  expect(screen.getByText("+ Sol Ring, Arcane Signet")).toBeInTheDocument();
  expect(
    screen.getByText("− Wayfarer's Bauble, Rampant Growth"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();

  // It belongs to the turn, so it comes back with the turn after a reload — and with its
  // Undo, because the entry it names is still the deck's newest recorded change.
  unmount();
  render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={onDeckEdit}
      onUndoDeckEdit={vi.fn()}
      undoableEditId="edit-1"
    />,
  );
  expect(screen.getByText("Applied: +2 / −2")).toBeInTheDocument();
  expect(screen.getByText("+ Sol Ring, Arcane Signet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
});

/** The sentence the deck itself produces for an illegal second commander. */
const refusal =
  "Counterspell cannot share the command zone with Ghalta, Primal Hunger. " +
  "A second commander needs a legal Partner, Partner with, Friends forever, " +
  "Choose a Background, or Doctor's companion pairing.";

/**
 * A refusal as the deck reports one: its own sentence, no card named, no entry recorded.
 *
 * Written out rather than built by `refusedDeckEdit`, because this is the durable encoding
 * the stored transcript has to read back as a refusal — the shape is the assertion.
 */
const refusedBlock: DeckAgentAppliedEdit = {
  reason: refusal,
  addedCopies: 0,
  removedCopies: 0,
  added: [],
  removed: [],
  moved: [],
};

it("records an edit the deck refused as refused, and offers no undo for it", async () => {
  const stream = drivenStream();
  const onDeckEdit = vi.fn().mockReturnValue(refusedBlock);
  const { unmount } = render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={onDeckEdit}
      onUndoDeckEdit={vi.fn()}
    />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Make Counterspell my commander",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await stream.deckEdit(deckEdit());

  // The deck turned the edit down, so the block says so — while it streams and after it
  // commits, because the two must show the same thing.
  expect(screen.getByText("Not applied")).toBeInTheDocument();
  expect(screen.getByText(refusal)).toBeInTheDocument();
  expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();

  await stream.finish(reply("Counterspell cannot be your commander."));

  expect(screen.getAllByText("Not applied")).toHaveLength(1);
  expect(screen.getByText(refusal)).toBeInTheDocument();
  // Nothing about the proposed edit survives as a claim: no counts, no card lines.
  expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/^\+ /)).not.toBeInTheDocument();
  expect(screen.queryByText(/^− /)).not.toBeInTheDocument();
  // And no Undo. There is nothing recorded to reverse, so a button offering to reverse
  // this would reverse somebody else's edit.
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();

  // It is the durable record, so it has to still read as a refusal after a reload —
  // where anything the stored transcript cannot carry would come back as an edit.
  unmount();
  render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={onDeckEdit}
      onUndoDeckEdit={vi.fn()}
    />,
  );
  expect(screen.getByText("Not applied")).toBeInTheDocument();
  expect(screen.getByText(refusal)).toBeInTheDocument();
  expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
});

it("keeps the undo on the edit the deck took when a later one is refused", async () => {
  const stream = drivenStream();
  const onUndoDeckEdit = vi.fn();
  const onDeckEdit = vi
    .fn()
    .mockReturnValueOnce(appliedSwap())
    .mockReturnValueOnce(refusedBlock);
  render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={onDeckEdit}
      onUndoDeckEdit={onUndoDeckEdit}
      // The first edit is still the deck's newest recorded change: the refusal that came
      // after it recorded nothing, so it cannot have taken the affordance.
      undoableEditId="edit-1"
    />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Fix my ramp, then make Counterspell my commander",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await stream.deckEdit(deckEdit());
  await stream.deckEdit(
    deckEdit({
      reason: "Counterspell as a second commander.",
      changes: [
        {
          scryfall_id: "printing-counterspell",
          name: "Counterspell",
          quantity: 1,
          previous_quantity: 0,
        },
      ],
    }),
  );
  await stream.finish(reply("One of those two worked."));

  // The deck's last recorded change is the first edit, and that is the block the Undo
  // belongs to: the refusal recorded nothing, so it cannot hold the affordance.
  expect(screen.getByText("Applied: +2 / −2")).toBeInTheDocument();
  expect(screen.getByText("Not applied")).toBeInTheDocument();
  const undo = screen.getAllByRole("button", { name: "Undo" });
  expect(undo).toHaveLength(1);
  expect(
    screen.getByText("Applied: +2 / −2").closest(".deck-agent__edit"),
  ).toContainElement(undo[0]);
  expect(
    screen.getByText("Not applied").closest(".deck-agent__edit"),
  ).not.toContainElement(undo[0]);

  await userEvent.click(undo[0]);
  expect(onUndoDeckEdit).toHaveBeenCalledTimes(1);
});

it("shows no applied block for a turn that changed nothing", async () => {
  const chat = vi
    .fn()
    .mockResolvedValue(reply("You are light on ramp.", 0.0009, [toolCall("read_deck()")]));
  const onDeckEdit = vi.fn();
  render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(chat)}
      onDeckEdit={onDeckEdit}
    />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What am I missing?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("You are light on ramp.");

  // A turn that answered a question is not a turn that changed the deck, and a block
  // claiming otherwise would be the transcript inventing an edit.
  expect(onDeckEdit).not.toHaveBeenCalled();
  expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
});

it("posts the deck's recorded history so read_history has something to read", async () => {
  const history: DeckAgentDeckHistory = {
    sessions: [
      {
        actor: "user",
        started_at: "2026-07-31T10:00:00.000Z",
        ended_at: "2026-07-31T10:00:00.000Z",
        edits: [
          {
            at: "2026-07-31T10:00:00.000Z",
            cards: [
              {
                name: "Rampant Growth",
                after: { quantity: 1, section: "mainboard" },
              },
            ],
          },
        ],
      },
    ],
  };
  const chat = vi.fn().mockResolvedValue(reply("You edited this yesterday."));
  const readDeckHistory = vi.fn().mockReturnValue(history);
  render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(chat)}
      readDeckHistory={readDeckHistory}
    />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "What have I changed?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("You edited this yesterday.");

  // The backend holds no deck and therefore no history of one, so the log travels with
  // the turn exactly as the deck snapshot does — and it is read when the turn is sent,
  // not when the panel rendered, so it includes the edit made a moment ago.
  expect(readDeckHistory).toHaveBeenCalledTimes(1);
  expect(chat.mock.calls[0][5]).toEqual(history);
});

it("undoes the applied edit from the transcript, on the only block that can", async () => {
  const first = drivenStream();
  const onUndoDeckEdit = vi.fn();
  const { rerender } = render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(first.chat)}
      onDeckEdit={vi.fn().mockReturnValue(appliedSwap())}
      onUndoDeckEdit={onUndoDeckEdit}
      undoableEditId="edit-1"
    />,
  );

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "Fix my ramp",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await first.deckEdit(deckEdit());
  await first.finish(reply("Swapped two rocks in."));

  await userEvent.click(screen.getByRole("button", { name: "Undo" }));

  // One click reverses the whole edit, because the deck recorded it as one entry.
  expect(onUndoDeckEdit).toHaveBeenCalledTimes(1);

  // A second edited turn takes the affordance over. `undo` reverses the deck's last
  // recorded change, so an Undo left on the older block would promise that block's
  // reversal and deliver a different one.
  const second = drivenStream();
  rerender(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(second.chat)}
      onDeckEdit={vi.fn().mockReturnValue({
        reason: "Cutting a five-drop.",
        addedCopies: 0,
        removedCopies: 1,
        added: [],
        removed: ["Colossal Dreadmaw"],
        moved: [],
        editId: "edit-2",
      })}
      onUndoDeckEdit={onUndoDeckEdit}
      undoableEditId="edit-2"
    />,
  );
  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "And the curve?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await second.deckEdit(
    deckEdit({
      reason: "Cutting a five-drop.",
      changes: [
        {
          scryfall_id: "printing-colossal-dreadmaw",
          name: "Colossal Dreadmaw",
          quantity: 0,
          previous_quantity: 1,
        },
      ],
    }),
  );
  await second.finish(reply("Cut the six-drop."));

  expect(screen.getByText("Applied: +0 / −1")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  expect(
    screen
      .getByText("Applied: +0 / −1")
      .closest(".deck-agent__edit")
      ?.querySelector("button"),
  ).not.toBeNull();
});

it("drops a dragged card's name in at the caret", async () => {
  render(<DeckAgentPanel deckId="deck-a" client={client(vi.fn())} />);
  const field = screen.getByLabelText("Message the deck agent");
  await userEvent.type(field, "How does  fit?");
  // Back to just after "does ", so the drop has somewhere to land that is not the end.
  await userEvent.keyboard("{ArrowLeft>5/}");

  const panel = screen.getByRole("region", { name: "Deck agent" });
  const transfer = dataTransfer({ [CARD_NAME_DRAG_TYPE]: "Sol Ring" });
  fireEvent.dragOver(panel, { dataTransfer: transfer });
  // The composer says where the card is going to land while it is still in the air.
  expect(
    screen.getByPlaceholderText("Drop to add the card's name"),
  ).toBeInTheDocument();

  fireEvent.drop(panel, { dataTransfer: transfer });
  expect(field).toHaveValue("How does Sol Ring fit?");
  // Focused and positioned after the name, so the sentence can be finished by typing.
  expect(field).toHaveFocus();
  expect((field as HTMLTextAreaElement).selectionStart).toBe(
    "How does Sol Ring".length,
  );
  expect(
    screen.queryByPlaceholderText("Drop to add the card's name"),
  ).not.toBeInTheDocument();
});

it("spaces a dropped name against the words either side of it", () => {
  render(<DeckAgentPanel deckId="deck-a" client={client(vi.fn())} />);
  const panel = screen.getByRole("region", { name: "Deck agent" });

  // Nothing typed, so nothing to space against: the name arrives on its own.
  fireEvent.drop(panel, {
    dataTransfer: dataTransfer({ [CARD_NAME_DRAG_TYPE]: "Sol Ring" }),
  });
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("Sol Ring");

  // A second card appends with one space, not two, and not none.
  fireEvent.drop(panel, {
    dataTransfer: dataTransfer({ [CARD_NAME_DRAG_TYPE]: "Mana Crypt" }),
  });
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue(
    "Sol Ring Mana Crypt",
  );
});

it("leaves a drop that is not a card to the browser", () => {
  render(<DeckAgentPanel deckId="deck-a" client={client(vi.fn())} />);
  const panel = screen.getByRole("region", { name: "Deck agent" });

  // Text dragged in from anywhere else: no highlight offered on the way over, and the
  // draft untouched on the way down. The control for the test above — without it, a
  // handler that took any drop at all would pass that one just as well.
  const transfer = dataTransfer({ "text/plain": "https://example.com/deck" });
  const dragOver = createEvent.dragOver(panel, { dataTransfer: transfer });
  fireEvent(panel, dragOver);
  expect(dragOver.defaultPrevented).toBe(false);
  expect(
    screen.queryByPlaceholderText("Drop to add the card's name"),
  ).not.toBeInTheDocument();

  const drop = createEvent.drop(panel, { dataTransfer: transfer });
  fireEvent(panel, drop);
  expect(drop.defaultPrevented).toBe(false);
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("");
});

/** Send a question and leave the turn hanging, so a test can interrupt it. */
async function askAndWait(stream: ReturnType<typeof drivenStream>, question: string) {
  const view = render(
    <DeckAgentPanel deckId="deck-a" client={client(stream.chat)} />,
  );
  await userEvent.type(screen.getByLabelText("Message the deck agent"), question);
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByRole("status");
  return { ...view, panel: screen.getByRole("region", { name: "Deck agent" }) };
}

/** Press Escape on the panel, which is what cancels the turn in flight. */
async function pressEscape(panel: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(panel, { key: "Escape" });
  });
}

/**
 * The conversation as the browser saved it — what a reload would come back to.
 *
 * Read through the parser rather than out of the raw JSON, because the assertion is about
 * what survives the round trip: a cancelled turn's payloads are what the next turn's
 * replay is made of, and a field the reader drops is a field the feature does not have.
 */
function storedChat(deckId: string) {
  return parseStoredAgentChats(
    window.localStorage.getItem(DECK_AGENT_CHAT_STORAGE_KEY),
  )[deckId];
}

/** A call complete enough to be replayed: an id, its arguments, and its result. */
function replayableCall(
  signature: string,
  id: string,
  argumentsJson: string,
  result: string,
): DeckAgentToolCall {
  return toolCall(signature, { id, arguments_json: argumentsJson, result });
}

it("cancels a turn on Escape and hands the question back to be edited", async () => {
  const stream = drivenStream();
  const { panel } = await askAndWait(stream, "waht ramp shoud i add");
  expect(screen.getByText("esc to cancel")).toBeInTheDocument();

  // From a card the agent named rather than from the composer: the key belongs to the
  // conversation, and the user may well have clicked away while waiting.
  await pressEscape(panel);

  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  // Back in the composer and *out* of the transcript. Both halves matter: a question
  // left in both places is a question that gets asked twice by the next send.
  const composer = screen.getByLabelText("Message the deck agent");
  expect(composer).toHaveValue("waht ramp shoud i add");
  expect(screen.queryByText("waht ramp shoud i add")).toBe(composer);
  // Focused with the caret at the end, because it came back to be corrected.
  expect(composer).toHaveFocus();
  expect((composer as HTMLTextAreaElement).selectionStart).toBe(
    "waht ramp shoud i add".length,
  );

  // And the turn really is abandoned: its answer never lands.
  await stream.finish(reply("Add {Fellwar Stone}."));
  expect(screen.queryByText("Add {Fellwar Stone}.")).not.toBeInTheDocument();
});

it("keeps a cancelled turn's applied edit, and the question that asked for it", async () => {
  const stream = drivenStream();
  const { unmount } = render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={() => appliedSwap()}
      onUndoDeckEdit={vi.fn()}
      undoableEditId="edit-1"
    />,
  );
  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "add a sol ring",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await screen.findByRole("status");

  await stream.deckEdit(deckEdit());
  await pressEscape(screen.getByRole("region", { name: "Deck agent" }));

  // The deck changed, so the question stays: it is the only thing on screen saying
  // why. Withdrawing it would leave a changed deck nothing accounts for — and the
  // speed of the cancel cannot make that untrue, which is why an edit needs no
  // condition of its own. An edit is something that streamed.
  expect(screen.getByText("add a sol ring")).toBeInTheDocument();
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("");
  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();

  // And the block survives the cancel rather than vanishing with the live view: the deck
  // really is different, and this is the transcript's account of why — Undo included,
  // because the entry it names is still the deck's newest recorded change.
  expect(screen.getByText("Applied: +2 / −2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  expect(screen.getByText(/^Interrupted —/)).toBeInTheDocument();
  expect(storedChat("deck-a").entries[1].appliedEdits).toEqual([appliedSwap()]);

  // It is durable, not just on screen.
  unmount();
  render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      onDeckEdit={() => appliedSwap()}
      onUndoDeckEdit={vi.fn()}
      undoableEditId="edit-1"
    />,
  );
  expect(screen.getByText("Applied: +2 / −2")).toBeInTheDocument();
  expect(screen.getByText(/^Interrupted —/)).toBeInTheDocument();
});

it("hands back a question no turn ever acted on, however long ago it was asked", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const stream = drivenStream();
    const { panel } = await askAndWait(stream, "waht is my curve like");

    /*
     * Half a minute of a model thinking and never running anything.
     *
     * There is no window any more: what decides is whether the turn produced anything,
     * not how fast the user was. At `xhigh` effort a first tool call can take ten seconds
     * on its own, so the old timer expired while the turn was still silent — and a
     * silent turn has nothing worth keeping and a question worth handing back. This
     * asserted the opposite until 2026-08-03; it is the proof the timer is gone rather
     * than merely long.
     */
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await pressEscape(panel);

    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    const composer = screen.getByLabelText("Message the deck agent");
    expect(composer).toHaveValue("waht is my curve like");
    expect(screen.queryByText("waht is my curve like")).toBe(composer);
    expect(composer).toHaveFocus();
    expect((composer as HTMLTextAreaElement).selectionStart).toBe(
      "waht is my curve like".length,
    );
    // Nothing was committed either: a turn that did nothing leaves no entry behind.
    expect(storedChat("deck-a")?.entries ?? []).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it("commits a cancelled turn: the calls that ran and the prose so far", async () => {
  const stream = drivenStream();
  const { panel } = await askAndWait(stream, "what should i cut");

  await stream.tool(
    replayableCall("read_deck()", "call-1", "{}", "35 cards, 8 ramp."),
  );
  await stream.tool(
    replayableCall(
      "search_web(budget edh ramp)",
      "call-2",
      '{"query":"budget edh ramp"}',
      "Two primers agree on Fellwar Stone.",
    ),
  );
  await stream.text("You are light on ramp, ");
  await stream.text("so I would cut a five-drop.");

  await pressEscape(panel);

  // Asserted against the store rather than only the DOM: what makes this feature worth
  // anything is that the *next turn* can read it, and the next turn reads the store.
  const stored = storedChat("deck-a");
  expect(
    stored.entries.map((held) => [held.message.role, held.message.content]),
  ).toEqual([
    ["user", "what should i cut"],
    ["assistant", "You are light on ramp, so I would cut a five-drop."],
  ]);
  expect(stored.entries[1].interrupted).toBe(true);
  // Both calls, in order, with the payloads a replay is made of.
  expect(
    stored.entries[1].toolCalls.map((call) => [
      call.signature,
      call.id,
      call.result,
    ]),
  ).toEqual([
    ["read_deck()", "call-1", "35 cards, 8 ramp."],
    [
      "search_web(budget edh ramp)",
      "call-2",
      "Two primers agree on Fellwar Stone.",
    ],
  ]);
  // No revision to report, because nothing passed the panel a deck. Absent rather than
  // empty: the backend reads a missing revision as the browser declining to say.
  expect(stored.entries[1].toolCalls.map((call) => call.deckRevision)).toEqual([
    undefined,
    undefined,
  ]);

  expect(screen.getByText("read_deck()")).toBeInTheDocument();
  expect(screen.getByText("search_web(budget edh ramp)")).toBeInTheDocument();
  expect(
    screen.getByText("You are light on ramp, so I would cut a five-drop."),
  ).toBeInTheDocument();
  expect(screen.getByText(/^Interrupted —/)).toBeInTheDocument();
  // The question was asked and answered as far as it got, so it belongs to the
  // transcript — not back in the composer, where sending would ask it twice.
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("");
  expect(screen.getByText("what should i cut")).toBeInTheDocument();
  expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
});

it("keeps a cancelled turn that only wrote prose, and does not hand its question back", async () => {
  const stream = drivenStream();
  const { panel } = await askAndWait(stream, "is my curve fine");

  // No tools at all — a question the model answers straight out. Words on the screen are
  // as much "something happened" as a tool call is, so this is the control that stops the
  // withdrawal from being decided by tool calls alone.
  await stream.text("Your curve is fine, but");
  await pressEscape(panel);

  const stored = storedChat("deck-a");
  expect(
    stored.entries.map((held) => [held.message.content, held.interrupted]),
  ).toEqual([
    ["is my curve fine", undefined],
    ["Your curve is fine, but", true],
  ]);
  expect(stored.entries[1].toolCalls).toEqual([]);
  expect(screen.getByText("Your curve is fine, but")).toBeInTheDocument();
  expect(screen.getByText(/^Interrupted —/)).toBeInTheDocument();
  expect(screen.getByLabelText("Message the deck agent")).toHaveValue("");
});

it("shows a turn cancelled inside its first call as its lines and the marker alone", async () => {
  const stream = drivenStream();
  const { panel, unmount } = await askAndWait(stream, "read my deck");

  await stream.tool(replayableCall("read_deck()", "call-1", "{}", "35 cards."));
  await pressEscape(panel);

  // A real case, not a defect: the cancel landed before a word was written. The entry is
  // its tool line and its marker, and there is no bubble — one with an author and nothing
  // in it would claim the agent had answered.
  expect(screen.getByText("read_deck()")).toBeInTheDocument();
  expect(screen.getByText(/^Interrupted —/)).toBeInTheDocument();
  expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  expect(
    document.querySelectorAll(".deck-agent__message--assistant"),
  ).toHaveLength(0);
  expect(storedChat("deck-a").entries[1].message.content).toBe("");

  // And it reads back the same way after a reload. An empty content is exactly the shape
  // a reader could turn into an empty bubble, so the round trip is part of the assertion.
  unmount();
  render(<DeckAgentPanel deckId="deck-a" client={client(stream.chat)} />);
  expect(screen.getByText("read_deck()")).toBeInTheDocument();
  expect(screen.getByText(/^Interrupted —/)).toBeInTheDocument();
  expect(screen.queryByText("Agent")).not.toBeInTheDocument();
});

it("replays a cancelled turn's calls and results on the next question", async () => {
  const stream = drivenStream();
  const { panel } = await askAndWait(stream, "what ramp am i missing");

  await stream.tool(
    replayableCall("read_deck()", "call-1", "{}", "35 cards, 8 ramp."),
  );
  await stream.text("Looking at your curve");
  await pressEscape(panel);

  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "and now?",
  );
  await userEvent.click(screen.getByLabelText("Send message"));

  /*
   * The seam where the storage and the panel meet, and the only place it is observable.
   *
   * The interrupted turn goes back as the provider's own shape for one — the calls it
   * made, an answer for each, and the prose it got as far as — so the model continues
   * from what it already read instead of paying for `read_deck` a second time.
   *
   * Ids are asserted as a *pair* rather than against a literal, because pairing is the
   * rule: an unanswered call is a 422 that fails the whole turn, and what an id is
   * spelled as on the wire belongs to `buildAgentMessages` and its own tests. The stored
   * call still carries the id the stream reported — asserted above — and the wire may
   * scope it to keep two turns' ids apart.
   */
  const posted = stream.chat.mock.calls[1][0] as DeckAgentRequestMessage[];
  expect(posted.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
    "user",
  ]);
  expect(posted[0]).toEqual({
    role: "user",
    content: "what ramp am i missing",
  });
  const [replayed] = posted[1].tool_calls ?? [];
  expect(replayed).toMatchObject({ name: "read_deck", arguments_json: "{}" });
  expect(replayed.id).toBeTruthy();
  // No prose on the message carrying the calls: that is the provider's own shape for a
  // round that only called tools, and the partial answer is its own message below.
  expect(posted[1].content).toBeUndefined();
  expect(posted[2]).toEqual({
    role: "tool",
    tool_call_id: replayed.id,
    content: "35 cards, 8 ramp.",
  });
  expect(posted[3]).toEqual({
    role: "assistant",
    content: "Looking at your curve",
  });
  expect(posted[4]).toEqual({ role: "user", content: "and now?" });
});

it("stamps every call with the revision of the deck the turn asked about", async () => {
  const stream = drivenStream();
  const deckAt = (updatedAt: string): DeckAgentDeckSnapshot => ({
    name: "Ghalta Stompy",
    cards: [],
    updated_at: updatedAt,
  });
  const view = render(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      deck={deckAt("2026-08-03T09:00:00.000Z")}
    />,
  );
  await userEvent.type(
    screen.getByLabelText("Message the deck agent"),
    "what should i cut",
  );
  await userEvent.click(screen.getByLabelText("Send message"));
  await stream.tool(replayableCall("read_deck()", "call-1", "{}", "35 cards."));

  // The user edits the deck while the turn is still running, so the panel re-renders with
  // a newer revision. The turn is still reading the deck it was asked about.
  view.rerender(
    <DeckAgentPanel
      deckId="deck-a"
      client={client(stream.chat)}
      deck={deckAt("2026-08-03T09:05:00.000Z")}
    />,
  );
  await stream.tool(
    replayableCall(
      "see_cards(Sol Ring · rules)",
      "call-2",
      '{"names":["Sol Ring"]}',
      "Sol Ring: {1}, adds {C}{C}.",
    ),
  );
  await pressEscape(screen.getByRole("region", { name: "Deck agent" }));

  /*
   * Both calls carry the older revision, including the one that arrived after the deck
   * had moved. The backend holds no deck, so a reply cannot report this and the panel is
   * the only place it can come from — and the comparison it feeds is only meaningful
   * against the deck the result was actually read from. Stamping the deck open *now*
   * would tell the backend the reading is current at the exact moment it is not.
   */
  expect(
    storedChat("deck-a").entries[1].toolCalls.map((call) => call.deckRevision),
  ).toEqual(["2026-08-03T09:00:00.000Z", "2026-08-03T09:00:00.000Z"]);
});

it("leaves Escape alone when no turn is in flight", async () => {
  render(<DeckAgentPanel deckId="deck-a" client={client(vi.fn())} />);
  const composer = screen.getByLabelText("Message the deck agent");
  await userEvent.type(composer, "half a question");

  // Nothing to interrupt, so nothing is: a draft is not cleared by a key that cancels
  // a request, and the panel does not swallow Escape from whatever else might want it.
  const escape = createEvent.keyDown(
    screen.getByRole("region", { name: "Deck agent" }),
    { key: "Escape" },
  );
  fireEvent(screen.getByRole("region", { name: "Deck agent" }), escape);
  expect(escape.defaultPrevented).toBe(false);
  expect(composer).toHaveValue("half a question");
});
