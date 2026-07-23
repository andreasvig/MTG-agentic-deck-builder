import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deck workspace", () => {
  it("renders the deck shell and reports a healthy backend", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          service: "mtg-agentic-deck-builder-api",
          version: "0.1.0",
        }),
        {
        status: 200,
        headers: { "Content-Type": "application/json" },
        },
      ),
    );

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Deck workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Command zone")).toBeInTheDocument();
    expect(await screen.findByText("Backend online")).toBeInTheDocument();
  });

  it("switches from category columns to the compact list", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => undefined),
    );
    const user = userEvent.setup();

    render(<App />);
    await user.click(screen.getByRole("button", { name: "List" }));

    expect(screen.getByText("No cards in mainboard")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "List" }),
    ).toHaveAttribute("aria-pressed", "true");

    act(() => {
      vi.restoreAllMocks();
    });
  });
});
