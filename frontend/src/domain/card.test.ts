import { describe, expect, it } from "vitest";

import { isBasicLand } from "./card";
import { solRing } from "../test/fixtures";

describe("card domain", () => {
  it("recognizes regular and snow-covered basic lands", () => {
    expect(
      isBasicLand({ ...solRing, type_line: "Basic Land — Forest" }),
    ).toBe(true);
    expect(
      isBasicLand({ ...solRing, type_line: "Basic Snow Land — Island" }),
    ).toBe(true);
    expect(
      isBasicLand({ ...solRing, type_line: "Legendary Land — Cave" }),
    ).toBe(false);
  });
});
