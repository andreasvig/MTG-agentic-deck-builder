import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../lib/api";
import { solRing } from "../test/fixtures";
import { AgentAnswer } from "./AgentAnswer";

const LINKS = [{ name: "Sol Ring", oracle_id: "oracle-sol-ring" }];

function clientWith(getCard = vi.fn().mockResolvedValue(solRing)) {
  return { getCard } as unknown as ApiClient & { getCard: typeof getCard };
}

/**
 * Render the way the application does — inside StrictMode.
 *
 * Without it these tests pass over a component whose effects only ever run once.
 * StrictMode mounts, cleans up and mounts again, which is how a live-ref flag that
 * is cleared but never set caught every preview in the real browser and nothing
 * here. Anything mounted in `main.tsx` should be tested the same way it ships.
 */
function renderInStrictMode(ui: React.ReactElement) {
  return render(<StrictMode>{ui}</StrictMode>);
}

describe("AgentAnswer", () => {
  it("shows the card image on hover and takes it away again", async () => {
    const user = userEvent.setup();
    renderInStrictMode(<AgentAnswer text="Play {Sol Ring}." links={LINKS} client={clientWith()} />);

    const name = screen.getByRole("button", { name: "Sol Ring" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.hover(name);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
    expect(screen.getByRole("tooltip")).toContainElement(
      screen.getByAltText("Sol Ring card"),
    );

    await user.unhover(name);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens the same preview from the keyboard", async () => {
    const user = userEvent.setup();
    renderInStrictMode(<AgentAnswer text="Play {Sol Ring}." links={LINKS} client={clientWith()} />);

    // A card the mouse can preview must be previewable without one, which is why
    // the name is a button rather than a styled span.
    await user.tab();
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
  });

  it("fetches a card once however many times it is hovered", async () => {
    const user = userEvent.setup();
    const getCard = vi.fn().mockResolvedValue(solRing);
    renderInStrictMode(
      <AgentAnswer
        text="{Sol Ring} is fast, so play {Sol Ring}."
        links={LINKS}
        client={clientWith(getCard)}
      />,
    );

    const [first, second] = screen.getAllByRole("button", { name: "Sol Ring" });
    await user.hover(first);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());
    await user.unhover(first);
    await user.hover(second);
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument());

    // Both names are the same card, and the cache is shared across the message.
    expect(getCard).toHaveBeenCalledTimes(1);
  });

  it("hands the fetched card to the opener on click", async () => {
    const user = userEvent.setup();
    const onOpenCard = vi.fn();
    renderInStrictMode(
      <AgentAnswer
        text="Play {Sol Ring}."
        links={LINKS}
        client={clientWith()}
        onOpenCard={onOpenCard}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sol Ring" }));

    await waitFor(() => expect(onOpenCard).toHaveBeenCalledWith(solRing));
    // Clicking through to the card means the hover preview has done its job.
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders an unresolved name as text with nothing to press", () => {
    renderInStrictMode(<AgentAnswer text="Try {Sol Rong}." links={LINKS} client={clientWith()} />);

    expect(screen.getByText("Sol Rong")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    // Above all: the reader never sees the braces the agent typed.
    expect(screen.queryByText(/[{}]/)).toBeNull();
  });

  it("draws mana symbols in the answer and still reads bold", () => {
    const { container } = renderInStrictMode(
      <AgentAnswer
        text="**Sol Ring** taps for {C}{C}."
        links={LINKS}
        client={clientWith()}
      />,
    );

    // Emphasis now wraps tokens rather than a string, so the text sits inside it.
    expect(screen.getByText("Sol Ring").closest("strong")).not.toBeNull();
    expect(screen.getAllByAltText("one colorless mana")).toHaveLength(2);
    // The agent typed braces; the reader sees symbols and never a brace.
    expect(container.textContent).toBe("Sol Ring taps for .");
  });

  it("keeps the sentence readable when the preview cannot be fetched", async () => {
    const user = userEvent.setup();
    const getCard = vi.fn().mockRejectedValue(new Error("offline"));
    renderInStrictMode(
      <AgentAnswer text="Play {Sol Ring}." links={LINKS} client={clientWith(getCard)} />,
    );

    await user.hover(screen.getByRole("button", { name: "Sol Ring" }));

    // A failed image is not worth an error message inside a sentence.
    await waitFor(() => expect(getCard).toHaveBeenCalled());
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("button", { name: "Sol Ring" })).toBeInTheDocument();
  });
});
