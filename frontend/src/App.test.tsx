import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  createEmptyDeck,
  DECK_LIBRARY_STORAGE_KEY,
  DECK_STORAGE_KEY,
  UNASSIGNED_GROUP_ID,
} from "./domain/deck";
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
