import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { createEmptyDeck, DECK_STORAGE_KEY } from "./domain/deck";
import { cardSearchPage, counterspell, ghalta } from "./test/fixtures";

const healthResponse = {
  status: "ok",
  service: "mtg-agentic-deck-builder-api",
  version: "0.1.0",
};

beforeEach(() => {
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
  it("builds, validates, filters, persists, and undoes a local deck", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Start with your commander" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Backend online")).toBeInTheDocument();

    const searchTrigger = screen.getByRole("button", { name: "Card search" });
    await user.click(searchTrigger);
    const dialog = screen.getByRole("dialog", { name: "Find cards" });
    const input = screen.getByRole("textbox", {
      name: "Search card name or Scryfall syntax",
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

    await user.type(
      screen.getByRole("textbox", { name: "Filter cards in this deck" }),
      "forest",
    );
    expect(
      screen.getByRole("heading", { name: "No cards match “forest”" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear local filter" }));

    await user.click(
      screen.getByRole("button", { name: "Undo last deck change" }),
    );
    expect(screen.queryByText("Needs review")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 100")).toBeInTheDocument();

    await waitFor(() => {
      expect(window.localStorage.getItem(DECK_STORAGE_KEY)).toContain(
        '"name":"Sol Ring"',
      );
    });
  });

  it("opens full search from the toolbar instead of auto-adding", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByRole("textbox", { name: "Search cards from toolbar" }),
      "Sol Ring",
    );
    await user.keyboard("{Enter}");

    expect(
      await screen.findByRole("dialog", { name: "Find cards" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Add Sol Ring to deck" }),
    ).toBeInTheDocument();
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
          Response.json(cardSearchPage([counterspell]), { status: 200 }),
        );
      }
      return Promise.resolve(Response.json(healthResponse, { status: 200 }));
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Card search" }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Search card name or Scryfall syntax",
      }),
      "Counterspell",
    );
    expect(
      await screen.findByText("Outside commander color identity"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Add Counterspell to deck" }),
    );
    await user.keyboard("{Escape}");

    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByLabelText("Color identity warning")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Maybeboard" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Inspect Counterspell" }),
    );
    expect(
      screen.getByText(
        "U is outside this deck's G commander color identity.",
      ),
    ).toBeInTheDocument();
  });
});
