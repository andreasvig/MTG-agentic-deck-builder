import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import { CardText } from "./CardText";

function renderInStrictMode(ui: React.ReactElement) {
  return render(<StrictMode>{ui}</StrictMode>);
}

describe("CardText", () => {
  it("draws an ability's symbols and keeps its words", () => {
    const { container } = renderInStrictMode(<CardText text="{T}: Add {G}." />);

    expect(screen.getByAltText("tap this permanent")).toHaveAttribute(
      "src",
      "/card-symbols/T.svg",
    );
    expect(screen.getByAltText("one green mana")).toBeInTheDocument();
    // The braces themselves never reach the reader.
    expect(container.textContent).toBe(": Add .");
  });

  it("reads a cost aloud as mana, in the order it is written", () => {
    renderInStrictMode(<CardText text="{2}{G}{G}" />);

    expect(
      screen.getAllByRole("img").map((image) => image.getAttribute("alt")),
    ).toEqual(["two generic mana", "one green mana", "one green mana"]);
  });

  it("shows the fallback when a card has no such text, and only then", () => {
    const { container, rerender } = renderInStrictMode(
      <CardText text={null} fallback="No mana cost" />,
    );
    expect(container.textContent).toBe("No mana cost");

    rerender(
      <StrictMode>
        <CardText text="{G}" fallback="No mana cost" />
      </StrictMode>,
    );
    expect(container.textContent).toBe("");
    expect(screen.getByAltText("one green mana")).toBeInTheDocument();
  });

  it("leaves text the table does not recognise alone", () => {
    const { container } = renderInStrictMode(<CardText text="Sacrifice a Forest." />);

    expect(container.textContent).toBe("Sacrifice a Forest.");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
