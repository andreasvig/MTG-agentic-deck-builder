import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { DECK_STORAGE_KEY } from "./domain/deck";
import { cardSearchPage } from "./test/fixtures";

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

    const searchTrigger = screen.getByRole("button", {
      name: "Search cards",
    });
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

  it("opens full search when quick add returns no card", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/cards/search")) {
        return Promise.resolve(
          Response.json(cardSearchPage([], 'name:"Unknown"'), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(Response.json(healthResponse, { status: 200 }));
    });
    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByRole("textbox", { name: "Quick add card" }),
      "Unknown",
    );
    await user.keyboard("{Enter}");

    expect(
      await screen.findByRole("dialog", { name: "Find cards" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "No cards found" }),
    ).toBeInTheDocument();
  });
});
