import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { Deck, DeckCardEntry } from "./domain/deck";
import {
  COMMAND_ZONE_GROUP_ID,
  createEmptyDeck,
  DECK_LIBRARY_STORAGE_KEY,
  DECK_STORAGE_KEY,
  UNASSIGNED_GROUP_ID,
} from "./domain/deck";
import { DECK_HISTORY_STORAGE_KEY } from "./domain/history";
import type { CardSearchResult } from "./domain/card";
import {
  cardSearchPage,
  counterspell,
  gamble,
  ghalta,
  solRing,
} from "./test/fixtures";

const healthResponse = {
  status: "ok",
  service: "mtg-agentic-deck-builder-api",
  version: "0.1.0",
};

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/cards/search")) {
      return Promise.resolve(
        Response.json(cardSearchPage(), { status: 200 }),
      );
    }
    return Promise.resolve(Response.json(healthResponse, { status: 200 }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deck workspace", () => {
  it("builds, validates, persists, and undoes a local deck", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Command zone" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Not assigned" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add custom group" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("Card service online")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Filter this deck"),
    ).not.toBeInTheDocument();

    const searchTrigger = screen.getByRole("button", { name: "Add cards" });
    await user.click(searchTrigger);
    const dialog = screen.getByRole("dialog", { name: "Find cards" });
    const input = screen.getByRole("textbox", {
      name: "Search cards",
    });
    expect(input).toHaveFocus();

    await user.type(input, "Sol Ring");
    const addButton = await screen.findByRole("button", {
      name: "Add Sol Ring to deck",
    });
    await user.click(addButton);
    expect(screen.getByLabelText("1 in deck")).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(dialog).not.toBeInTheDocument();
    expect(searchTrigger).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Inspect Sol Ring" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Maybeboard" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Group cards" }),
    ).toHaveValue("type");
    expect(
      screen.getByRole("option", { name: "Card types" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Artifact" })).toBeInTheDocument();
    expect(screen.getByText("1 / 100")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Increase Sol Ring quantity" }),
    );
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByLabelText("Singleton warning")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Undo last deck change" }),
    );
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 100")).toBeInTheDocument();

    await waitFor(() => {
      expect(window.localStorage.getItem(DECK_LIBRARY_STORAGE_KEY)).toContain(
        '"name":"Sol Ring"',
      );
    });
  });

  it("keeps custom grouping explicit and manages multiple local decks", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Group cards" }),
      "custom",
    );
    await user.click(
      screen.getByRole("button", { name: "Add custom group" }),
    );
    await user.type(screen.getByRole("textbox", { name: "Group name" }), "Ramp");
    await user.click(
      screen.getByRole("button", { name: "Create custom group" }),
    );
    expect(screen.getByRole("heading", { name: "Ramp" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add cards" }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Search cards",
      }),
      "Sol Ring",
    );
    await user.click(
      await screen.findByRole("button", { name: "Add Sol Ring to deck" }),
    );
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Inspect Sol Ring" }));
    expect(
      screen.getByRole("dialog", { name: "Card details" }),
    ).toBeInTheDocument();
    expect(document.querySelector("main")).toHaveAttribute("inert");
    expect(screen.queryByText("Deck inspector")).not.toBeInTheDocument();

    const customGroupSelect = screen.getByRole("combobox", {
      name: "Move Sol Ring to custom group",
    });
    expect(customGroupSelect).toHaveValue(UNASSIGNED_GROUP_ID);
    await user.selectOptions(
      customGroupSelect,
      screen.getByRole("option", { name: "Ramp" }),
    );
    expect(
      screen.getByRole("combobox", {
        name: "Move Sol Ring to custom group",
      }),
    ).toHaveDisplayValue("Ramp");

    await user.click(
      screen.getAllByRole("button", { name: "Close card inspector" })[1],
    );
    expect(
      screen.queryByRole("dialog", { name: "Card details" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Drag Sol Ring" }),
    ).toHaveAttribute("aria-roledescription", "draggable");

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Group cards" }),
      "type",
    );
    expect(screen.getByRole("heading", { name: "Artifact" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add custom group" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Drag Sol Ring" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Inspect Sol Ring" }));
    expect(
      screen.queryByRole("combobox", {
        name: "Move Sol Ring to custom group",
      }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getAllByRole("button", { name: "Close card inspector" })[1],
    );

    await user.click(screen.getByRole("button", { name: "Rename deck" }));
    const deckName = screen.getByRole("textbox", { name: "Deck name" });
    await user.clear(deckName);
    await user.type(deckName, "Dinosaur Ramp");
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("heading", { name: "Dinosaur Ramp" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Create new deck" }),
    );
    expect(
      screen.getByRole("heading", { name: "Untitled Commander" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Dinosaur Ramp/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Dinosaur Ramp/ }));
    expect(
      screen.getByRole("heading", { name: "Dinosaur Ramp" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Inspect Sol Ring" }),
    ).toBeInTheDocument();
  });

  it("confirms deck deletion, creates a safe fallback, and restores the deleted deck", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Rename deck" }));
    const nameInput = screen.getByRole("textbox", { name: "Deck name" });
    await user.clear(nameInput);
    await user.type(nameInput, "Dinosaur Ramp");
    await user.keyboard("{Enter}");

    await user.click(
      screen.getByRole("button", { name: "Delete Dinosaur Ramp" }),
    );
    const confirmation = screen.getByRole("alertdialog");
    expect(
      within(confirmation).getByRole("heading", {
        name: "Delete Dinosaur Ramp?",
      }),
    ).toBeInTheDocument();
    expect(
      within(confirmation).getByText(
        /A new empty deck will be created/,
      ),
    ).toBeInTheDocument();
    expect(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();

    await user.click(
      within(confirmation).getByRole("button", { name: "Delete deck" }),
    );
    expect(
      screen.getByRole("heading", { name: "Untitled Commander" }),
    ).toBeInTheDocument();
    const restoreButton = screen.getByRole("button", { name: "Undo" });
    expect(restoreButton.parentElement).toHaveTextContent(
      "Dinosaur Ramp deleted.",
    );

    await user.click(restoreButton);
    expect(
      screen.getByRole("heading", { name: "Dinosaur Ramp" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an incompatible second card out of the command zone", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/cards/search")) {
        const query = new URL(url, window.location.href).searchParams.get("q");
        return Promise.resolve(
          Response.json(
            cardSearchPage(
              query?.includes("Counterspell") ? [counterspell] : [ghalta],
              query ?? "",
            ),
          ),
        );
      }
      return Promise.resolve(Response.json(healthResponse));
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Add to command zone" }),
    );
    const input = screen.getByRole("textbox", { name: "Search cards" });
    await user.type(input, "Ghalta");
    await user.click(
      await screen.findByRole("button", {
        name: "Add Ghalta, Primal Hunger to deck",
      }),
    );

    await user.clear(input);
    await user.type(input, "Counterspell");
    await user.click(
      await screen.findByRole("button", {
        name: "Add Counterspell to deck",
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Counterspell cannot share the command zone with Ghalta, Primal Hunger.",
    );
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("button", {
        name: "Inspect Ghalta, Primal Hunger",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Inspect Counterspell" }),
    ).not.toBeInTheDocument();
  });

  it("replaces the toolbar search field with an Add cards button", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.queryByRole("textbox", { name: "Search cards from toolbar" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add cards" }));

    expect(
      await screen.findByRole("dialog", { name: "Find cards" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search cards" })).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Inspect Sol Ring" }),
    ).not.toBeInTheDocument();
  });

  it("shows enrichment in deck card details and opens related cards at quantity zero", async () => {
    const deck = createEmptyDeck(new Date("2026-01-01T00:00:00Z"));
    deck.cards = [
      {
        card: {
          oracle_id: solRing.oracle_id,
          scryfall_id: solRing.scryfall_id,
          name: solRing.name,
          details: solRing,
        },
        quantity: 1,
        section: "mainboard",
        categories: [UNASSIGNED_GROUP_ID],
      },
    ];
    window.localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(deck));
    const manaVault = {
      ...solRing,
      oracle_id: "oracle-mana-vault",
      scryfall_id: "printing-mana-vault",
      name: "Mana Vault",
    };
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes(`/cards/${solRing.oracle_id}/enrichment`)) {
        return Promise.resolve(
          Response.json({
            oracle_id: solRing.oracle_id,
            tags: [
              {
                id: "tag-mana-rock",
                name: "mana rock",
                slug: "mana-rock",
                description: "Artifacts that produce mana.",
              },
            ],
            similar_cards: [
              { oracle_id: manaVault.oracle_id, name: manaVault.name },
            ],
            references: [],
            referenced_by: [],
            upgrades: [],
            downgrades: [],
            variants: [],
            creature_versions: [],
            spell_versions: [],
            related_cards: [],
          }),
        );
      }
      if (url.includes(`/cards/${manaVault.oracle_id}/enrichment`)) {
        return Promise.resolve(
          Response.json({
            oracle_id: manaVault.oracle_id,
            tags: [],
            similar_cards: [],
            references: [],
            referenced_by: [],
            upgrades: [],
            downgrades: [],
            variants: [],
            creature_versions: [],
            spell_versions: [],
            related_cards: [],
          }),
        );
      }
      if (url.endsWith(`/cards/${manaVault.oracle_id}`)) {
        return Promise.resolve(Response.json(manaVault));
      }
      if (url.includes("/cards/search")) {
        return Promise.resolve(Response.json(cardSearchPage()));
      }
      return Promise.resolve(Response.json(healthResponse));
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      screen.getByRole("button", { name: "Inspect Sol Ring" }),
    );
    const firstDialog = screen.getByRole("dialog", { name: "Card details" });
    expect(
      await within(firstDialog).findByRole("button", { name: "mana rock" }),
    ).toBeInTheDocument();
    await user.click(
      within(firstDialog).getByRole("button", { name: "Mana Vault" }),
    );

    const relatedDialog = screen.getByRole("dialog", { name: "Card details" });
    expect(
      within(relatedDialog).getByRole("heading", { name: "Mana Vault" }),
    ).toBeInTheDocument();
    expect(
      within(relatedDialog).getByRole("button", {
        name: "Add to deck",
      }),
    ).toBeInTheDocument();

    await user.click(
      within(relatedDialog).getByRole("button", {
        name: "Close card inspector",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Inspect Sol Ring" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "mana rock" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Find cards" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove mana rock tag" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        vi.mocked(globalThis.fetch).mock.calls.some(([input]) => {
          const url = new URL(String(input), window.location.href);
          return url.pathname.endsWith("/cards/search")
            && url.searchParams.get("tag") === "tag-mana-rock";
        }),
      ).toBe(true),
    );
  });

  it("warns before and after adding a card outside commander colors", async () => {
    const deck = createEmptyDeck(new Date("2026-01-01T00:00:00Z"));
    deck.cards = [
      {
        card: {
          oracle_id: ghalta.oracle_id,
          scryfall_id: ghalta.scryfall_id,
          name: ghalta.name,
          details: ghalta,
        },
        quantity: 1,
        section: "command_zone",
        categories: ["command_zone"],
      },
    ];
    window.localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(deck));
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/cards/search")) {
        return Promise.resolve(
          Response.json(cardSearchPage([gamble]), { status: 200 }),
        );
      }
      return Promise.resolve(Response.json(healthResponse, { status: 200 }));
    });
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole("img", {
        name: "Ghalta, Primal Hunger commander",
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add cards" }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Search cards",
      }),
      "Gamble",
    );
    expect(
      await screen.findByText("Outside commander color identity"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add Gamble to deck" }),
    );
    await user.keyboard("{Escape}");

    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByLabelText("Color identity warning")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Maybeboard" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Inspect Gamble" }),
    );
    expect(
      screen.getByText(
        "R is outside this deck's G commander color identity.",
      ),
    ).toBeInTheDocument();
  });

  it("owns debug mode in the interface settings and shares it with the workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Debug mode is an interface setting now, so it must be reachable without
    // opening card search first.
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const toggle = screen.getByRole("switch", { name: "Debug mode" });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(toggle).toBeChecked();
    expect(window.localStorage.getItem("manabase.search-debug")).toBe("true");
    // The deck agent's running cost appears only while debug mode is on.
    expect(screen.getByText("$0.0000")).toBeInTheDocument();

    await user.click(toggle);
    expect(window.localStorage.getItem("manabase.search-debug")).toBe("false");
    expect(screen.queryByText("$0.0000")).not.toBeInTheDocument();
  });
});

/**
 * The agent's edits, driven the way they actually arrive: a real stream through the real
 * client into the real deck.
 *
 * The seam these tests exist for is the wiring, not the parts. An event that parses and a
 * panel that renders can both be right while the deck never hears about the edit, so every
 * test here starts at a server-sent-event body and ends at the board and the transcript.
 */
describe("agent deck edits", () => {
  /** A server-sent-event body carrying one frame per event, as the backend writes them. */
  function agentStream(frames: unknown[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  /** Serve one streamed turn, and collect the request bodies it was asked with. */
  function serveAgentTurn(frames: unknown[]): Record<string, unknown>[] {
    const requests: Record<string, unknown>[] = [];
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/agent/chat/stream")) {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(agentStream(frames));
      }
      if (url.includes("/cards/search")) {
        return Promise.resolve(Response.json(cardSearchPage(), { status: 200 }));
      }
      return Promise.resolve(Response.json(healthResponse, { status: 200 }));
    });
    return requests;
  }

  function doneFrame(content: string) {
    return {
      type: "done",
      reply: {
        message: { role: "assistant", content },
        model: "openai/gpt-5.6-luna",
        replayed_message_count: 1,
        cost_usd: 0.0009,
        unpriced_call_count: 0,
        tool_calls: [
          {
            name: "edit_deck",
            signature: "edit_deck(2 changes)",
            ok: true,
            detail: null,
          },
        ],
        card_links: [],
      },
    };
  }

  function deckEntry(
    card: CardSearchResult,
    groupId = UNASSIGNED_GROUP_ID,
  ): DeckCardEntry {
    return {
      card: {
        oracle_id: card.oracle_id,
        scryfall_id: card.scryfall_id,
        name: card.name,
        details: card,
      },
      quantity: 1,
      section: "mainboard",
      categories: [groupId],
    };
  }

  function seedDeck(deck: Partial<Deck>): void {
    window.localStorage.setItem(
      DECK_STORAGE_KEY,
      JSON.stringify({
        ...createEmptyDeck(new Date("2026-01-01T00:00:00Z"), "Gruul Stompy"),
        ...deck,
      }),
    );
  }

  function storedDeck(): Deck {
    const library = JSON.parse(
      window.localStorage.getItem(DECK_LIBRARY_STORAGE_KEY) ?? "{}",
    ) as { decks: Deck[] };
    return library.decks[0];
  }

  function storedHistorySessions(): Array<{
    actor: string;
    edits: Array<{ reason?: string; cards: unknown[] }>;
  }> {
    const logs = JSON.parse(
      window.localStorage.getItem(DECK_HISTORY_STORAGE_KEY) ?? "{}",
    ) as Record<string, { sessions: Array<{ actor: string; edits: Array<{ reason?: string; cards: unknown[] }> }> }>;
    return Object.values(logs).flatMap((log) => log.sessions);
  }

  /** One group's header row, which carries its own card count beside its name. */
  function groupHeader(label: string): HTMLElement {
    const header = screen
      .getByRole("heading", { name: label })
      .closest("header");
    if (!header) {
      throw new Error(`the ${label} group has no header`);
    }
    return header;
  }

  async function ask(question: string): Promise<void> {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Message the deck agent"), question);
    await user.click(screen.getByLabelText("Send message"));
  }

  it("applies a streamed deck edit, records it as the agent's, and undoes it", async () => {
    seedDeck({ cards: [deckEntry(gamble)] });
    serveAgentTurn([
      { type: "text", content: "Swapping in a rock for the weakest ramp." },
      // An event type this build has never heard of. The stream is forward compatible:
      // a future event has to be ignorable, or every new one breaks every old client.
      { type: "crystal_ball", prediction: "you will draw lands" },
      // And a `deck_edit` that cannot be read is ignored the same way rather than
      // taking the turn down: the quantity is not a number, and coercing it would
      // delete a card.
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Malformed.",
          changes: [
            { scryfall_id: solRing.scryfall_id, name: "Sol Ring", quantity: "two" },
          ],
        },
      },
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Swapping in a rock for the weakest ramp.",
          changes: [
            {
              scryfall_id: solRing.scryfall_id,
              name: solRing.name,
              quantity: 2,
              previous_quantity: 0,
              card: solRing,
            },
            {
              scryfall_id: gamble.scryfall_id,
              name: gamble.name,
              quantity: 0,
              previous_quantity: 1,
            },
          ],
        },
      },
      doneFrame("Swapping in a rock for the weakest ramp."),
    ]);
    render(<App />);
    expect(screen.getByLabelText("1 Gamble in deck")).toBeInTheDocument();

    await ask("Fix my ramp");
    expect(
      await screen.findByText("Swapping in a rock for the weakest ramp."),
    ).toBeInTheDocument();

    // The deck itself changed, which is the whole point: the browser is the only thing
    // that can apply the edit and it did.
    expect(screen.getByLabelText("2 Sol Ring in deck")).toBeInTheDocument();
    expect(screen.queryByLabelText("1 Gamble in deck")).not.toBeInTheDocument();

    const transcript = screen.getByRole("log", {
      name: "Deck agent conversation",
    });
    expect(within(transcript).getByText("Applied: +2 / −1")).toBeInTheDocument();
    expect(within(transcript).getByText("+ Sol Ring")).toBeInTheDocument();
    expect(within(transcript).getByText("− Gamble")).toBeInTheDocument();

    // Recorded as the agent's, with the model's reason. The actor is what makes the log
    // worth having, and an agent edit filed as the user's would attribute the change to
    // whoever is reading it.
    const sessions = storedHistorySessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].actor).toBe("agent");
    expect(sessions[0].edits).toHaveLength(1);
    expect(sessions[0].edits[0].reason).toBe(
      "Swapping in a rock for the weakest ramp.",
    );

    // One click reverses the whole edit, because the deck recorded it as one entry.
    await userEvent.setup().click(
      within(transcript).getByRole("button", { name: "Undo" }),
    );
    expect(screen.queryByLabelText("2 Sol Ring in deck")).not.toBeInTheDocument();
    expect(screen.getByLabelText("1 Gamble in deck")).toBeInTheDocument();
  });

  it("applies a streamed deck edit once in StrictMode, not twice", async () => {
    seedDeck({ cards: [] });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "You have no ramp at all.",
          changes: [
            {
              scryfall_id: solRing.scryfall_id,
              name: solRing.name,
              quantity: 2,
              previous_quantity: 0,
              card: solRing,
            },
          ],
        },
      },
      doneFrame("Added two copies."),
    ]);
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await ask("Fix my ramp");
    expect(await screen.findByText("Added two copies.")).toBeInTheDocument();

    // Two copies, not four, and one block rather than two. Only the block count bites: an
    // edit states the count it wants afterwards, so a second hand-over reaches quantity 2
    // again, derives an empty diff, and `appendToHistory` returns the log it was given by
    // reference — the quantity and the recorded-edit count are both satisfied by a double
    // application. The transcript is not: each hand-over pushes its own block.
    expect(screen.getByLabelText("2 Sol Ring in deck")).toBeInTheDocument();
    expect(screen.getAllByText("Applied: +2 / −0")).toHaveLength(1);
    expect(storedHistorySessions()[0].edits).toHaveLength(1);
  });

  it("posts the edit it just made as history, so read_history can read it", async () => {
    seedDeck({ cards: [deckEntry(gamble, "group-ramp")], custom_groups: [{ id: "group-ramp", name: "Ramp" }] });
    const requests = serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Swapping in a rock for the weakest ramp.",
          changes: [
            {
              scryfall_id: solRing.scryfall_id,
              name: solRing.name,
              quantity: 1,
              previous_quantity: 0,
              group: "Ramp",
              card: solRing,
            },
          ],
        },
      },
      doneFrame("Sol Ring is in."),
    ]);
    render(<App />);

    await ask("Fix my ramp");
    expect(await screen.findByText("Sol Ring is in.")).toBeInTheDocument();
    // Nothing was recorded when the first question was asked.
    expect(requests[0].history).toEqual({ sessions: [] });

    await ask("What did you change?");
    await waitFor(() => expect(requests).toHaveLength(2));

    // The edit made a moment ago is in the next turn's request. It is read when the
    // turn is sent rather than held in state, because the log is written by an effect
    // after the render that changed the deck — a value captured in that render would be
    // missing exactly the edit the question is about.
    expect(requests[1].history).toEqual({
      sessions: [
        {
          actor: "agent",
          started_at: expect.any(String),
          ended_at: expect.any(String),
          edits: [
            {
              at: expect.any(String),
              reason: "Swapping in a rock for the weakest ramp.",
              cards: [
                {
                  name: "Sol Ring",
                  // The group travels as its name on screen, never the internal id.
                  after: { quantity: 1, section: "mainboard", group: "Ramp" },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("leaves a card's group alone when the agent only changes its quantity", async () => {
    seedDeck({
      cards: [deckEntry(gamble, "group-ramp")],
      custom_groups: [{ id: "group-ramp", name: "Ramp" }],
    });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "One more copy.",
          changes: [
            // No `group` at all, which means "leave placement alone" and never
            // "unfile it" — the same absence covers a card the user filed and a card
            // that is genuinely unfiled.
            {
              scryfall_id: gamble.scryfall_id,
              name: gamble.name,
              quantity: 2,
              previous_quantity: 1,
              card: gamble,
            },
          ],
        },
      },
      doneFrame("Second copy added."),
    ]);
    render(<App />);

    await ask("Run two");
    expect(await screen.findByText("Second copy added.")).toBeInTheDocument();
    expect(screen.getByLabelText("2 Gamble in deck")).toBeInTheDocument();

    // The quantity alone proves nothing: an applier that wrote the group unconditionally
    // would pass that assertion while quietly taking the card out of the group the user
    // put it in — invisible on the board's default view, and cumulative across turns.
    expect(storedDeck().cards[0].categories).toEqual(["group-ramp"]);
    await userEvent
      .setup()
      .selectOptions(screen.getByLabelText("Group cards"), "custom");
    // Both copies are still in Ramp, and Not assigned — which is a permanent group and
    // therefore always on screen — is still empty.
    expect(groupHeader("Ramp")).toHaveTextContent("2 cards");
    expect(groupHeader("Not assigned")).toHaveTextContent("0 cards");
  });

  it("renders an edit the deck refused as refused, keeping the undo on the one it took", async () => {
    seedDeck({
      cards: [
        {
          ...deckEntry(ghalta),
          section: "command_zone",
          categories: [COMMAND_ZONE_GROUP_ID],
        },
      ],
    });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "You have no ramp at all.",
          changes: [
            {
              scryfall_id: solRing.scryfall_id,
              name: solRing.name,
              quantity: 1,
              previous_quantity: 0,
              card: solRing,
            },
          ],
        },
      },
      doneFrame("Sol Ring is in."),
    ]);
    render(<App />);

    await ask("Fix my ramp");
    expect(await screen.findByText("Sol Ring is in.")).toBeInTheDocument();
    expect(screen.getByLabelText("1 Sol Ring in deck")).toBeInTheDocument();

    const transcript = screen.getByRole("log", {
      name: "Deck agent conversation",
    });
    expect(within(transcript).getByText("Applied: +1 / −0")).toBeInTheDocument();

    // The backend does not enforce command-zone legality on purpose — one authority, in
    // `domain/deck.ts` — so this is an edit the agent can and does emit and the browser
    // refuses. Driven through the real stream, because the seam is the whole point.
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Counterspell is the better commander here.",
          changes: [
            {
              scryfall_id: counterspell.scryfall_id,
              name: counterspell.name,
              quantity: 1,
              previous_quantity: 0,
              group: "Command zone",
              card: counterspell,
            },
          ],
        },
      },
      doneFrame("Counterspell should lead this deck."),
    ]);

    await ask("Make Counterspell my commander");
    expect(
      await screen.findByText("Counterspell should lead this deck."),
    ).toBeInTheDocument();

    // The transcript is the record, and it converges on what the deck did: refused, in the
    // deck's own words. The toast says the same sentence and then goes away; this stays.
    expect(within(transcript).getByText("Not applied")).toBeInTheDocument();
    expect(
      within(transcript).getByText(/cannot share the command zone with Ghalta/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /cannot share the command zone with Ghalta/,
    );
    // One applied block, from the turn that was applied. A second would be the transcript
    // claiming a commander swap the deck never made.
    expect(within(transcript).getAllByText(/^Applied:/)).toHaveLength(1);

    // The deck refused whole: Counterspell is nowhere, and nothing new was recorded.
    expect(screen.queryByLabelText("1 Counterspell in deck")).not.toBeInTheDocument();
    expect(storedDeck().cards.map((entry) => entry.card.name)).toEqual([
      "Ghalta, Primal Hunger",
      "Sol Ring",
    ]);
    const sessions = storedHistorySessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].edits).toHaveLength(1);

    // And the Undo still belongs to the edit that happened, which it reverses whole.
    const undo = within(transcript).getAllByRole("button", { name: "Undo" });
    expect(undo).toHaveLength(1);
    expect(
      within(transcript).getByText("Applied: +1 / −0").closest(".deck-agent__edit"),
    ).toContainElement(undo[0]);
    await userEvent.setup().click(undo[0]);
    expect(screen.queryByLabelText("1 Sol Ring in deck")).not.toBeInTheDocument();
  });

  it("renders an edit whose card it cannot identify as refused, not as applied", async () => {
    seedDeck({ cards: [deckEntry(gamble)] });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Cutting the weakest ramp.",
          // A cut carries no card payload, because the deck is supposed to already hold
          // the card — and this printing it does not hold. Reachable with no race at all:
          // `edit_deck` can resolve a name to a printing other than the one in the deck.
          changes: [
            {
              scryfall_id: "printing-a-different-gamble",
              name: "Gamble",
              quantity: 0,
              previous_quantity: 1,
            },
          ],
        },
      },
      doneFrame("Gamble is out."),
    ]);
    render(<App />);

    await ask("Cut my weakest card");
    expect(await screen.findByText("Gamble is out.")).toBeInTheDocument();

    // The deck was never even asked, so nothing announced it and the transcript is the
    // only place this can be said. Said it must be: the alternative is a durable block
    // reading "Applied: +0 / −1" for an edit that got no further than the translation.
    expect(screen.getByText("Not applied")).toBeInTheDocument();
    expect(
      screen.getByText(/named a card this deck cannot identify/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
    expect(screen.queryByText("− Gamble")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("1 Gamble in deck")).toBeInTheDocument();
    expect(storedHistorySessions()).toEqual([]);
  });

  it("claims a move only when the deck made one", async () => {
    seedDeck({
      cards: [deckEntry(gamble, "group-ramp")],
      custom_groups: [
        { id: "group-ramp", name: "Ramp" },
        { id: "group-removal", name: "Removal" },
      ],
    });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Gamble is really removal.",
          // Same quantity, and a group this deck does not have. The name is dropped rather
          // than obeyed — which is correct, and leaves the change a no-op.
          changes: [
            {
              scryfall_id: gamble.scryfall_id,
              name: gamble.name,
              quantity: 1,
              previous_quantity: 1,
              group: "Spot removal",
              card: gamble,
            },
          ],
        },
      },
      doneFrame("Filed under removal."),
    ]);
    render(<App />);

    await ask("File Gamble under removal");
    expect(await screen.findByText("Filed under removal.")).toBeInTheDocument();

    // Nothing moved, so nothing is claimed. A `→ Gamble` line here would be a durable
    // claim about a card that never left the group the user filed it in.
    expect(screen.queryByText("→ Gamble")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
    expect(storedDeck().cards[0].categories).toEqual(["group-ramp"]);
    expect(storedHistorySessions()).toEqual([]);

    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Gamble is really removal.",
          changes: [
            {
              scryfall_id: gamble.scryfall_id,
              name: gamble.name,
              quantity: 1,
              previous_quantity: 1,
              group: "Removal",
              card: gamble,
            },
          ],
        },
      },
      doneFrame("Moved to Removal."),
    ]);

    await ask("The group is called Removal");
    expect(await screen.findByText("Moved to Removal.")).toBeInTheDocument();

    // The same shape of change, this time naming a group the deck has: it moves, it is
    // recorded, and the block says so on its third line — the one no test rendered before.
    expect(screen.getByText("Applied: +0 / −0")).toBeInTheDocument();
    expect(screen.getByText("→ Gamble")).toBeInTheDocument();
    expect(storedDeck().cards[0].categories).toEqual(["group-removal"]);
    expect(storedHistorySessions()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("changes nothing on a turn that carried no deck edit", async () => {
    seedDeck({ cards: [deckEntry(gamble)] });
    const requests = serveAgentTurn([
      { type: "text", content: "You are light on ramp." },
      doneFrame("You are light on ramp."),
    ]);
    render(<App />);

    await ask("What am I missing?");
    expect(await screen.findByText("You are light on ramp.")).toBeInTheDocument();

    // The deck is untouched, nothing is recorded against it, and the transcript claims
    // no edit. A turn that answered a question is not a turn that changed the deck.
    expect(screen.getByLabelText("1 Gamble in deck")).toBeInTheDocument();
    expect(storedDeck().cards).toHaveLength(1);
    expect(storedHistorySessions()).toEqual([]);
    expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
    // The history still travelled with the turn, so `read_history` had something to
    // read: an empty log is a deck that has never been edited, which is an answer.
    expect(requests[0].history).toEqual({ sessions: [] });
  });
});
