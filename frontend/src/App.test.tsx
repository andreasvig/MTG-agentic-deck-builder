import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  createEmptyDeck,
  DECK_LIBRARY_STORAGE_KEY,
  DECK_STORAGE_KEY,
  UNASSIGNED_GROUP_ID,
} from "./domain/deck";
import { cardSearchPage, gamble, ghalta } from "./test/fixtures";

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
      screen.getByRole("heading", { name: "Not assigned" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add custom group" }),
    ).toBeInTheDocument();
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
    ).toHaveValue("custom");
    expect(screen.getByRole("option", { name: "Custom" })).toBeInTheDocument();
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
});
