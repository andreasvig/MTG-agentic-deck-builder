import { expect, test, type Page, type Route } from "@playwright/test";

import {
  gamble,
  ghalta,
  llanowarElves,
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
  const trigger = page.getByRole("button", { name: "Card search" });
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
  await expect(page.getByText("Backend online", { exact: true })).toBeVisible();
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
    name: "Search card name or Scryfall syntax",
  });
  await searchInput.fill("Sol Ring");

  await expect(page.getByText("2 results", { exact: true })).toBeVisible();
  expect(outgoingQuery).toBe('name:"Sol Ring"');
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
    page.getByRole("button", { name: "Card search" }),
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

  await page.getByRole("button", { name: "Inspect Sol Ring" }).click();
  const customGroupSelect = page.getByRole("combobox", {
    name: "Move Sol Ring to custom group",
  });
  await expect(customGroupSelect).toHaveValue("unassigned");
  await customGroupSelect.selectOption({ label: "Ramp" });
  await expect(customGroupSelect).toHaveValue(/group-/);
  await page.getByRole("combobox", { name: "Group cards" }).selectOption("type");
  await expect(customGroupSelect).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add custom group" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("heading", { name: "Artifact" })).toBeVisible();
  await page.getByRole("combobox", { name: "Group cards" }).selectOption("custom");
  await page.getByRole("button", { name: "Close card inspector" }).click();

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

  await page.getByRole("textbox", { name: "Filter cards in this deck" }).fill(
    "elf",
  );
  await expect(
    page.getByRole("spinbutton", { name: "Llanowar Elves quantity" }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", { name: "Sol Ring quantity" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear local filter" }).click();
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
    page.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Untitled Commander/ }),
  ).toBeVisible();
});

test("search communicates empty and provider-recovery states", async ({
  page,
}) => {
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

    await fulfillJson(route, searchPage(query, []));
  });

  await page.goto("/");
  await expect(page.getByText("Backend online", { exact: true })).toBeVisible();
  await openSearch(page);

  const searchInput = page.getByRole("textbox", {
    name: "Search card name or Scryfall syntax",
  });
  await searchInput.fill("Absolutely Not A Card");
  await expect(
    page.getByRole("heading", { name: "No cards found" }),
  ).toBeVisible();

  await searchInput.fill("provider down");
  await expect(page.getByRole("alert")).toContainText(
    "Scryfall is temporarily unavailable.",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("1 results", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Sol Ring to deck" }),
  ).toBeVisible();
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
    name: "Search card name or Scryfall syntax",
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
    name: "Search card name or Scryfall syntax",
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
    const query =
      new URL(route.request().url()).searchParams.get("q") ?? "";
    await fulfillJson(route, searchPage(query, [llanowarElves, solRing]));
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
  for (const action of ["Search", "Layout", "Undo", "More"]) {
    await expect(
      mobileToolbar.getByRole("button", { name: action, exact: true }),
    ).toBeVisible();
  }

  await mobileToolbar
    .getByRole("button", { name: "Search", exact: true })
    .click();
  const searchDialog = page.getByRole("dialog", { name: "Find cards" });
  await expect(searchDialog).toBeVisible();
  const searchInput = page.getByRole("textbox", {
    name: "Search card name or Scryfall syntax",
  });
  await searchInput.fill("Llanowar Elves");
  await expect(
    page.getByRole("button", { name: "Add Llanowar Elves to deck" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Llanowar Elves to deck" })
    .click();
  await expect(page.getByLabel("1 in deck")).toBeVisible();
  await searchInput.press("Escape");
  await expect(searchDialog).toBeHidden();
  await expect(
    mobileToolbar.getByRole("button", { name: "Search", exact: true }),
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
    name: "Inspect and move Llanowar Elves",
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
  const inspector = page.getByRole("dialog", { name: "Card inspector" });
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
