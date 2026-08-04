import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { CardSearchResult } from "../domain/card";
import type { Deck, DeckCardEntry, DeckSection } from "../domain/deck";
import { counterspell, ghalta, solRing } from "../test/fixtures";
import { ExportDeckDialog } from "./ExportDeckDialog";

function entry(
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

const deck: Deck = {
  id: "deck-1",
  name: "Ghalta Stompy",
  description: "",
  format: "commander",
  cards: [entry(ghalta, "command_zone"), entry(solRing), entry(counterspell)],
  created_at: "2026-08-01T09:00:00.000Z",
  updated_at: "2026-08-01T09:05:00.000Z",
};

/**
 * Install a clipboard spy — **after** `userEvent.setup()`, never before.
 *
 * `setup()` installs a working `navigator.clipboard` stub of its own, so a spy defined
 * ahead of it is silently replaced and every assertion about `writeText` fails on a call
 * that did happen.
 */
function useClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

function preview(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

it("shows the plain-text list first, because that is what a shop takes", () => {
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  expect(preview().value).toBe(
    ["1 Ghalta, Primal Hunger", "1 Counterspell", "1 Sol Ring"].join("\n"),
  );
});

it("switches the preview to the chosen format", async () => {
  const user = userEvent.setup();
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "MTG Arena" }));

  expect(preview().value).toBe(
    [
      "Commander",
      "1 Ghalta, Primal Hunger (RIX) 130",
      "",
      "Deck",
      "1 Counterspell (MH2) 267",
      "1 Sol Ring (CMM) 396",
    ].join("\n"),
  );
});

it("copies the format currently on screen, not the one it opened on", async () => {
  const user = userEvent.setup();
  const writeText = useClipboard();
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "CSV" }));
  await user.click(screen.getByRole("button", { name: /copy/i }));

  expect(writeText).toHaveBeenCalledWith(preview().value);
  expect(writeText.mock.calls[0][0]).toContain("Quantity,Name,Set");
});

it("confirms a copy, and stops confirming it once the format changes", async () => {
  const user = userEvent.setup();
  useClipboard();
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: /copy/i }));
  expect(await screen.findByRole("button", { name: /copied/i })).toBeVisible();

  // The label describes what is on the clipboard. Another format is not on it.
  await user.click(screen.getByRole("button", { name: "MTG Arena" }));
  expect(screen.getByRole("button", { name: /^copy$/i })).toBeVisible();
});

it("selects the list instead of failing when the clipboard refuses", async () => {
  const user = userEvent.setup();
  useClipboard(vi.fn().mockRejectedValue(new Error("denied")));
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: /copy/i }));

  const textarea = preview();
  await waitFor(() =>
    expect(textarea.selectionEnd).toBe(textarea.value.length),
  );
  expect(textarea.selectionStart).toBe(0);
  expect(screen.queryByRole("button", { name: /copied/i })).toBeNull();
});

it("links a prefilled TCGplayer cart holding every card", () => {
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  const link = screen.getByRole("link", { name: /buy on tcgplayer/i });
  expect(link).toHaveAttribute(
    "href",
    "https://www.tcgplayer.com/massentry?productline=Magic" +
      "&c=1%20Ghalta%2C%20Primal%20Hunger%7C%7C1%20Counterspell%7C%7C1%20Sol%20Ring",
  );
  expect(link).toHaveAttribute("target", "_blank");
});

it("keeps the TCGplayer cart on the buyable list even while another format is shown", async () => {
  const user = userEvent.setup();
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: "MTG Arena" }));

  // A "Commander" heading in the `c` parameter is a card TCGplayer tries to sell.
  const link = screen.getByRole("link", { name: /buy on tcgplayer/i });
  expect(link.getAttribute("href")).not.toContain("Commander");
});

it("counts the cards it is about to export", () => {
  render(<ExportDeckDialog deck={deck} onClose={vi.fn()} />);

  expect(screen.getByText(/^3 cards\./)).toBeVisible();
});

it("closes on Escape", async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<ExportDeckDialog deck={deck} onClose={onClose} />);

  await user.keyboard("{Escape}");

  expect(onClose).toHaveBeenCalledTimes(1);
});
