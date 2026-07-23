import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../lib/api";
import { cardSearchPage } from "../test/fixtures";
import { SearchDrawer } from "./SearchDrawer";

const idleClient: ApiClient = {
  getHealth: vi.fn(),
  searchCards: vi.fn(),
};

describe("card search dialog", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("contains keyboard focus, locks scrolling, and closes with Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SearchDrawer
        entries={[]}
        client={idleClient}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={onClose}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Search cards",
    });
    expect(input).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    screen.getByRole("button", { name: "Search settings" }).focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("spinbutton", { name: "Maximum price in euros" }))
      .toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sends color, mana value, and EUR price filters with the search", async () => {
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      cardSearchPage(),
    );
    const user = userEvent.setup();
    render(
      <SearchDrawer
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Search cards" }), "ramp");
    await user.click(screen.getByRole("radio", { name: "Exact" }));
    await user.click(screen.getByRole("checkbox", { name: "Blue" }));
    await user.click(screen.getByRole("checkbox", { name: "Colorless" }));
    await user.type(
      screen.getByRole("spinbutton", { name: "Minimum mana value" }),
      "2",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Maximum mana value" }),
      "5",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Minimum price in euros" }),
      "0.25",
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Maximum price in euros" }),
      "12",
    );
    await user.click(screen.getByRole("button", { name: /^Search$/ }));

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "ramp",
        1,
        expect.any(AbortSignal),
        {
          colors: ["U"],
          includeColorless: true,
          colorMode: "exact",
          manaValueMin: 2,
          manaValueMax: 5,
          priceEurMin: 0.25,
          priceEurMax: 12,
        },
        false,
      ),
    );
  });

  it("persists the search debug setting and requests a trace", async () => {
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(
      cardSearchPage(),
    );
    const user = userEvent.setup();
    render(
      <SearchDrawer
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Search settings" }));
    await user.click(screen.getByRole("switch", { name: "Search debug log" }));
    await user.type(
      screen.getByRole("textbox", { name: "Search cards" }),
      "red card draw",
    );
    await user.click(screen.getByRole("button", { name: /^Search$/ }));

    await waitFor(() =>
      expect(searchCards).toHaveBeenLastCalledWith(
        "red card draw",
        1,
        expect.any(AbortSignal),
        expect.any(Object),
        true,
      ),
    );
    expect(window.localStorage.getItem("manabase.search-debug")).toBe("true");
  });

  it("shows the persisted layer trace when backend debug mode is enabled", async () => {
    const page = cardSearchPage();
    page.debug = {
      trace_id: "f3c7af78-93ea-4d1b-8873-0eac5b4f6c5f",
      log_path: "local-data/search-debug.jsonl",
      log_written: true,
      total_duration_ms: 742.3,
      stages: [
        {
          name: "Scryfall intent candidates",
          status: "ok",
          duration_ms: 110.2,
          input_count: null,
          output_count: 175,
        },
        {
          name: "Local semantic ranking",
          status: "ok",
          duration_ms: 632.1,
          input_count: 175,
          output_count: 175,
        },
      ],
    };
    const searchCards = vi.fn<ApiClient["searchCards"]>().mockResolvedValue(page);
    render(
      <SearchDrawer
        initialQuery="green ramp"
        entries={[]}
        client={{ getHealth: vi.fn(), searchCards }}
        onAdd={vi.fn()}
        onSetQuantity={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("Search trace")).toBeInTheDocument();
    expect(screen.getByText("742.3ms")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Search trace"));
    expect(screen.getByText("Local semantic ranking")).toBeInTheDocument();
    expect(screen.getByText("175 → 175")).toBeInTheDocument();
    expect(
      screen.getByText("local-data/search-debug.jsonl"),
    ).toBeInTheDocument();
  });
});
