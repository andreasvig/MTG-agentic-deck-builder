import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import {
  gamble,
  ghalta,
  llanowarElves,
  searchDebugSummary,
  searchPage,
  solRing,
} from "./fixtures/cards";

const SEARCH_ROUTE = "**/api/v1/cards/search**";

async function clearDeck(page: Page) {
  await page.addInitScript(() => {
    const marker = "manabase.e2e-storage-ready";
    if (!window.sessionStorage.getItem(marker)) {
      window.localStorage.clear();
      window.sessionStorage.setItem(marker, "true");
    }
  });
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "Access-Control-Allow-Origin": "http://127.0.0.1:41737",
    },
    body: JSON.stringify(body),
  });
}

async function openSearch(page: Page) {
  const trigger = page.getByRole("button", { name: "Add cards" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Find cards" }),
  ).toBeVisible();
}

async function waitForCardArt(page: Page, cardName: string) {
  const art = page.getByRole("img", { name: `${cardName} card` }).first();
  await expect(art).toBeVisible();
  await expect
    .poll(() =>
      art.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    )
    .toBe(true);
}

async function dragTo(page: Page, source: Locator, target: Locator) {
  const sourceBounds = await source.boundingBox();
  const targetBounds = await target.boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(targetBounds).not.toBeNull();
  if (!sourceBounds || !targetBounds) {
    return;
  }
  await page.mouse.move(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + Math.min(targetBounds.height / 2, 160),
    { steps: 14 },
  );
  await page.waitForTimeout(100);
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await clearDeck(page);
});

test("desktop deck-building flow remains fast and reversible", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  let outgoingQuery = "";
  await page.route(SEARCH_ROUTE, async (route) => {
    const requestUrl = new URL(route.request().url());
    outgoingQuery = requestUrl.searchParams.get("q") ?? "";
    await fulfillJson(
      route,
      searchPage(outgoingQuery, [solRing, llanowarElves]),
    );
  });

  await page.goto("/");
  await expect(
    page.getByText("Card service online", { exact: true }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Filter this deck")).toHaveCount(0);
  await expect(page.getByText("Deck inspector", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Command zone" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Not assigned" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add custom group" }),
  ).toBeVisible();
  const initialGroupBounds = await page.locator(".visual-group").first().boundingBox();
  expect(initialGroupBounds).not.toBeNull();
  expect(initialGroupBounds?.width).toBeLessThanOrEqual(240);

  await openSearch(page);
  const searchInput = page.getByRole("textbox", {
    name: "Search cards",
  });
  await searchInput.fill("Sol Ring");

  await expect(
    page.getByText("2 ranked cards", { exact: true }),
  ).toBeVisible();
  expect(outgoingQuery).toBe("Sol Ring");
  await waitForCardArt(page, "Sol Ring");
  await expect(page.getByText("Marvel Super Heroes Commander")).toBeVisible();
  const solRingResult = page
    .getByRole("article")
    .filter({ hasText: "Sol Ring" });
  await expect(solRingResult).toHaveCount(1);
  await expect(
    solRingResult.getByText("Artifact", { exact: true }),
  ).toBeVisible();
  await expect(solRingResult.getByText("MSC #211 · uncommon")).toBeVisible();

  await page
    .getByRole("button", { name: "Add Sol Ring to deck" })
    .click();
  await expect(solRingResult.getByLabel("1 in deck")).toBeVisible();
  const elvesResult = page
    .getByRole("article")
    .filter({ hasText: "Llanowar Elves" });
  await expect(elvesResult).toHaveCount(1);
  await elvesResult
    .getByRole("button", { name: "Add Llanowar Elves to deck" })
    .click();
  await expect(elvesResult.getByLabel("1 in deck")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Find cards" }),
  ).toBeVisible();

  await searchInput.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Find cards" }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Add cards" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect Llanowar Elves" }),
  ).toBeVisible();
  await waitForCardArt(page, "Llanowar Elves");

  await page.getByRole("button", { name: "Add custom group" }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill("Ramp");
  await page.getByRole("button", { name: "Create custom group" }).click();
  await expect(page.getByRole("heading", { name: "Ramp" })).toBeVisible();

  const notAssignedGroup = page.locator('[data-group-id="unassigned"]');
  const rampGroup = page
    .locator(".visual-group")
    .filter({ has: page.getByRole("heading", { name: "Ramp" }) });
  await dragTo(
    page,
    page.getByRole("button", { name: "Drag Sol Ring" }),
    rampGroup,
  );
  await expect(
    rampGroup.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toBeVisible();
  await expect(
    notAssignedGroup.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toHaveCount(0);

  await dragTo(
    page,
    page.getByRole("button", { name: "Drag Llanowar Elves" }),
    page.locator('[data-drop-target="new-group"]'),
  );
  const droppedGroupName = page.getByRole("textbox", { name: "Group name" });
  await expect(droppedGroupName).toBeFocused();
  await droppedGroupName.fill("Mana dorks");
  await page.getByRole("button", { name: "Create custom group" }).click();
  const manaDorksGroup = page
    .locator(".visual-group")
    .filter({ has: page.getByRole("heading", { name: "Mana dorks" }) });
  await expect(
    manaDorksGroup.getByRole("button", {
      name: "Inspect Llanowar Elves",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Inspect Sol Ring" }).click();
  const cardDialog = page.getByRole("dialog", { name: "Card details" });
  await expect(cardDialog).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  const modalBounds = await cardDialog.boundingBox();
  expect(modalBounds).not.toBeNull();
  expect(
    Math.abs(
      (modalBounds?.x ?? 0) +
        (modalBounds?.width ?? 0) / 2 -
        1440 / 2,
    ),
  ).toBeLessThan(3);
  const customGroupSelect = page.getByRole("combobox", {
    name: "Move Sol Ring to custom group",
  });
  await expect(customGroupSelect).toHaveValue(/group-/);
  await cardDialog
    .getByRole("button", { name: "Close card inspector" })
    .click();

  await page.getByRole("combobox", { name: "Group cards" }).selectOption("type");
  await expect(page.getByRole("button", { name: "Add custom group" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("heading", { name: "Artifact" })).toBeVisible();
  await page.getByRole("combobox", { name: "Group cards" }).selectOption("custom");

  await page.screenshot({
    path: testInfo.outputPath("desktop-populated-visual.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByLabel("Deck card list")).toBeVisible();

  const quantityInput = page.getByRole("spinbutton", {
    name: "Sol Ring quantity",
  });
  await quantityInput.fill("2");
  await expect(quantityInput).toHaveValue("2");
  await expect(page.getByText("Needs review", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove Sol Ring" }).click();
  await expect(
    page.getByRole("spinbutton", { name: "Sol Ring quantity" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Undo last deck change" })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "Sol Ring quantity" }),
  ).toBeVisible();

  await page.getByRole("combobox", { name: "Group cards" }).selectOption("type");
  await expect(page.getByRole("heading", { name: "Artifact" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Creature" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Sort cards" })
    .selectOption("price");
  await expect(
    page.getByRole("combobox", { name: "Sort cards" }),
  ).toHaveValue("price");

  await page.locator(".deck-identity strong").dblclick();
  const deckName = page.getByRole("textbox", { name: "Deck name" });
  await deckName.fill("Ramp Lab");
  await deckName.press("Enter");
  await expect(page.getByRole("heading", { name: "Ramp Lab" })).toBeVisible();
  await page.getByRole("button", { name: "Create new deck" }).click();
  await expect(
    page.getByRole("heading", { name: "Untitled Commander" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Ramp Lab/ }).click();
  await expect(page.getByRole("heading", { name: "Ramp Lab" })).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Sol Ring quantity" }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ramp Lab" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ramp", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Mana dorks", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Untitled Commander/ }),
  ).toBeVisible();
});

test("search loads 12 fuzzy results before appending the next page", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = Array.from({ length: 13 }, (_, index) => ({
    ...solRing,
    oracle_id: `pagination-oracle-${index + 1}`,
    scryfall_id: `pagination-printing-${index + 1}`,
    name: `Forest Match ${index + 1}`,
  }));
  const requestedPages: number[] = [];
  await page.route(SEARCH_ROUTE, async (route) => {
    const requestUrl = new URL(route.request().url());
    const query = requestUrl.searchParams.get("q") ?? "";
    const requestedPage = Number(requestUrl.searchParams.get("page") ?? "1");
    requestedPages.push(requestedPage);
    const response = searchPage(
      query,
      requestedPage === 1 ? cards.slice(0, 12) : cards.slice(12),
    );
    response.page = requestedPage;
    response.total_results = cards.length;
    response.has_more = requestedPage === 1;
    await fulfillJson(route, response);
  });

  await page.goto("/");
  await openSearch(page);
  await page.getByRole("textbox", { name: "Search cards" }).fill("forest");

  await expect(page.getByRole("article")).toHaveCount(12);
  await expect(
    page.getByText("13 ranked cards", { exact: true }),
  ).toBeVisible();
  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-first-12.png"),
    fullPage: true,
  });
  await loadMore.click();

  await expect(page.getByRole("article")).toHaveCount(13);
  await expect(loadMore).toHaveCount(0);
  expect(requestedPages).toEqual([1, 2]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-loaded-more.png"),
    fullPage: true,
  });
});

test("search communicates empty and provider-recovery states", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("manabase.search-debug", "true");
  });
  let providerAttempts = 0;
  await page.route(SEARCH_ROUTE, async (route) => {
    const requestUrl = new URL(route.request().url());
    const query = requestUrl.searchParams.get("q") ?? "";

    if (query.includes("provider down")) {
      providerAttempts += 1;
      if (providerAttempts === 1) {
        await fulfillJson(
          route,
          {
            detail: {
              code: "card_search_unavailable",
              message: "Scryfall is temporarily unavailable.",
            },
          },
          503,
        );
        return;
      }
      await fulfillJson(route, searchPage(query, [solRing]));
      return;
    }

    if (query === "galta") {
      const response = searchPage(query, [ghalta]);
      response.strategy = "fuzzy";
      response.interpretation = "Titles ranked locally by fuzzy similarity";
      response.name_match_scores = {
        [ghalta.scryfall_id]: 0.909091,
      };
      response.title_confidence_scores = {
        [ghalta.scryfall_id]: 0.909091,
      };
      await fulfillJson(route, response);
      return;
    }

    await fulfillJson(route, searchPage(query, []));
  });

  await page.goto("/");
  await expect(
    page.getByText("Card service online", { exact: true }),
  ).toBeVisible();
  await openSearch(page);

  const searchInput = page.getByRole("textbox", {
    name: "Search cards",
  });
  await searchInput.fill("Absolutely Not A Card");
  await expect(
    page.getByRole("heading", { name: "No cards found" }),
  ).toBeVisible();

  await searchInput.fill("galta");
  await expect(page.getByText("Title confidence 91%")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Ghalta, Primal Hunger to deck" }),
  ).toBeVisible();

  await searchInput.fill("provider down");
  await expect(page.getByRole("alert")).toContainText(
    "Scryfall is temporarily unavailable.",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("1 ranked card", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Sol Ring to deck" }),
  ).toBeVisible();
});

test("search filters shape requests without crowding the results", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let requestedUrl: URL | null = null;
  await page.route(SEARCH_ROUTE, async (route) => {
    requestedUrl = new URL(route.request().url());
    const response = searchPage(
      requestedUrl.searchParams.get("q") ?? "",
      [solRing],
    );
    if (requestedUrl.searchParams.get("debug") === "true") {
      response.debug = searchDebugSummary();
    }
    await fulfillJson(
      route,
      response,
    );
  });

  await page.goto("/");
  await openSearch(page);
  await page.getByRole("button", { name: "Search settings" }).click();
  const debugSwitch = page.getByRole("switch", {
    name: "Search debug log",
  });
  await expect(debugSwitch).not.toBeChecked();
  await debugSwitch.click();
  await expect(debugSwitch).toBeChecked();
  await page.getByRole("button", { name: "Search settings" }).click();
  await page.getByRole("radio", { name: "Exact" }).click();
  await page.getByRole("checkbox", { name: "Blue" }).click();
  await page.getByRole("checkbox", { name: "Colorless" }).click();
  await page
    .getByRole("spinbutton", { name: "Minimum mana value" })
    .fill("2");
  await page
    .getByRole("spinbutton", { name: "Maximum mana value" })
    .fill("5");
  await page
    .getByRole("spinbutton", { name: "Minimum price in euros" })
    .fill("0.25");
  await page
    .getByRole("spinbutton", { name: "Maximum price in euros" })
    .fill("12");
  await page.getByRole("textbox", { name: "Search cards" }).fill("blue ramp");

  await expect(page.getByText("1 ranked card", { exact: true })).toBeVisible();
  expect(requestedUrl).not.toBeNull();
  expect(requestedUrl?.searchParams.getAll("color")).toEqual(["U"]);
  expect(requestedUrl?.searchParams.get("include_colorless")).toBe("true");
  expect(requestedUrl?.searchParams.get("color_mode")).toBe("exact");
  expect(requestedUrl?.searchParams.get("mana_min")).toBe("2");
  expect(requestedUrl?.searchParams.get("mana_max")).toBe("5");
  expect(requestedUrl?.searchParams.get("price_min")).toBe("0.25");
  expect(requestedUrl?.searchParams.get("price_max")).toBe("12");
  expect(requestedUrl?.searchParams.get("debug")).toBe("true");
  await expect(page.getByText("Search trace")).toBeVisible();
  await page.getByText("Search trace").click();
  await expect(
    page.getByText("Local fuzzy title ranking", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Title candidates")).toBeVisible();
  await expect(
    page.getByText("rapidfuzz.WRatio", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("local-data/search-debug.jsonl"),
  ).toBeVisible();

  const filters = page.getByLabel("Card search filters");
  const filtersBounds = await filters.boundingBox();
  const dialogBounds = await page
    .getByRole("dialog", { name: "Find cards" })
    .boundingBox();
  expect(filtersBounds).not.toBeNull();
  expect(dialogBounds).not.toBeNull();
  expect(filtersBounds?.width).toBeLessThanOrEqual(dialogBounds?.width ?? 0);
  await page.screenshot({
    path: testInfo.outputPath("desktop-search-filters.png"),
    fullPage: true,
  });
});

test("commander colors warn before and after an illegal addition", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(SEARCH_ROUTE, async (route) => {
    const query =
      new URL(route.request().url()).searchParams.get("q") ?? "";
    await fulfillJson(
      route,
      searchPage(
        query,
        query.includes("Ghalta") ? [ghalta] : [gamble],
      ),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add to command zone" }).click();
  const commanderSearch = page.getByRole("textbox", {
    name: "Search cards",
  });
  await commanderSearch.fill("Ghalta");
  await expect(
    page.getByRole("button", { name: "Add Ghalta, Primal Hunger to deck" }),
  ).toBeVisible();
  await expect(
    page.getByText("Outside commander color identity"),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add Ghalta, Primal Hunger to deck" })
    .click();
  await commanderSearch.press("Escape");
  await expect(
    page.getByRole("img", { name: "Ghalta, Primal Hunger commander" }),
  ).toBeVisible();
  const commanderArt = page.getByRole("img", {
    name: "Ghalta, Primal Hunger commander",
  });
  await expect
    .poll(() =>
      commanderArt.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    )
    .toBe(true);

  await expect(
    page.getByRole("heading", { name: "Maybeboard" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Group cards" }),
  ).toHaveValue("custom");

  await openSearch(page);
  const cardSearch = page.getByRole("textbox", {
    name: "Search cards",
  });
  await cardSearch.fill("Gamble");
  await expect(
    page.getByText("Outside commander color identity"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Gamble to deck" })
    .click();
  await cardSearch.press("Escape");

  await expect(
    page.getByText("Needs review", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Color identity warning")).toBeVisible();
  await page.getByRole("button", { name: "Inspect Gamble" }).click();
  await expect(
    page.getByText(
      "R is outside this deck's G commander color identity.",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-color-warning.png"),
    fullPage: true,
  });
});

test("mobile keeps primary deck actions reachable and contained", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(SEARCH_ROUTE, async (route) => {
    const requestUrl = new URL(route.request().url());
    const query = requestUrl.searchParams.get("q") ?? "";
    const response = searchPage(query, [llanowarElves, solRing]);
    response.name_match_scores = {
      [llanowarElves.scryfall_id]: 1,
      [solRing.scryfall_id]: 0.75,
    };
    response.title_confidence_scores = {
      [llanowarElves.scryfall_id]: 1,
      [solRing.scryfall_id]: 0.75,
    };
    if (requestUrl.searchParams.get("debug") === "true") {
      response.debug = searchDebugSummary();
    }
    await fulfillJson(route, response);
  });

  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(sidebar).toHaveAttribute("inert", "");
  await expect(
    sidebar.getByRole("link", { name: "Deck editor" }),
  ).not.toBeVisible();

  const mobileToolbar = page.getByRole("navigation", {
    name: "Deck actions",
  });
  await expect(mobileToolbar).toBeVisible();
  for (const action of ["Add cards", "Layout", "Undo", "More"]) {
    await expect(
      mobileToolbar.getByRole("button", { name: action, exact: true }),
    ).toBeVisible();
  }

  await mobileToolbar
    .getByRole("button", { name: "Add cards", exact: true })
    .click();
  const searchDialog = page.getByRole("dialog", { name: "Find cards" });
  await expect(searchDialog).toBeVisible();
  await page.getByRole("button", { name: "Search settings" }).click();
  await page.getByRole("switch", { name: "Search debug log" }).click();
  await page.getByRole("button", { name: "Search settings" }).click();
  const searchInput = page.getByRole("textbox", {
    name: "Search cards",
  });
  await searchInput.fill("Llanowar Elves");
  await expect(
    page.getByRole("button", { name: "Add Llanowar Elves to deck" }),
  ).toBeVisible();
  await expect(page.getByText("Title confidence 100%")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-search-results.png"),
    fullPage: true,
  });
  await page.getByText("Search trace").click();
  await expect(
    page.getByText("Local fuzzy title ranking", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Title candidates")).toBeVisible();
  const traceBounds = await page.locator(".search-debug").boundingBox();
  expect(traceBounds).not.toBeNull();
  expect(traceBounds?.x).toBeGreaterThanOrEqual(0);
  expect(
    (traceBounds?.x ?? 0) + (traceBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("mobile-search-trace.png"),
    fullPage: false,
  });
  await page.getByText("Search trace").click();
  await page
    .getByRole("button", { name: "Add Llanowar Elves to deck" })
    .click();
  await expect(page.getByLabel("1 in deck")).toBeVisible();
  await searchInput.press("Escape");
  await expect(searchDialog).toBeHidden();
  await expect(
    mobileToolbar.getByRole("button", { name: "Add cards", exact: true }),
  ).toBeFocused();

  await page.getByRole("button", { name: "Add custom group" }).click();
  const mobileGroupInput = page.getByRole("textbox", { name: "Group name" });
  const createGroupButton = page.getByRole("button", {
    name: "Create custom group",
  });
  await expect(mobileGroupInput).toBeVisible();
  await expect(createGroupButton).toBeVisible();
  const mobileGroupInputBounds = await mobileGroupInput.boundingBox();
  const createGroupBounds = await createGroupButton.boundingBox();
  expect(mobileGroupInputBounds).not.toBeNull();
  expect(createGroupBounds).not.toBeNull();
  expect(mobileGroupInputBounds?.x).toBeGreaterThanOrEqual(0);
  expect(
    (mobileGroupInputBounds?.x ?? 0) + (mobileGroupInputBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  expect(createGroupBounds?.width).toBeGreaterThanOrEqual(40);
  expect(createGroupBounds?.height).toBeGreaterThanOrEqual(40);
  expect(
    (createGroupBounds?.x ?? 0) + (createGroupBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("mobile-custom-group-editor.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "Cancel custom group" }).click();

  await page.getByRole("button", { name: "Rename deck" }).click();
  const mobileDeckName = page.getByRole("textbox", { name: "Deck name" });
  const mobileDeckNameBounds = await mobileDeckName.boundingBox();
  expect(mobileDeckNameBounds).not.toBeNull();
  expect(mobileDeckNameBounds?.width).toBeGreaterThanOrEqual(160);
  expect(
    (mobileDeckNameBounds?.x ?? 0) + (mobileDeckNameBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  await mobileDeckName.press("Escape");

  const cardOptions = page.getByRole("button", {
    name: "Drag Llanowar Elves",
  });
  await expect(cardOptions).toBeVisible();
  const cardOptionsBounds = await cardOptions.boundingBox();
  expect(cardOptionsBounds).not.toBeNull();
  expect(
    (cardOptionsBounds?.x ?? 0) + (cardOptionsBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);

  await mobileToolbar
    .getByRole("button", { name: "More", exact: true })
    .click();
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  const createDeckButton = navigation.getByRole("button", {
    name: "Create new deck",
  });
  await expect(createDeckButton).toBeVisible();
  const createDeckBounds = await createDeckButton.boundingBox();
  expect(createDeckBounds).not.toBeNull();
  expect(createDeckBounds?.height).toBeGreaterThanOrEqual(40);
  await navigation.getByRole("button", { name: "Close navigation" }).click();

  const toolbarBounds = await mobileToolbar.boundingBox();
  expect(toolbarBounds).not.toBeNull();
  expect(toolbarBounds?.y).toBeGreaterThanOrEqual(0);
  expect((toolbarBounds?.y ?? 0) + (toolbarBounds?.height ?? 0)).toBeLessThanOrEqual(
    844,
  );

  await page
    .getByRole("button", { name: "Inspect Llanowar Elves" })
    .click();
  const inspector = page.getByRole("dialog", { name: "Card details" });
  await expect(inspector).toBeVisible();
  await expect(
    inspector.getByRole("heading", { name: "Llanowar Elves" }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await inspector.boundingBox();
      return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(390);
  const inspectorBounds = await inspector.boundingBox();
  expect(inspectorBounds).not.toBeNull();
  expect(inspectorBounds?.x).toBeGreaterThanOrEqual(0);
  expect(
    (inspectorBounds?.x ?? 0) + (inspectorBounds?.width ?? 0),
  ).toBeLessThanOrEqual(390);

  const pageDimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(pageDimensions.scrollWidth).toBeLessThanOrEqual(
    pageDimensions.clientWidth,
  );
  expect(pageDimensions.bodyScrollWidth).toBeLessThanOrEqual(
    pageDimensions.clientWidth,
  );

  await waitForCardArt(page, "Llanowar Elves");
  await page.screenshot({
    path: testInfo.outputPath("mobile-populated-inspector.png"),
    fullPage: false,
  });
});
