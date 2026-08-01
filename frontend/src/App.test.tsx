import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { Deck, DeckCardEntry, DeckSection } from "./domain/deck";
import {
  createEmptyDeck,
  DECK_LIBRARY_STORAGE_KEY,
  DECK_STORAGE_KEY,
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
    // The board groups by card type and nothing else: there is no grouping control to
    // choose, no group to create, and no heading for cards that belong to no group.
    expect(
      screen.queryByRole("heading", { name: "Not assigned" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add custom group" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Group cards" }),
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

  it("makes a card the commander from the inspector and manages multiple local decks", async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/cards/search")) {
        return Promise.resolve(
          Response.json(cardSearchPage([ghalta], "Ghalta"), { status: 200 }),
        );
      }
      return Promise.resolve(Response.json(healthResponse, { status: 200 }));
    });
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Add cards" }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Search cards",
      }),
      "Ghalta",
    );
    await user.click(
      await screen.findByRole("button", { name: "Add Ghalta, Primal Hunger to deck" }),
    );
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Inspect Ghalta, Primal Hunger" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Card details" }),
    ).toBeInTheDocument();
    expect(document.querySelector("main")).toHaveAttribute("inert");
    expect(screen.queryByText("Deck inspector")).not.toBeInTheDocument();

    // The one placement control there is, and it is not conditional on anything: before
    // custom groups were removed this select only appeared while the board grouped by
    // custom group, which left the default view — now the only view — with no way to fill
    // the command zone except a drag.
    const placement = screen.getByRole("combobox", {
      name: "Move Ghalta, Primal Hunger to another part of the deck",
    });
    expect(placement).toHaveValue("mainboard");
    await user.selectOptions(
      placement,
      screen.getByRole("option", { name: "Command zone" }),
    );
    expect(placement).toHaveDisplayValue("Command zone");

    await user.click(
      screen.getAllByRole("button", { name: "Close card inspector" })[1],
    );
    expect(
      screen.queryByRole("dialog", { name: "Card details" }),
    ).not.toBeInTheDocument();
    // The card is under the command-zone heading now, and the deck's colour identity
    // follows from it.
    expect(
      screen.getByRole("heading", { name: "Command zone" }).closest("header"),
    ).toHaveTextContent("1 cards");
    await waitFor(() => {
      expect(window.localStorage.getItem(DECK_LIBRARY_STORAGE_KEY)).toContain(
        '"section":"command_zone"',
      );
    });
    // Drag is on in the only view there is, rather than only in a mode that no longer
    // exists — it is how a card reaches the command zone without opening the inspector.
    expect(
      screen.getByRole("button", { name: "Drag Ghalta, Primal Hunger" }),
    ).toHaveAttribute("aria-roledescription", "draggable");

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
    // Switching back brings the deck's own cards and its own command zone with it.
    expect(
      screen.getByRole("button", { name: "Inspect Ghalta, Primal Hunger" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Command zone" }).closest("header"),
    ).toHaveTextContent("1 cards");
  });

  it("renders a board holding a card with no cached details", () => {
    // Not a hypothetical: `isDeckEntry` does not require `details`, so a deck written by an
    // older build hydrates without it. The board's own group header prices every card under
    // it, and it used to do that through a cast that hid the absence from the type checker —
    // the same defect that was already found and fixed once inside the statistics memo.
    const deck = createEmptyDeck(new Date("2026-01-01T00:00:00Z"));
    deck.cards = [
      {
        card: {
          oracle_id: solRing.oracle_id,
          scryfall_id: solRing.scryfall_id,
          name: solRing.name,
        },
        quantity: 2,
        section: "mainboard",
      },
    ];
    window.localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(deck));

    render(<App />);

    // The board is up, the card counts towards the deck, and its group prices at nothing
    // rather than taking the render down.
    expect(
      screen.getByRole("heading", { name: "Command zone" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 / 100")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Other" }).closest("header"),
    ).toHaveTextContent("2 cards");
  });

  it("steps back, forward, and jumps to a diff from the history panel", async () => {
    const user = userEvent.setup();
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
      },
    ];
    window.localStorage.setItem(DECK_STORAGE_KEY, JSON.stringify(deck));
    render(<App />);

    // Nothing recorded yet, so neither direction is available and the panel says so.
    const backButton = screen.getByRole("button", {
      name: "Undo last deck change",
    });
    const forwardButton = screen.getByRole("button", {
      name: "Redo next deck change",
    });
    expect(backButton).toBeDisabled();
    expect(forwardButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Deck history" }));
    const panel = screen.getByLabelText("Recorded deck history");
    expect(
      within(panel).getByText(/Nothing recorded yet/),
    ).toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", { name: "Close deck history" }),
    );

    // Three edits, so there is a past to walk.
    await user.click(
      screen.getByRole("button", { name: "Increase Sol Ring quantity" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Increase Sol Ring quantity" }),
    );
    await user.click(screen.getByRole("button", { name: "Rename deck" }));
    const deckName = screen.getByRole("textbox", { name: "Deck name" });
    await user.clear(deckName);
    await user.type(deckName, "Rocks");
    await user.keyboard("{Enter}");

    expect(screen.getByRole("heading", { name: "Rocks" })).toBeInTheDocument();
    expect(screen.getByText("3 / 100")).toBeInTheDocument();
    expect(backButton).toBeEnabled();
    expect(forwardButton).toBeDisabled();

    await user.click(backButton);
    expect(
      screen.getByRole("heading", { name: "Untitled Commander" }),
    ).toBeInTheDocument();
    // Forward is the whole point: the rename is still recorded, so it can be replayed.
    expect(forwardButton).toBeEnabled();

    await user.click(forwardButton);
    expect(screen.getByRole("heading", { name: "Rocks" })).toBeInTheDocument();
    expect(forwardButton).toBeDisabled();

    // The panel lists every recorded diff, newest first, and marks where the deck stands.
    await user.click(screen.getByRole("button", { name: "Deck history" }));
    const rows = screen.getByLabelText("Recorded deck history").querySelectorAll("li");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("renamed to Rocks");
    expect(rows[1]).toHaveTextContent("Sol Ring ×2 → ×3");
    expect(rows[2]).toHaveTextContent("Sol Ring ×1 → ×2");
    expect(rows[3]).toHaveTextContent("Before any edits");
    expect(
      within(rows[0] as HTMLElement).getByLabelText("The deck stands here"),
    ).toBeInTheDocument();

    // And clicking one moves the deck there in a single jump, across two edits at once.
    await user.click(
      within(rows[2] as HTMLElement).getByRole("button"),
    );
    expect(screen.getByText("2 / 100")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Untitled Commander" }),
    ).toBeInTheDocument();

    await user.click(
      within(
        screen.getByLabelText("Recorded deck history").querySelectorAll(
          "li",
        )[3] as HTMLElement,
      ).getByRole("button"),
    );
    // Before every edit: the card is back to the one copy the stored deck opened with, not
    // gone — a rewind is to the start of the *record*, not to an empty deck.
    expect(screen.getByText("1 / 100")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Undo last deck change" }),
    ).toBeDisabled();
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
    section: DeckSection = "mainboard",
  ): DeckCardEntry {
    return {
      card: {
        oracle_id: card.oracle_id,
        scryfall_id: card.scryfall_id,
        name: card.name,
        details: card,
      },
      quantity: 1,
      section,
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
    seedDeck({ cards: [deckEntry(gamble)] });
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
                  after: { quantity: 1, section: "mainboard" },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("makes a card the commander when the agent asks for the command zone", async () => {
    seedDeck({ cards: [] });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "This deck needs a commander.",
          changes: [
            {
              scryfall_id: ghalta.scryfall_id,
              name: ghalta.name,
              quantity: 1,
              previous_quantity: 0,
              section: "command_zone",
              card: ghalta,
            },
          ],
        },
      },
      doneFrame("Ghalta leads the deck."),
    ]);
    render(<App />);

    await ask("Pick me a commander");
    expect(await screen.findByText("Ghalta leads the deck.")).toBeInTheDocument();

    // The whole of what the user asked for: the agent could not do this at all before,
    // because the tool contract described the placement field as a custom group that
    // "has to be one that already exists" — and an empty command zone is not one.
    expect(storedDeck().cards[0].section).toBe("command_zone");
    expect(groupHeader("Command zone")).toHaveTextContent("1 cards");
    expect(screen.getByText("Applied: +1 / −0")).toBeInTheDocument();
    expect(storedHistorySessions()).toHaveLength(1);
  });

  it("leaves a commander in the command zone when the agent only changes its quantity", async () => {
    // Two copies in the command zone is illegal and the board says so — `getCommandZoneProblem`
    // reports it — but it is a state a stored deck can be in, and it is the one state where a
    // quantity change reaches a card whose section the edit says nothing about.
    seedDeck({
      cards: [{ ...deckEntry(ghalta, "command_zone"), quantity: 2 }],
    });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "One commander, one copy.",
          changes: [
            // No `section` at all, which means "leave placement alone" and never "put it
            // in the deck". Reading absent as the mainboard would take the user's
            // commander out of the command zone on an edit that never mentioned it.
            {
              scryfall_id: ghalta.scryfall_id,
              name: ghalta.name,
              quantity: 1,
              previous_quantity: 2,
              card: ghalta,
            },
          ],
        },
      },
      doneFrame("Down to one copy."),
    ]);
    render(<App />);

    await ask("Fix the command zone");
    expect(await screen.findByText("Down to one copy.")).toBeInTheDocument();

    // The quantity alone proves nothing: an applier that defaulted the section would pass
    // that assertion while quietly emptying the command zone.
    expect(storedDeck().cards[0].quantity).toBe(1);
    expect(storedDeck().cards[0].section).toBe("command_zone");
    expect(groupHeader("Command zone")).toHaveTextContent("1 cards");
  });

  it("renders an edit the deck refused as refused, keeping the undo on the one it took", async () => {
    seedDeck({
      cards: [
        {
          ...deckEntry(ghalta),
          section: "command_zone",
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
              section: "command_zone",
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
    seedDeck({ cards: [deckEntry(gamble)] });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Gamble stays where it is.",
          // Same quantity, and the section the card is already in. Nothing to do.
          changes: [
            {
              scryfall_id: gamble.scryfall_id,
              name: gamble.name,
              quantity: 1,
              previous_quantity: 1,
              section: "mainboard",
              card: gamble,
            },
          ],
        },
      },
      doneFrame("Left alone."),
    ]);
    render(<App />);

    await ask("Leave Gamble alone");
    expect(await screen.findByText("Left alone.")).toBeInTheDocument();

    // Nothing moved, so nothing is claimed. A `→ Gamble` line here would be a durable
    // claim about a card that never went anywhere.
    expect(screen.queryByText("→ Gamble")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
    expect(storedDeck().cards[0].section).toBe("mainboard");
    expect(storedHistorySessions()).toEqual([]);

    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "Gamble is the closest thing to a commander here.",
          changes: [
            {
              scryfall_id: gamble.scryfall_id,
              name: gamble.name,
              quantity: 1,
              previous_quantity: 1,
              section: "command_zone",
              card: gamble,
            },
          ],
        },
      },
      doneFrame("Moved to the command zone."),
    ]);

    await ask("Put Gamble in the command zone");
    expect(
      await screen.findByText("Moved to the command zone."),
    ).toBeInTheDocument();

    // The same shape of change, this time naming the section the card is not in: it
    // moves, it is recorded, and the block says so on its third line — the one no test
    // rendered before.
    expect(screen.getByText("Applied: +0 / −0")).toBeInTheDocument();
    expect(screen.getByText("→ Gamble")).toBeInTheDocument();
    expect(storedDeck().cards[0].section).toBe("command_zone");
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

  /** A second legal commander, so the command zone can refuse the second one on merit. */
  const korvold: CardSearchResult = {
    ...ghalta,
    oracle_id: "oracle-korvold",
    scryfall_id: "printing-korvold",
    name: "Korvold, Fae-Cursed King",
  };

  /** One `deck_edit` frame putting one card in the command zone. */
  function commanderEdit(card: CardSearchResult, reason: string) {
    return {
      type: "deck_edit",
      edit: {
        deck_name: "Gruul Stompy",
        reason,
        changes: [
          {
            scryfall_id: card.scryfall_id,
            name: card.name,
            quantity: 1,
            previous_quantity: 0,
            section: "command_zone",
            card,
          },
        ],
      },
    };
  }

  it("reaches the verdict for a second edit in one turn from the deck the first one left", async () => {
    seedDeck({ cards: [deckEntry(gamble)] });
    // One turn, two edits. The backend emits one `deck_edit` per successful `edit_deck`
    // call inside a multi-round tool loop, so two is an ordinary shape — and both frames
    // are read in a single pass of the stream, with no render in between.
    serveAgentTurn([
      commanderEdit(ghalta, "Ghalta leads this deck."),
      commanderEdit(korvold, "Korvold can lead it instead."),
      doneFrame("Ghalta is in the command zone."),
    ]);
    render(<App />);

    await ask("Give me a commander");
    expect(
      await screen.findByText("Ghalta is in the command zone."),
    ).toBeInTheDocument();

    const transcript = screen.getByRole("log", {
      name: "Deck agent conversation",
    });
    // The deck took the first edit and refused the second, because by the time it saw the
    // second one Ghalta was already in the command zone. A verdict reached against the
    // deck as it stood when the turn was sent calls that refusal an application.
    expect(within(transcript).getAllByText(/^Applied:/)).toHaveLength(1);
    expect(within(transcript).getByText("Applied: +1 / −0")).toBeInTheDocument();
    expect(
      within(transcript).getByText("+ Ghalta, Primal Hunger"),
    ).toBeInTheDocument();
    expect(within(transcript).getByText("Not applied")).toBeInTheDocument();
    expect(
      within(transcript).getByText(/cannot share the command zone with Ghalta/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("+ Korvold, Fae-Cursed King"),
    ).not.toBeInTheDocument();

    // Korvold got nowhere near the deck, and only the edit that happened was recorded.
    expect(storedDeck().cards.map((entry) => entry.card.name)).toEqual([
      "Gamble",
      "Ghalta, Primal Hunger",
    ]);
    expect(storedHistorySessions()).toHaveLength(1);
    expect(storedHistorySessions()[0].edits).toHaveLength(1);

    // One Undo, on the block whose edit is the deck's last recorded change. Left on the
    // newest block instead, it would offer to take Korvold back out and would in fact
    // take the commander the transcript says is in.
    const undo = within(transcript).getAllByRole("button", { name: "Undo" });
    expect(undo).toHaveLength(1);
    expect(
      within(transcript).getByText("Applied: +1 / −0").closest(".deck-agent__edit"),
    ).toContainElement(undo[0]);
  });

  it("restores the applied block, its undo and a refusal after a reload", async () => {
    seedDeck({ cards: [deckEntry(gamble)] });
    serveAgentTurn([
      commanderEdit(ghalta, "Ghalta leads this deck."),
      commanderEdit(korvold, "Korvold can lead it instead."),
      doneFrame("Ghalta is in the command zone."),
    ]);
    const { unmount } = render(<App />);

    await ask("Give me a commander");
    expect(
      await screen.findByText("Ghalta is in the command zone."),
    ).toBeInTheDocument();
    await waitFor(() => expect(storedHistorySessions()).toHaveLength(1));

    unmount();
    render(<App />);
    const transcript = await screen.findByRole("log", {
      name: "Deck agent conversation",
    });

    // The transcript is the durable record, and the deck's log is durable beside it. So the
    // block that happened still reads applied, the one that did not still reads refused —
    // where anything the stored transcript cannot carry would come back as an edit — and the
    // Undo is still on the block whose entry is the deck's newest recorded change.
    expect(within(transcript).getByText("Applied: +1 / −0")).toBeInTheDocument();
    expect(
      within(transcript).getByText("+ Ghalta, Primal Hunger"),
    ).toBeInTheDocument();
    expect(within(transcript).getByText("Not applied")).toBeInTheDocument();
    expect(
      within(transcript).getByText(/cannot share the command zone with Ghalta/),
    ).toBeInTheDocument();
    const undo = within(transcript).getAllByRole("button", { name: "Undo" });
    expect(undo).toHaveLength(1);
    expect(
      within(transcript).getByText("Applied: +1 / −0").closest(".deck-agent__edit"),
    ).toContainElement(undo[0]);

    // And it still reverses that edit, whole.
    await userEvent.setup().click(undo[0]);
    expect(
      screen.queryByLabelText("1 Ghalta, Primal Hunger in deck"),
    ).not.toBeInTheDocument();
  });

  it("claims nothing for an edit the deck already matched", async () => {
    // The user added the second copy while the turn was in flight, so the count the backend
    // resolved the edit against is one behind the deck. The edit is a no-op by the time the
    // deck sees it, and the copy it asked for is a copy already there.
    seedDeck({ cards: [{ ...deckEntry(gamble), quantity: 2 }] });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "A second Gamble is worth it.",
          changes: [
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
      doneFrame("Two copies now."),
    ]);
    render(<App />);

    await ask("Run a second Gamble");
    expect(await screen.findByText("Two copies now.")).toBeInTheDocument();

    // Nothing moved, so nothing is claimed and nothing is offered to reverse. No block of
    // any kind: one reading "Applied: +1 / −0 / + Gamble" would be the transcript describing
    // the request, with an Undo that takes out a copy the user put in — and one reading "Not
    // applied" would be the transcript blaming the deck for turning down an edit it took.
    const transcript = screen.getByRole("log", {
      name: "Deck agent conversation",
    });
    expect(transcript.querySelectorAll(".deck-agent__edit")).toHaveLength(0);
    expect(screen.queryByText(/^Applied:/)).not.toBeInTheDocument();
    expect(screen.queryByText("Not applied")).not.toBeInTheDocument();
    expect(screen.queryByText("+ Gamble")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(storedHistorySessions()).toEqual([]);
    expect(screen.getByLabelText("2 Gamble in deck")).toBeInTheDocument();

    // The deck's own account of the turn is the only signal, and it is the right one.
    expect(
      screen.getByText("The deck already matched that edit, so nothing changed."),
    ).toBeInTheDocument();
  });

  it("counts what the deck moved, not what the event asked for", async () => {
    // The backend resolved this against a deck holding one copy; the deck holds three,
    // because the user bumped it while the turn was in flight. So an edit whose own counts
    // say "no change at all" cuts two copies the moment the deck applies it.
    seedDeck({ cards: [{ ...deckEntry(gamble), quantity: 3 }] });
    serveAgentTurn([
      {
        type: "deck_edit",
        edit: {
          deck_name: "Gruul Stompy",
          reason: "One Gamble is enough.",
          changes: [
            {
              scryfall_id: gamble.scryfall_id,
              name: gamble.name,
              quantity: 1,
              previous_quantity: 1,
              card: gamble,
            },
          ],
        },
      },
      doneFrame("One copy is enough."),
    ]);
    render(<App />);

    await ask("How many Gambles?");
    expect(await screen.findByText("One copy is enough.")).toBeInTheDocument();
    expect(screen.getByLabelText("1 Gamble in deck")).toBeInTheDocument();

    // Counted from the deck's own diff, so the block says what the deck did — two copies
    // out — rather than the nothing the event asked for. Written from the event, this turn
    // renders no block at all while the deck changes and records the change: an edit with a
    // reversal to offer and nowhere to offer it.
    const transcript = screen.getByRole("log", {
      name: "Deck agent conversation",
    });
    expect(within(transcript).getByText("Applied: +0 / −2")).toBeInTheDocument();
    expect(within(transcript).getByText("− Gamble")).toBeInTheDocument();
    expect(storedHistorySessions()).toHaveLength(1);

    const undo = within(transcript).getAllByRole("button", { name: "Undo" });
    expect(undo).toHaveLength(1);
    expect(
      within(transcript).getByText("Applied: +0 / −2").closest(".deck-agent__edit"),
    ).toContainElement(undo[0]);

    await userEvent.setup().click(undo[0]);
    expect(screen.getByLabelText("3 Gamble in deck")).toBeInTheDocument();
  });

  it("moves the undo to whichever edit is the deck's newest recorded change", async () => {
    seedDeck({ cards: [deckEntry(gamble)] });
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

    const transcript = screen.getByRole("log", {
      name: "Deck agent conversation",
    });
    expect(
      within(transcript).getByRole("button", { name: "Undo" }),
    ).toBeInTheDocument();

    // Then the user edits the deck themselves. `undo` reverses the deck's *last recorded
    // change*, which is now the user's, so the block for the agent's edit may no longer
    // offer to reverse it: the click would take a copy of Gamble back out while claiming
    // to take Sol Ring out. The affordance goes with the edit, not with the newest block.
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Increase Gamble quantity" }),
    );
    expect(screen.getByLabelText("2 Gamble in deck")).toBeInTheDocument();
    expect(
      within(transcript).queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
    // Still one applied block: what the transcript records did not change, only what it
    // offers. The deck's own undo is where the user's own change is reversed from.
    expect(within(transcript).getByText("Applied: +1 / −0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo last deck change" }));

    // The user's change is popped, so the agent's edit is the newest recorded one again and
    // the block that describes it can offer its reversal once more.
    expect(screen.getByLabelText("1 Gamble in deck")).toBeInTheDocument();
    const restored = within(transcript).getAllByRole("button", { name: "Undo" });
    expect(restored).toHaveLength(1);
    expect(
      within(transcript).getByText("Applied: +1 / −0").closest(".deck-agent__edit"),
    ).toContainElement(restored[0]);

    await user.click(restored[0]);
    expect(screen.queryByLabelText("1 Sol Ring in deck")).not.toBeInTheDocument();
  });
});
