import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../lib/api";
import { SearchDrawer } from "./SearchDrawer";

const idleClient: ApiClient = {
  getHealth: vi.fn(),
  searchCards: vi.fn(),
};

describe("card search dialog", () => {
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
      name: "Search card name or Scryfall syntax",
    });
    expect(input).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    screen.getByRole("button", { name: /^Search$/ }).focus();
    await user.tab();
    expect(
      screen
        .getByRole("dialog", { name: "Find cards" })
        .querySelector("button"),
    ).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
