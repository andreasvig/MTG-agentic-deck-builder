import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import {
  failedAgentSearchDebugSummary,
  counterspell,
  gamble,
  ghalta,
  llanowarElves,
  manaVault,
  searchDebugSummary,
  searchPage,
  solRing,
  emptyEnrichment,
  solRingEnrichment,
  thrasios,
  tymna,
} from "./fixtures/cards";

const SEARCH_ROUTE = "**/api/v1/cards/search**";
const SUBTYPE_ROUTE = "**/api/v1/cards/subtypes/search**";
const ENRICHMENT_ROUTE = "**/api/v1/cards/*/enrichment";
const EDHREC_SIMILAR_ROUTE = "**/api/v1/cards/*/edhrec/similar";

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

/**
 * Answer a streamed agent turn with server-sent events.
 *
 * Playwright fulfils a route with one whole body, so this proves the wire format
 * and the parsing end to end rather than the timing. Incremental rendering is
 * covered where it can be driven event by event: the panel's own tests.
 */
async function fulfillSse(route: Route, events: unknown[]) {
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: {
      "Access-Control-Allow-Origin": "http://127.0.0.1:41737",
      "Cache-Control": "no-store",
    },
    body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  });
}

/**
 * Replace only the deck-agent stream fetch with browser-owned streams the test can advance.
 *
 * `route.fulfill` hands Chromium one completed body, which is enough for wire-format tests but
 * cannot leave two replies open or put a tool line on screen before Escape. This lives in the
 * page instead: the application still runs its real fetch reader against a real
 * `ReadableStream`, while the test decides which deck receives the next frame and when the
 * connection ends.
 */
async function installOpenAgentStreams(page: Page) {
  await page.addInitScript(() => {
    interface AgentStreamHarness {
      requests: unknown[];
      controllers: Array<ReadableStreamDefaultController<Uint8Array>>;
      push: (index: number, event: unknown) => void;
      close: (index: number) => void;
    }
    type HarnessWindow = Window & { __agentStreamHarness?: AgentStreamHarness };

    const realFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const harness: AgentStreamHarness = {
      requests: [],
      controllers: [],
      push(index, event) {
        const controller = this.controllers[index];
        if (!controller) {
          throw new Error(`agent stream ${index} was never opened`);
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      },
      close(index) {
        const controller = this.controllers[index];
        if (!controller) {
          throw new Error(`agent stream ${index} was never opened`);
        }
        controller.close();
      },
    };
    (window as HarnessWindow).__agentStreamHarness = harness;
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes("/api/v1/agent/chat/stream")) {
        return realFetch(input, init);
      }
      harness.requests.push(JSON.parse(String(init?.body ?? "{}")));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          harness.controllers.push(controller);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
  });
}

async function openAgentRequestCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const held = window as Window & {
      __agentStreamHarness?: { requests: unknown[] };
    };
    return held.__agentStreamHarness?.requests.length ?? 0;
  });
}

async function openAgentRequests(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const held = window as Window & {
      __agentStreamHarness?: { requests: unknown[] };
    };
    return held.__agentStreamHarness?.requests ?? [];
  });
}

async function pushAgentFrame(page: Page, index: number, event: unknown) {
  await page.evaluate(
    ([streamIndex, frame]) => {
      const held = window as Window & {
        __agentStreamHarness?: {
          push: (index: number, event: unknown) => void;
        };
      };
      held.__agentStreamHarness?.push(streamIndex, frame);
    },
    [index, event] as const,
  );
}

async function closeAgentStream(page: Page, index: number) {
  await page.evaluate((streamIndex) => {
    const held = window as Window & {
      __agentStreamHarness?: { close: (index: number) => void };
    };
    held.__agentStreamHarness?.close(streamIndex);
  }, index);
}

/** Two named decks, each with one commander, without spending the test on setup UI. */
async function seedTwoAgentDecks(page: Page) {
  await page.addInitScript(
    ([firstCommander, secondCommander, rock, answer]) => {
      const entry = (
        card: typeof firstCommander,
        section: "command_zone" | "mainboard",
      ) => ({
        card: {
          oracle_id: card.oracle_id,
          scryfall_id: card.scryfall_id,
          name: card.name,
          details: card,
        },
        quantity: 1,
        section,
      });
      const now = "2026-08-03T15:00:00.000Z";
      const decks = [
        {
          id: "e2e-deck-a",
          name: "Ghalta Ramp",
          format: "commander",
          cards: [entry(firstCommander, "command_zone"), entry(rock, "mainboard")],
          created_at: now,
          updated_at: now,
        },
        {
          id: "e2e-deck-b",
          name: "Atraxa Control",
          format: "commander",
          cards: [entry(secondCommander, "command_zone"), entry(answer, "mainboard")],
          created_at: now,
          updated_at: now,
        },
      ];
      window.localStorage.setItem(
        "manabase.deck-library.v2",
        JSON.stringify({ active_deck_id: decks[0].id, decks }),
      );
    },
    [
      ghalta,
      {
        ...ghalta,
        oracle_id: counterspell.oracle_id,
        scryfall_id: counterspell.scryfall_id,
        name: "Atraxa, Praetors' Voice",
        type_line: "Legendary Creature — Phyrexian Angel Horror",
      },
      solRing,
      counterspell,
    ],
  );
}

async function openSearch(page: Page) {
  const trigger = page.getByRole("button", { name: "Add cards" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Find cards" }),
  ).toBeVisible();
}

/**
 * Turn on debug mode from the interface settings.
 *
 * It lives in the editor toolbar, which is inert while the search drawer is open,
 * so this has to happen before any dialog is opened.
 */
async function enableDebugMode(page: Page) {
  const settings = page.getByRole("button", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.click();
  const debugSwitch = page.getByRole("switch", { name: "Debug mode" });
  await expect(debugSwitch).not.toBeChecked();
  await debugSwitch.click();
  await expect(debugSwitch).toBeChecked();
  await settings.click();
  await expect(debugSwitch).toBeHidden();
}

/**
 * Assert the trace summary is still one row, and that a price shows every digit.
 *
 * The badges in that row are conditional — only a search that called a model
 * reports a price — and a layout with one fixed column per child wrapped the
 * chevron onto a second row and clipped the price into the chevron's 14px track.
 * jsdom computes no layout, so this can only be caught in a real browser.
 */
async function expectTraceSummaryOnOneRow(page: Page) {
  const summary = page.locator(".search-debug > summary").first();
  await expect(summary).toBeVisible();
  const layout = await summary.evaluate((element) => {
    const cost = element.querySelector(".search-debug__cost");
    return {
      tops: Array.from(element.children).map((child) =>
        Math.round(child.getBoundingClientRect().top),
      ),
      cost: cost
        ? { clientWidth: cost.clientWidth, scrollWidth: cost.scrollWidth }
        : null,
    };
  });
  expect(Math.max(...layout.tops) - Math.min(...layout.tops)).toBeLessThanOrEqual(
    8,
  );
  if (layout.cost) {
    expect(layout.cost.scrollWidth).toBeLessThanOrEqual(layout.cost.clientWidth);
  }
}

/**
 * Assert an expandable tool call is one row, with its signature readable.
 *
 * Same failure mode as the trace summary above: the "failed" marker is a
 * conditional child, so the row has to survive a changing child count without
 * wrapping or squeezing the signature into nothing. Only the leftover width may
 * be taken from the signature — never all of it.
 */
async function expectToolSummaryOnOneRow(page: Page) {
  const summary = page.locator(".deck-agent__tool-call > summary").first();
  await expect(summary).toBeVisible();
  const layout = await summary.evaluate((element) => {
    const signature = element.querySelector(".deck-agent__tool-signature");
    return {
      tops: Array.from(element.children).map((child) =>
        Math.round(child.getBoundingClientRect().top),
      ),
      signatureWidth: signature ? signature.getBoundingClientRect().width : 0,
    };
  });
  expect(Math.max(...layout.tops) - Math.min(...layout.tops)).toBeLessThanOrEqual(
    8,
  );
  expect(layout.signatureWidth).toBeGreaterThan(40);
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
  // Scrolled into view *before* either box is measured. `page.mouse.move` takes viewport
  // coordinates and `boundingBox` returns page ones, so a handle below the fold is a
  // mouse-down on empty space and a drag that silently never starts. The Command zone
  // column is tall enough that scrolling the card into view leaves the target reachable.
  await source.scrollIntoViewIfNeeded();
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
  // The list's handles are dnd-kit, which suppresses the click following a pointer-up on
  // a draggable node and drops that suppression a tick later. Without this the first
  // click after any drag is swallowed — including a click on the card's own art.
  await page.waitForTimeout(150);
}

test.beforeEach(async ({ page }) => {
  await clearDeck(page);
  // EDHREC similar cards are fetched from a live community host for whichever card
  // the interface highlights. Left unstubbed, these tests would depend on that
  // service and on whatever the local sidecar happens to have cached, which is how
  // a real Sol Ring response once made "Mana Vault" ambiguous in the panel.
  await page.route(EDHREC_SIMILAR_ROUTE, async (route) => {
    const oracleId = new URL(route.request().url()).pathname.split("/").at(-3);
    await fulfillJson(route, {
      status: "not_requested",
      source: null,
      oracle_id: oracleId,
      cards: [],
      message: null,
    });
  });
});

test("desktop deck-building flow remains fast and reversible", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  let outgoingQuery = "";
  let outgoingTag = "";
  await page.route(SEARCH_ROUTE, async (route) => {
    const requestUrl = new URL(route.request().url());
    outgoingQuery = requestUrl.searchParams.get("q") ?? "";
    outgoingTag = requestUrl.searchParams.get("tag") ?? "";
    await fulfillJson(
      route,
      searchPage(outgoingQuery, [solRing, llanowarElves]),
    );
  });
  await page.route(ENRICHMENT_ROUTE, async (route) => {
    const oracleId = new URL(route.request().url()).pathname
      .split("/")
      .at(-2);
    await fulfillJson(
      route,
      oracleId === solRing.oracle_id
        ? solRingEnrichment
        : emptyEnrichment(oracleId ?? ""),
    );
  });
  await page.route(
    `**/api/v1/cards/${manaVault.oracle_id}`,
    async (route) => {
      await fulfillJson(route, manaVault);
    },
  );

  await page.goto("/");
  await expect(
    page.getByText("Card service online", { exact: true }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Filter this deck")).toHaveCount(0);
  await expect(page.getByText("Deck inspector", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Command zone" }),
  ).toBeVisible();
  // One grouping, derived from the cards: no mode to choose, no group to create, and no
  // heading for cards belonging to no group (ADR 0037).
  await expect(
    page.getByRole("heading", { name: "Not assigned" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add custom group" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Group cards" }),
  ).toHaveCount(0);
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
  await expect(
    page.getByRole("region", { name: "Card tags and related cards" }),
  ).toBeVisible();
  await expect(page.getByText("mana rock", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Show non-Commander-legal cards",
    }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "Show cards outside commander color identity",
    }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Mana Vault" }).click();
  const relatedCardDialog = page.getByRole("dialog", {
    name: "Card details",
  });
  await expect(relatedCardDialog).toBeVisible();
  await expect(
    relatedCardDialog.getByRole("heading", { name: "Mana Vault" }),
  ).toBeVisible();
  await expect(
    relatedCardDialog.getByRole("button", {
      name: "Add to deck",
    }),
  ).toBeVisible();
  await relatedCardDialog
    .getByRole("button", { name: "Close card inspector" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Find cards" }),
  ).toBeVisible();
  await expect(solRingResult).toHaveCount(1);

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

  // Drag is on in the only view there is, and the command zone is the one thing it can
  // mean. In a real browser, because jsdom computes no layout and a drop target with no
  // geometry cannot be dropped on — and because this is a *native* drag now, dispatched
  // by the browser off the card's own art rather than by a library off a handle.
  const commandZone = page.locator('[data-group-id="command_zone"]');
  const artifactGroup = page.locator('[data-group-id="type-Artifact"]');
  await dragTo(
    page,
    page.getByRole("button", { name: "Inspect Sol Ring" }),
    commandZone,
  );
  await expect(
    commandZone.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toBeVisible();
  await expect(
    artifactGroup.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toHaveCount(0);

  // And dropping it on a card-type heading puts it back in the deck, which is the only
  // thing such a drop can mean.
  await dragTo(
    page,
    page.getByRole("button", { name: "Inspect Sol Ring" }),
    page.locator('[data-group-id="type-Creature"]'),
  );
  await expect(
    page
      .locator('[data-group-id="type-Artifact"]')
      .getByRole("button", { name: "Inspect Sol Ring" }),
  ).toBeVisible();
  await expect(
    commandZone.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toHaveCount(0);

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
  const placementSelect = page.getByRole("combobox", {
    name: "Move Sol Ring to another part of the deck",
  });
  await expect(placementSelect).toHaveValue("mainboard");
  await expect(
    cardDialog.getByRole("region", { name: "Card tags and related cards" }),
  ).toBeVisible();
  await cardDialog.getByRole("button", { name: "mana rock" }).click();
  const tagSearchDialog = page.getByRole("dialog", { name: "Find cards" });
  await expect(tagSearchDialog).toBeVisible();
  await expect(
    tagSearchDialog.getByRole("button", {
      name: "Remove mana rock tag",
    }),
  ).toBeVisible();
  await expect.poll(() => outgoingTag).toBe("tag-mana-rock");
  await tagSearchDialog
    .getByRole("button", { name: "Close card search" })
    .click();

  await expect(page.getByRole("heading", { name: "Artifact" })).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Artifact" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Creature" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect Sol Ring" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Untitled Commander/ }),
  ).toBeVisible();

  // Travel survives the reload, which is the whole reason the position is stored beside
  // the log rather than held in memory (ADR 0038).
  const backButton = page.getByRole("button", {
    name: "Undo last deck change",
  });
  const forwardButton = page.getByRole("button", {
    name: "Redo next deck change",
  });
  await expect(backButton).toBeEnabled();
  await backButton.click();
  await expect(forwardButton).toBeEnabled();
  await forwardButton.click();
  await expect(forwardButton).toBeDisabled();

  // And the panel between them lists the recorded diffs and jumps to one.
  await page.getByRole("button", { name: "Deck history" }).click();
  const historyPanel = page.getByLabel("Recorded deck history");
  await expect(historyPanel).toBeVisible();
  await expect(historyPanel.getByText("renamed to Ramp Lab")).toBeVisible();
  await expect(
    historyPanel.getByLabel("The deck stands here"),
  ).toHaveCount(1);
  await historyPanel.getByText("Before any edits").click();
  await expect(backButton).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "Untitled Commander" }).first(),
  ).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath("desktop-history-panel.png"),
    fullPage: true,
  });
});

test("search loads six fuzzy results before appending the next page", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cards = Array.from({ length: 7 }, (_, index) => ({
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
      requestedPage === 1 ? cards.slice(0, 6) : cards.slice(6),
    );
    response.page = requestedPage;
    response.total_results = cards.length;
    response.has_more = requestedPage === 1;
    await fulfillJson(route, response);
  });

  await page.goto("/");
  await openSearch(page);
  await page.getByRole("textbox", { name: "Search cards" }).fill("forest");

  await expect(page.getByRole("article")).toHaveCount(6);
  await expect(
    page.getByText("7 ranked cards", { exact: true }),
  ).toBeVisible();
  const loadMore = page.getByRole("button", { name: "Load more" });
  await expect(loadMore).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-first-6.png"),
    fullPage: true,
  });
  await loadMore.click();

  await expect(page.getByRole("article")).toHaveCount(7);
  await expect(loadMore).toBeVisible();
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

test("failed agentic search keeps the trace open at the broken step", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    window.localStorage.setItem("manabase.search-debug", "true");
  });
  await page.route(SEARCH_ROUTE, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname.endsWith("/search/agentic")) {
      await fulfillJson(
        route,
        {
          detail: {
            code: "agentic_search_unavailable",
            message: "Agentic card search is temporarily unavailable.",
            debug: failedAgentSearchDebugSummary(),
          },
        },
        503,
      );
      return;
    }

    const response = searchPage(
      requestUrl.searchParams.get("q") ?? "",
      [],
    );
    response.agentic_required = true;
    response.interpretation =
      "Confident title matches shown while agentic search continues";
    await fulfillJson(route, response);
  });

  await page.goto("/");
  await openSearch(page);
  await page
    .getByRole("textbox", { name: "Search cards" })
    .fill("green big creature");

  await expect(
    page.getByRole("heading", { name: "Search could not finish" }),
  ).toBeVisible();
  await expect(
    page.getByText("Agentic card search is temporarily unavailable."),
  ).toBeVisible();
  await expect(page.getByText("Search stopped here")).toBeVisible();
  await expect(
    page.getByText("OpenRouterError", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("The provider returned HTTP 429.")).toBeVisible();
  await expect(
    page.getByText("Tool call", { exact: true }),
  ).toBeVisible();
  // A run that failed late still paid for the calls it made, so the price is on
  // screen here — and it has to be readable, not clipped to its first character.
  await expect(page.locator(".search-debug__cost")).toHaveText("$0.0031");
  await expectTraceSummaryOnOneRow(page);
  await page.screenshot({
    path: testInfo.outputPath("desktop-failed-agent-trace.png"),
    fullPage: true,
  });
});

test("deck agent chat accumulates its spend and forgets on reset", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // Both prices are real measured turn costs, chosen so the running total does not
  // land on a rounding boundary: 0.000233 + 0.000889 = 0.001122.
  const replies = [
    {
      content: "Tell me your commander and I will suggest a direction.",
      cost: 0.000233,
      tool_calls: [
        { name: "read_deck", signature: "read_deck()", ok: true, detail: null },
      ],
    },
    {
      content: "For Ghalta, ramp first and keep the curve low.",
      cost: 0.000889,
      // The second turn used no tools, so no line may carry over from the first.
      tool_calls: [],
    },
  ];
  let turn = 0;
  let sentMessageCount = 0;
  let sentDeck: unknown = "never sent";
  await page.route("**/api/v1/agent/chat/stream", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
      deck?: unknown;
    };
    // The whole transcript is posted every turn — that is where the memory lives.
    sentMessageCount = body.messages.length;
    sentDeck = body.deck;
    const reply = replies[Math.min(turn, replies.length - 1)];
    turn += 1;
    await fulfillSse(route, [
      ...reply.tool_calls.map((call) => ({ type: "tool", call })),
      { type: "text", content: reply.content },
      {
        type: "done",
        reply: {
          message: { role: "assistant", content: reply.content },
          model: "openai/gpt-5.6-luna",
          replayed_message_count: body.messages.length,
          cost_usd: reply.cost,
          unpriced_call_count: 0,
          tool_calls: reply.tool_calls,
        },
      },
    ]);
  });

  await page.goto("/");
  const panel = page.getByRole("region", { name: "Deck agent" });
  await expect(panel).toBeVisible();
  const spend = panel.locator(".deck-agent__spend");
  await expect(spend).toHaveCount(0);

  await enableDebugMode(page);
  await expect(spend).toHaveText("$0.0000");

  const composer = panel.getByRole("textbox", {
    name: "Message the deck agent",
  });
  await composer.fill("What should I build?");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText(replies[0].content)).toBeVisible();
  expect(sentMessageCount).toBe(1);
  await expect(spend).toHaveText("$0.0002");

  // The tool the agent ran is shown as its own small line above the answer.
  await expect(panel.locator(".deck-agent__tool code")).toHaveText("read_deck()");
  // The backend holds no deck, so the open one has to travel with the turn.
  expect(sentDeck).toMatchObject({ name: "Untitled Commander", cards: [] });

  await composer.fill("Ghalta, Primal Hunger.");
  await composer.press("Enter");
  await expect(panel.getByText(replies[1].content)).toBeVisible();
  // Still exactly one: a tool line belongs to the turn that ran it.
  await expect(panel.locator(".deck-agent__tool")).toHaveCount(1);
  // Turn two replays turn one's question and answer alongside the new question.
  expect(sentMessageCount).toBe(3);
  await expect(spend).toHaveText("$0.0011");

  const layout = await panel
    .locator(".deck-agent__header")
    .evaluate((element) => {
      const badge = element.querySelector(".deck-agent__spend") as HTMLElement;
      return {
        tops: Array.from(element.children).map((child) =>
          Math.round(child.getBoundingClientRect().top),
        ),
        clientWidth: badge.clientWidth,
        scrollWidth: badge.scrollWidth,
      };
    });
  expect(Math.max(...layout.tops) - Math.min(...layout.tops)).toBeLessThanOrEqual(
    8,
  );
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

  await page.screenshot({
    path: testInfo.outputPath("desktop-deck-agent-chat.png"),
    fullPage: false,
  });

  await panel.getByRole("button", { name: "Reset chat" }).click();
  await expect(panel.getByText(replies[1].content)).toBeHidden();
  await expect(panel.locator(".deck-agent__tool")).toHaveCount(0);
  await expect(spend).toHaveText("$0.0000");
});

test("deck agent keeps a chat per deck and opens its tool calls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  const deckListing =
    'Deck "Ramp Lab" — 1 card, 1 distinct.\n\n' +
    "Commander (0) — the command zone is empty.\n\n" +
    "Artifact (1)\n  Sol Ring [6ad8011d]  [group: Ramp]";
  const sent: Array<{ messageCount: number; debug: boolean }> = [];
  await page.route("**/api/v1/agent/chat/stream", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      messages: Array<{ role: string; content: string }>;
      debug?: boolean;
    };
    sent.push({ messageCount: body.messages.length, debug: body.debug === true });
    const content = `Answer for "${body.messages.at(-1)?.content}"`;
    const call = {
      name: "read_deck",
      signature: "read_deck()",
      ok: true,
      detail: null,
      // Only a debug turn carries these, which is what makes the line open.
      arguments_json: body.debug === true ? "{}" : null,
      result: body.debug === true ? deckListing : null,
    };
    await fulfillSse(route, [
      { type: "tool", call },
      { type: "text", content },
      {
        type: "done",
        reply: {
          message: { role: "assistant", content },
          model: "openai/gpt-5.6-luna",
          replayed_message_count: body.messages.length,
          cost_usd: 0.000233,
          unpriced_call_count: 0,
          tool_calls: [call],
        },
      },
    ]);
  });

  await page.goto("/");
  const panel = page.getByRole("region", { name: "Deck agent" });
  await expect(panel).toBeVisible();
  await enableDebugMode(page);

  await page.locator(".deck-identity strong").dblclick();
  const deckName = page.getByRole("textbox", { name: "Deck name" });
  await deckName.fill("Ramp Lab");
  await deckName.press("Enter");
  await expect(page.getByRole("heading", { name: "Ramp Lab" })).toBeVisible();

  const composer = panel.getByRole("textbox", {
    name: "Message the deck agent",
  });
  await composer.fill("What is in this deck?");
  await composer.press("Enter");
  await expect(
    panel.getByText('Answer for "What is in this deck?"'),
  ).toBeVisible();
  expect(sent[0]).toEqual({ messageCount: 1, debug: true });

  // Debug mode is on and the turn carried payloads, so the line opens rather than
  // sitting there as text.
  const toolCall = panel.locator(".deck-agent__tool-call");
  await expect(toolCall).toHaveCount(1);
  await expectToolSummaryOnOneRow(page);
  await expect(panel.getByText("30x Forest")).toHaveCount(0);
  await toolCall.locator("summary").first().click();
  // Two sub-boxes: what the model asked for, and what it read back. jsdom cannot
  // tell these apart from hidden ones, which is why this assertion lives here.
  await expect(toolCall.getByText("Call", { exact: true })).toBeVisible();
  await expect(toolCall.getByText("Result", { exact: true })).toBeVisible();
  await expect(toolCall.getByText(/Sol Ring \[6ad8011d\]/)).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-deck-agent-tool-call.png"),
    fullPage: false,
  });

  // Typed and left unsent: it belongs to this deck, not to the composer.
  await composer.fill("Should I cut a land?");

  // A second deck starts its own conversation rather than inheriting this one.
  await page.getByRole("button", { name: "Create new deck" }).click();
  await expect(
    page.getByRole("heading", { name: "Untitled Commander" }),
  ).toBeVisible();
  await expect(panel.getByText(/Ask about the deck you are building/)).toBeVisible();
  await expect(panel.locator(".deck-agent__spend")).toHaveText("$0.0000");
  await expect(composer).toHaveValue("");

  await composer.fill("And this empty one?");
  await composer.press("Enter");
  await expect(panel.getByText('Answer for "And this empty one?"')).toBeVisible();
  // Its own transcript: the first deck's turns are not replayed into it.
  expect(sent[1]).toEqual({ messageCount: 1, debug: true });

  await page.getByRole("button", { name: /Ramp Lab/ }).click();
  await expect(page.getByRole("heading", { name: "Ramp Lab" })).toBeVisible();
  await expect(
    panel.getByText('Answer for "What is in this deck?"'),
  ).toBeVisible();
  await expect(
    panel.getByText('Answer for "And this empty one?"'),
  ).toHaveCount(0);
  await expect(panel.locator(".deck-agent__spend")).toHaveText("$0.0002");
  await expect(composer).toHaveValue("Should I cut a land?");

  // Saved beside the decks themselves, so a reload comes back to the conversation
  // — payloads included, which is what keeps the line expandable.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Ramp Lab" })).toBeVisible();
  await expect(
    panel.getByText('Answer for "What is in this deck?"'),
  ).toBeVisible();
  await expect(panel.locator(".deck-agent__spend")).toHaveText("$0.0002");
  await expect(composer).toHaveValue("Should I cut a land?");
  await panel.locator(".deck-agent__tool-call summary").first().click();
  await expect(panel.getByText(/Sol Ring \[6ad8011d\]/)).toBeVisible();
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
  await page.route(SUBTYPE_ROUTE, async (route) => {
    await fulfillJson(route, [
      {
        name: "Construct",
        match_score: 0.93,
      },
    ]);
  });

  await page.goto("/");
  await enableDebugMode(page);
  await openSearch(page);
  await page.getByRole("radio", { name: "Exact" }).click();
  await page.getByRole("checkbox", { name: "Blue" }).click();
  await page.getByRole("checkbox", { name: "Colorless" }).click();
  await page.getByRole("checkbox", { name: "Artifact" }).click();
  await page.getByRole("checkbox", { name: "Creature" }).click();
  await page
    .getByRole("searchbox", { name: "Search card subtypes" })
    .fill("constrct");
  await page
    .getByRole("button", { name: "Add Construct subtype" })
    .click();
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

  await expect
    .poll(() => requestedUrl?.searchParams.get("q") ?? null)
    .toBe("blue ramp");
  await expect(page.getByText("1 ranked card", { exact: true })).toBeVisible();
  expect(requestedUrl).not.toBeNull();
  expect(requestedUrl?.searchParams.getAll("color")).toEqual(["U"]);
  expect(requestedUrl?.searchParams.get("include_colorless")).toBe("true");
  expect(requestedUrl?.searchParams.get("color_mode")).toBe("exact");
  expect(requestedUrl?.searchParams.getAll("card_type")).toEqual([
    "Artifact",
    "Creature",
  ]);
  expect(requestedUrl?.searchParams.getAll("subtype")).toEqual(["Construct"]);
  expect(requestedUrl?.searchParams.get("mana_min")).toBe("2");
  expect(requestedUrl?.searchParams.get("mana_max")).toBe("5");
  expect(requestedUrl?.searchParams.get("price_min")).toBe("0.25");
  expect(requestedUrl?.searchParams.get("price_max")).toBe("12");
  expect(requestedUrl?.searchParams.get("debug")).toBe("true");
  await expect(page.getByText("Search trace")).toBeVisible();
  // Control for the priced row above: a local search called no model, so there is
  // no price badge at all — and the row still has to hold together without one.
  await expect(page.locator(".search-debug__cost")).toHaveCount(0);
  await expectTraceSummaryOnOneRow(page);
  await page.getByText("Search trace").click();
  const fuzzyStage = page.getByText("Local fuzzy title ranking", {
    exact: true,
  });
  await expect(fuzzyStage).toBeVisible();
  await fuzzyStage.click();
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
  let edhrecRequest: URL | null = null;
  await page.route(SEARCH_ROUTE, async (route) => {
    const requestUrl = new URL(route.request().url());
    const query = requestUrl.searchParams.get("q") ?? "";
    const response = searchPage(
      query,
      query.includes("Ghalta")
        ? [ghalta]
        : query
          ? [gamble]
          : [llanowarElves],
    );
    if (requestUrl.searchParams.get("enhance_with_edhrec") === "true") {
      edhrecRequest = requestUrl;
      response.edhrec = {
        status: "unavailable",
        source: null,
        message:
          "EDHREC data could not be fetched. Results use normal local sorting.",
      };
    }
    await fulfillJson(route, response);
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
    page.getByText("Outside commander color identity", { exact: true }),
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

  await openSearch(page);
  await expect(
    page.getByRole("checkbox", { name: "Enhance with EDHREC" }),
  ).toBeChecked();
  await expect(
    page.getByText("EDHREC enhancement failed", { exact: true }),
  ).toBeVisible();
  expect(edhrecRequest).not.toBeNull();
  expect(edhrecRequest?.searchParams.get("commander_oracle_id")).toBe(
    ghalta.oracle_id,
  );
  await page.screenshot({
    path: testInfo.outputPath("desktop-edhrec-fallback.png"),
    fullPage: true,
  });
  const cardSearch = page.getByRole("textbox", {
    name: "Search cards",
  });
  await cardSearch.fill("Gamble");
  await expect(
    page.getByText("Outside commander color identity", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add Gamble to deck" })
    .click();
  await cardSearch.press("Escape");

  await expect(
    page.getByText("Needs review", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Color identity warning")).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect Gamble", exact: true })
    .click();
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

test("command zone accepts a legal pair and rejects a third commander", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(SEARCH_ROUTE, async (route) => {
    const query =
      new URL(route.request().url()).searchParams.get("q") ?? "";
    const cards = query.includes("Tymna")
      ? [tymna]
      : query.includes("Ghalta")
        ? [ghalta]
        : [thrasios];
    await fulfillJson(route, searchPage(query, cards));
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Add to command zone" }).click();
  const search = page.getByRole("textbox", { name: "Search cards" });
  await search.fill("Thrasios");
  await page
    .getByRole("button", { name: "Add Thrasios, Triton Hero to deck" })
    .click();
  await search.fill("Tymna");
  await page
    .getByRole("button", { name: "Add Tymna the Weaver to deck" })
    .click();

  await search.fill("Ghalta");
  await page
    .getByRole("button", { name: "Add Ghalta, Primal Hunger to deck" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "The command zone already has two legal paired commanders.",
  );

  await search.press("Escape");
  const commandZone = page.locator('[data-group-id="command_zone"]');
  await expect(
    commandZone.getByRole("button", {
      name: "Inspect Thrasios, Triton Hero",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    commandZone.getByRole("button", {
      name: "Inspect Tymna the Weaver",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    commandZone.getByRole("button", {
      name: "Inspect Ghalta, Primal Hunger",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(commandZone.getByText("2 cards", { exact: true })).toBeVisible();
});

test("deck deletion is confirmed and recoverable across viewports", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "Rename deck" }).click();
  const nameInput = page.getByRole("textbox", { name: "Deck name" });
  await nameInput.fill("Dinosaur Ramp");
  await nameInput.press("Enter");

  await page
    .getByRole("button", { name: "Delete Dinosaur Ramp" })
    .click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole("heading", { name: "Delete Dinosaur Ramp?" }),
  ).toBeVisible();
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  const dialogBounds = await confirmation.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds?.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("mobile-delete-deck-confirmation.png"),
    fullPage: true,
  });

  await confirmation.getByRole("button", { name: "Delete deck" }).click();
  await expect(
    page.getByRole("heading", { name: "Untitled Commander" }),
  ).toBeVisible();
  const deletedToast = page.locator(".deck-toast--deleted");
  await expect(deletedToast).toContainText("Dinosaur Ramp deleted.");
  const restore = deletedToast.getByRole("button", { name: "Undo" });
  await restore.click();
  await expect(
    page.getByRole("heading", { name: "Dinosaur Ramp" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page
    .getByRole("button", { name: "Delete Dinosaur Ramp" })
    .click();
  const desktopConfirmation = page.getByRole("alertdialog");
  await expect(desktopConfirmation).toBeVisible();
  const desktopBounds = await desktopConfirmation.boundingBox();
  expect(desktopBounds).not.toBeNull();
  expect(desktopBounds?.width).toBeLessThanOrEqual(430);
  await page.screenshot({
    path: testInfo.outputPath("desktop-delete-deck-confirmation.png"),
    fullPage: true,
  });
  await desktopConfirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
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

  await enableDebugMode(page);
  await mobileToolbar
    .getByRole("button", { name: "Add cards", exact: true })
    .click();
  const searchDialog = page.getByRole("dialog", { name: "Find cards" });
  await expect(searchDialog).toBeVisible();
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
  const fuzzyStage = page.getByText("Local fuzzy title ranking", {
    exact: true,
  });
  await expect(fuzzyStage).toBeVisible();
  await fuzzyStage.click();
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

  // Five buttons in the bottom bar now that Redo is one of them, on a 390px viewport.
  // The grid was written for four, and a fifth silently overflowing is the kind of thing
  // only a real layout can catch.
  const mobileButtons = ["Add cards", "Layout", "Undo", "Redo", "More"];
  for (const name of mobileButtons) {
    const button = mobileToolbar.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
    // Still a tappable target at five across, which is the thing a sixth would break.
    expect(bounds?.width).toBeGreaterThanOrEqual(40);
    expect(bounds?.height).toBeGreaterThanOrEqual(40);
  }
  await page.screenshot({
    path: testInfo.outputPath("mobile-toolbar.png"),
    fullPage: false,
  });

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
    name: "Inspect Llanowar Elves",
  });
  await expect(cardOptions).toBeVisible();
  // The groups are a horizontal scroll-snap track on mobile, and the Command zone heading
  // is always the first slot in it, so the next group starts part-way off screen. Centred
  // rather than `scrollIntoViewIfNeeded`, which leaves a partly-visible node where it is —
  // the question here is whether the card's controls fit the viewport, not where the track
  // happens to be scrolled to.
  await cardOptions.evaluate((node) =>
    node.scrollIntoView({ inline: "center", block: "nearest" }),
  );
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

test("card text is drawn with its symbols in every panel that shows it", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.route(SEARCH_ROUTE, async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    await fulfillJson(route, searchPage(query, [llanowarElves, ghalta]));
  });
  await page.route(ENRICHMENT_ROUTE, async (route) => {
    const oracleId = new URL(route.request().url()).pathname.split("/").at(-2);
    await fulfillJson(route, emptyEnrichment(oracleId ?? ""));
  });

  await page.goto("/");
  await openSearch(page);
  await page.getByRole("textbox", { name: "Search cards" }).fill("elves");

  // A result row's cost. `{10}{G}{G}` is the case a font-sized `em` rule has to
  // survive: three symbols in a column laid out for a few characters of text.
  const ghaltaResult = page.getByRole("article").filter({ hasText: "Ghalta" });
  await expect(ghaltaResult.getByAltText("ten generic mana")).toBeVisible();
  await expect(ghaltaResult.getByAltText("one green mana")).toHaveCount(2);
  await expect(ghaltaResult.locator(".mana-line")).not.toContainText("{");

  // The preview aside's rules text, where symbols sit inside a sentence.
  const elvesResult = page.getByRole("article").filter({ hasText: "Llanowar Elves" });
  await elvesResult.getByRole("button", { name: "Llanowar Elves" }).first().click();
  const preview = page.getByRole("complementary", { name: "Search card preview" });
  await expect(preview.getByAltText("tap this permanent")).toBeVisible();
  await expect(preview.locator(".oracle-text")).toHaveText(": Add .");
  await page.screenshot({
    path: testInfo.outputPath("symbols-search.png"),
    fullPage: false,
  });

  await elvesResult.getByRole("button", { name: "Add Llanowar Elves to deck" }).click();
  await expect(elvesResult.getByLabel("1 in deck")).toBeVisible();
  await page.getByRole("textbox", { name: "Search cards" }).press("Escape");

  // The deck list is a grid sized for text, so a symbol that renders at its own
  // intrinsic size rather than the row's would push the columns apart. jsdom
  // computes no layout, so the row height is only checkable here.
  await page.getByRole("button", { name: "List" }).click();
  const row = page.locator(".deck-list__row").filter({ hasText: "Llanowar Elves" });
  const symbol = row.getByAltText("one green mana");
  await expect(symbol).toBeVisible();
  const symbolBox = await symbol.boundingBox();
  const rowBox = await row.boundingBox();
  expect(symbolBox).not.toBeNull();
  expect(rowBox).not.toBeNull();
  expect(symbolBox!.height).toBeLessThan(rowBox!.height);
  expect(symbolBox!.height).toBeGreaterThan(6);
  await page.screenshot({
    path: testInfo.outputPath("symbols-deck-list.png"),
    fullPage: false,
  });

  // The inspector's rules box, the last of the three shapes card text takes.
  await page.getByRole("button", { name: "Inspect Llanowar Elves" }).click();
  const inspector = page.getByRole("dialog", { name: "Card details" });
  await expect(inspector.getByAltText("tap this permanent")).toBeVisible();
  await expect(inspector.locator(".oracle-text")).not.toContainText("{");
  await page.screenshot({
    path: testInfo.outputPath("symbols-inspector.png"),
    fullPage: false,
  });
});

test("deck agent names cards, previews them on hover and opens them on click", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  // The agent braces every card name; the backend resolves the ones the catalog
  // knows. `{C}` and `{Sol Rong}` are here to prove the two ways a brace does not
  // become a link: a mana symbol, which is drawn instead, and a name nothing
  // resolves to, which stays as words.
  const answer =
    "Play **{Sol Ring}** on turn one — it adds {C}{C} — then {Mana Vault}. " +
    "Skip {Sol Rong}, and **never** cut lands.";
  await page.route("**/api/v1/agent/chat/stream", async (route) => {
    await fulfillSse(route, [
      { type: "text", content: answer },
      {
        type: "done",
        reply: {
          message: { role: "assistant", content: answer },
          model: "openai/gpt-5.6-luna",
          replayed_message_count: 1,
          cost_usd: 0.0004,
          unpriced_call_count: 0,
          tool_calls: [],
          card_links: [
            { name: "Sol Ring", oracle_id: solRing.oracle_id },
            { name: "Mana Vault", oracle_id: manaVault.oracle_id },
          ],
        },
      },
    ]);
  });
  await page.route(`**/api/v1/cards/${solRing.oracle_id}`, async (route) => {
    await fulfillJson(route, solRing);
  });

  await page.goto("/");
  const panel = page.getByRole("region", { name: "Deck agent" });
  await panel
    .getByRole("textbox", { name: "Message the deck agent" })
    .fill("What ramp?");
  await panel.getByRole("button", { name: "Send message" }).click();

  // Bolded, because that is how the agent writes the card it recommends — and a flat
  // parse rendered exactly that case as literal braces.
  const solRingName = panel.getByRole("button", { name: "Sol Ring", exact: true });
  await expect(solRingName).toBeVisible();
  await expect(solRingName.locator("xpath=ancestor::strong")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Mana Vault" })).toBeVisible();
  // Neither of the two non-cards became a control, and no brace reached the reader.
  await expect(panel.getByRole("button", { name: "Sol Rong" })).toHaveCount(0);
  // The two `{C}` became artwork, and the reader is left with no brace anywhere.
  const message = panel.locator(".deck-agent__message--assistant");
  await expect(message.getByAltText("one colorless mana")).toHaveCount(2);
  await expect(message).toContainText("it adds");
  await expect(message).not.toContainText("{");
  // Drawn at the size of the sentence rather than at the SVG's own size, which is
  // the only place that can be checked: jsdom computes no layout.
  const symbolBox = await message.getByAltText("one colorless mana").first().boundingBox();
  expect(symbolBox).not.toBeNull();
  expect(symbolBox!.width).toBeGreaterThan(6);
  expect(symbolBox!.width).toBeLessThan(24);
  expect(Math.abs(symbolBox!.width - symbolBox!.height)).toBeLessThan(1.5);
  // Two bolds: the card the agent recommended, and an ordinary emphasised word. The
  // first is the nesting case — a card inside bold is still a card.
  await expect(panel.locator(".deck-agent__message--assistant strong")).toHaveText([
    "Sol Ring",
    "never",
  ]);

  await solRingName.hover();
  const preview = page.getByRole("tooltip");
  await expect(preview).toBeVisible();
  // jsdom computes no layout, so this is the only place the preview's geometry is
  // real: it must be on screen, and it must not cover the name it describes.
  const box = await preview.boundingBox();
  const nameBox = await solRingName.boundingBox();
  expect(box).not.toBeNull();
  expect(nameBox).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  expect(box!.x + box!.width).toBeLessThanOrEqual(nameBox!.x + 1);

  await page.screenshot({
    path: testInfo.outputPath("agent-card-hover.png"),
    fullPage: false,
  });

  await solRingName.click();
  // The same inspector the board opens, so a card named in chat behaves like a card.
  const inspector = page.getByRole("dialog", { name: "Card details" });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "Sol Ring" })).toBeVisible();
  // The preview is gone once the real thing is open.
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("agent-card-opened.png"),
    fullPage: false,
  });
});

test("a stacked column shows each card's own printed top and opens the one under the pointer", async ({
  page,
}) => {
  // In a real browser, because none of this exists in jsdom: the stack is a percentage
  // margin resolved against the column's width, and jsdom computes no layout at all.
  await clearDeck(page);
  await page.addInitScript(
    ([withArt, withoutArt]) => {
      // Its own `details` per entry, named and identified to match. Sharing one object
      // gave three cards the same name, and every label the component builds comes from
      // `details` rather than from the entry around it.
      const entry = (card: object, name: string, id: string) => ({
        card: {
          oracle_id: id,
          scryfall_id: `p-${id}`,
          name,
          details: { ...card, name, oracle_id: id, scryfall_id: `p-${id}` },
        },
        quantity: 1,
        section: "mainboard",
      });
      const deck = {
        id: "stacked",
        name: "Stacked",
        format: "commander",
        cards: [
          entry(withArt, "Aaa Sol Ring", "o-a"),
          // No image at all, which used to collapse the card and haul every later strip
          // in the column up out of it — the box carries the aspect ratio, not the art.
          entry(withoutArt, "Bbb No Art", "o-b"),
          entry(withArt, "Ccc Sol Ring", "o-c"),
          entry(withArt, "Ddd Sol Ring", "o-d"),
        ],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      };
      window.localStorage.setItem("manabase.active-deck.v1", JSON.stringify(deck));
      window.localStorage.setItem(
        "manabase.deck-library.v2",
        JSON.stringify({ active_deck_id: "stacked", decks: [deck] }),
      );
    },
    [
      { ...solRing, name: "Aaa Sol Ring" },
      { ...solRing, name: "Bbb No Art", image_uris: null, card_faces: [] },
    ],
  );
  await page.goto("/");

  const cards = page.locator(".stack-card");
  await expect(cards).toHaveCount(4);
  const gap = async (upper: number, lower: number) =>
    (await cards.nth(lower).boundingBox())!.y -
    (await cards.nth(upper).boundingBox())!.y;

  // Every closed card shows the band across its top and nothing else, the one with no
  // art included. Equal gaps are the whole claim: an unequal one means a card is showing
  // more or less of itself than the pull-up above it subtracts.
  const resting = [await gap(0, 1), await gap(1, 2), await gap(2, 3)];
  expect(resting[0]).toBeCloseTo(resting[1], 0);
  expect(resting[1]).toBeCloseTo(resting[2], 0);
  expect(resting[0]).toBeLessThan(60);

  /**
   * Whether a pointer aimed at a point on an element would actually reach it.
   *
   * `toBeVisible` cannot answer this: the quantity controls are faded to nothing inside
   * a row collapsed to no height, and an element clipped away still has a box of its
   * own. What matters is what the browser hit-tests there.
   *
   * `at: "top"` aims at the band a closed card shows rather than at its centre, which on
   * every card but the last one is underneath the card below it.
   */
  const pressable = (label: string, at: "centre" | "top" = "centre") =>
    page.evaluate(
      ({ aria, where }) => {
        const button = document.querySelector<HTMLElement>(`[aria-label="${aria}"]`);
        if (!button) return "missing";
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          where === "top" ? box.top + 8 : box.top + box.height / 2,
        );
        return hit === button || button.contains(hit);
      },
      { aria: label, where: at },
    );

  // A closed card's quantity controls cannot be pressed by aiming where they would be.
  //
  // Both cards, and the last one is the one that matters. A covered card is protected by
  // the card lying on top of it whatever the CSS does, so asserting only on the first
  // card passes even with the clip removed — measured, as a mutation that deleted
  // `overflow: hidden` and left this green. The last card in a column has nothing over
  // it, so it is the only place the clip is the thing doing the work.
  expect(await pressable("Increase Ddd Sol Ring quantity")).toBe(false);
  expect(await pressable("Increase Aaa Sol Ring quantity")).toBe(false);

  // The card itself is what gets picked up, and the band it shows while closed is enough
  // to pick it up by — without that, a card could not be moved between groups until it
  // had been opened, which is a two-step aim. This is the claim the drag handle used to
  // carry, made against the card instead now that there is no handle.
  expect(await pressable("Inspect Aaa Sol Ring", "top")).toBe(true);
  expect(await pressable("Inspect Ddd Sol Ring", "top")).toBe(true);
  expect(
    await page
      .locator('[aria-label="Inspect Aaa Sol Ring"]')
      .getAttribute("draggable"),
  ).toBe("true");

  // The count badge clears the card's printed name. It is the only thing drawn on a
  // closed card, and the band it sits beside is where the card writes its own title, so
  // "small, in the corner" is a geometric claim: the badge ends inside the frame, before
  // the leftmost place a printed name begins.
  const badge = (await page
    .locator(".stack-card")
    .nth(3)
    .locator(".stack-card__count")
    .boundingBox())!;
  const lastCard = (await cards.nth(3).boundingBox())!;
  expect(badge.x + badge.width).toBeLessThan(lastCard.x + lastCard.width * 0.08);
  expect(badge.y).toBeLessThan(lastCard.y);

  // Hovering the second card's visible band opens it and pushes the rest of the column
  // down. Polled rather than read once, because the margin and the controls are
  // transitioned: sampled a frame after the event, every one of these reads mid-animation.
  await cards.nth(1).hover({ position: { x: 30, y: 8 } });
  await expect.poll(() => gap(1, 2)).toBeGreaterThan(resting[1] * 2);
  await expect.poll(() => pressable("Increase Bbb No Art quantity")).toBe(true);
  // …and only that one: the cards above it have not moved.
  expect(await gap(0, 1)).toBeCloseTo(resting[0], 0);

  // The controls are under the card, not over it. Measured against the art rather than
  // against the card, because the card's own box is what grew to hold them: an overlay
  // is inside the art it covers, and this has to be below its bottom edge.
  const artBottom = (await page
    .locator(".stack-card")
    .nth(1)
    .locator(".stack-card__art")
    .boundingBox())!;
  const controls = (await page
    .locator('[aria-label="Increase Bbb No Art quantity"]')
    .boundingBox())!;
  expect(controls.y).toBeGreaterThanOrEqual(artBottom.y + artBottom.height - 1);

  // Focus does the same, so tabbing into a column cannot land on a control nobody can
  // see. This is why the controls collapse rather than being switched off.
  // The third card, not the last one: what opening a card moves is the card *below* it,
  // and the last card in a column has none — so focusing that one would prove nothing.
  await page.locator('[aria-label="Increase Ccc Sol Ring quantity"]').focus();
  await expect.poll(() => pressable("Increase Ccc Sol Ring quantity")).toBe(true);
  await expect.poll(() => gap(2, 3)).toBeGreaterThan(resting[2] * 2);
});

test("two deck-agent turns keep running and finish in the conversations that started them", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedTwoAgentDecks(page);
  await installOpenAgentStreams(page);
  await page.goto("/");

  const panel = page.getByRole("region", { name: "Deck agent" });
  const composer = panel.getByRole("textbox", { name: "Message the deck agent" });
  const send = panel.getByRole("button", { name: "Send message" });
  const ask = async (question: string) => {
    await composer.fill(question);
    await send.click();
  };

  await ask("Question for Ghalta");
  await expect.poll(() => openAgentRequestCount(page)).toBe(1);
  await expect(panel.getByText("Thinking…")).toBeVisible();

  await page.getByRole("button", { name: /Atraxa Control/ }).click();
  // Deck B owns its own empty transcript and draft. A's request is still represented by the
  // background-only rail marker rather than being aborted or rendered in the wrong panel.
  await expect(composer).toHaveValue("");
  await expect(panel.getByText("Question for Ghalta")).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: /Ghalta Ramp/ })
      .getByText("Deck agent working", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("background-agent-turn.png"),
    fullPage: false,
  });

  await ask("Question for Atraxa");
  await expect.poll(() => openAgentRequestCount(page)).toBe(2);
  // The open deck already has the live panel, so the rail does not repeat its state.
  await expect(
    page
      .getByRole("button", { name: /Atraxa Control/ })
      .getByText("Deck agent working", { exact: true }),
  ).toHaveCount(0);

  // A keeps accumulating while B is open. Then B finishes first.
  await pushAgentFrame(page, 0, {
    type: "text",
    content: "Ghalta is still working.",
  });
  await pushAgentFrame(page, 1, {
    type: "text",
    content: "Atraxa finished first.",
  });
  await pushAgentFrame(page, 1, {
    type: "done",
    reply: {
      message: { role: "assistant", content: "Atraxa finished first." },
      model: "openai/gpt-5.6-luna",
      replayed_message_count: 1,
      cost_usd: 0.0002,
      unpriced_call_count: 0,
      tool_calls: [],
    },
  });
  await closeAgentStream(page, 1);
  await expect(panel.getByText("Atraxa finished first.")).toBeVisible();
  await expect(panel.getByText("Ghalta is still working.")).toHaveCount(0);

  await page.getByRole("button", { name: /Ghalta Ramp/ }).click();
  // Not merely "the request survived": the frame written while this deck was away survived
  // with it. A global live buffer would make this sentence disappear.
  await expect(panel.getByText("Ghalta is still working.")).toBeVisible();
  await expect(panel.getByText("Atraxa finished first.")).toHaveCount(0);

  await pushAgentFrame(page, 0, {
    type: "done",
    reply: {
      message: { role: "assistant", content: "Ghalta finished second." },
      model: "openai/gpt-5.6-luna",
      replayed_message_count: 1,
      cost_usd: 0.0001,
      unpriced_call_count: 0,
      tool_calls: [],
    },
  });
  await closeAgentStream(page, 0);
  await expect(panel.getByText("Ghalta finished second.")).toBeVisible();

  await page.getByRole("button", { name: /Atraxa Control/ }).click();
  await expect(panel.getByText("Atraxa finished first.")).toBeVisible();
  await expect(panel.getByText("Ghalta finished second.")).toHaveCount(0);

  const requests = (await openAgentRequests(page)) as Array<{
    deck: { name: string };
    messages: Array<{ content?: string }>;
  }>;
  expect(requests.map((request) => request.deck.name)).toEqual([
    "Ghalta Ramp",
    "Atraxa Control",
  ]);
  expect(requests.map((request) => request.messages.at(-1)?.content)).toEqual([
    "Question for Ghalta",
    "Question for Atraxa",
  ]);
});

test("escape keeps a streamed tool and partial answer for the next turn", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installOpenAgentStreams(page);
  await page.goto("/");

  const panel = page.getByRole("region", { name: "Deck agent" });
  const composer = panel.getByRole("textbox", { name: "Message the deck agent" });
  await composer.fill("What ramp am I missing?");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => openAgentRequestCount(page)).toBe(1);

  const call = {
    id: "call-read-deck",
    name: "read_deck",
    signature: "read_deck(mana)",
    ok: true,
    detail: null,
    arguments_json: '{"extra_info":["mana"]}',
    result: "Deck has Sol Ring and no other ramp.",
  };
  await pushAgentFrame(page, 0, { type: "tool", call });
  await pushAgentFrame(page, 0, {
    type: "text",
    content: "You have one rock so far.",
  });
  await expect(panel.getByText("read_deck(mana)")).toBeVisible();
  await expect(panel.getByText("You have one rock so far.")).toBeVisible();
  await expect(composer).toBeFocused();

  await page.keyboard.press("Escape");
  await closeAgentStream(page, 0);

  await expect(
    panel.getByText("Interrupted — kept, and the next question continues from here"),
  ).toBeVisible();
  await expect(panel.getByText("read_deck(mana)")).toBeVisible();
  await expect(panel.getByText("You have one rock so far.")).toBeVisible();
  await expect(panel.getByText("What ramp am I missing?")).toBeVisible();
  // Something happened, so the question stays in the transcript instead of being handed
  // back as though the turn never ran.
  await expect(composer).toHaveValue("");
  await page.screenshot({
    path: testInfo.outputPath("interrupted-turn-kept.png"),
    fullPage: false,
  });

  await composer.fill("Continue from there.");
  await composer.press("Enter");
  await expect.poll(() => openAgentRequestCount(page)).toBe(2);

  const requests = (await openAgentRequests(page)) as Array<{
    messages: Array<{
      role: string;
      content?: string;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; name: string }>;
    }>;
  }>;
  const replay = requests[1].messages;
  expect(replay).toHaveLength(5);
  expect(replay[0]).toEqual({
    role: "user",
    content: "What ramp am I missing?",
  });
  const replayedCall = replay[1].tool_calls?.[0];
  expect(replayedCall).toMatchObject({
    name: "read_deck",
    arguments_json: '{"extra_info":["mana"]}',
    deck_revision: expect.any(String),
  });
  expect(replayedCall?.id).toEqual(expect.any(String));
  // Pair by the one generated id rather than by its spelling. The replay builder owns the
  // namespace; the transport contract is that the answer names the exact call it answers.
  expect(replay[2]).toEqual({
    role: "tool",
    content: "Deck has Sol Ring and no other ramp.",
    tool_call_id: replayedCall?.id,
  });
  expect(replay[3]).toEqual({
    role: "assistant",
    content: "You have one rock so far.",
  });
  expect(replay[4]).toEqual({
    role: "user",
    content: "Continue from there.",
  });

  await pushAgentFrame(page, 1, {
    type: "text",
    content: "Continuing with that result.",
  });
  await pushAgentFrame(page, 1, {
    type: "done",
    reply: {
      message: { role: "assistant", content: "Continuing with that result." },
      model: "openai/gpt-5.6-luna",
      replayed_message_count: 5,
      cost_usd: 0.0001,
      unpriced_call_count: 0,
      tool_calls: [],
    },
  });
  await closeAgentStream(page, 1);
  await expect(panel.getByText("Continuing with that result.")).toBeVisible();
});

test("escape cancels a turn and hands the question back to the composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await clearDeck(page);

  // A turn that never answers, so the test decides when it ends. jsdom cannot judge
  // any of what follows: a real keydown reaching a real focused element, and where
  // the caret sits in a textarea the browser laid out.
  let aborted = false;
  // At page level: a route sitting in its handler is not told the client hung up, so
  // the request object it holds never reports the failure. The page does.
  page.on("requestfailed", (request) => {
    if (request.url().includes("/agent/chat/stream")) {
      aborted = true;
    }
  });
  await page.route("**/api/v1/agent/chat/stream", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    await route.abort().catch(() => {});
  });

  await page.goto("/");
  const panel = page.getByRole("region", { name: "Deck agent" });
  const composer = panel.getByRole("textbox", { name: "Message the deck agent" });

  await composer.fill("waht ramp shoud i add");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText("Thinking…")).toBeVisible();
  // The shortcut is offered where the waiting is, rather than being folklore.
  await expect(panel.getByText("esc to cancel")).toBeVisible();
  // In the transcript, out of the composer: the ordinary state of a sent question.
  await expect(panel.locator(".deck-agent__message--user")).toContainText(
    "waht ramp shoud i add",
  );
  await expect(composer).toHaveValue("");

  // Sent by *clicking*, which is the path that broke: the click disables the button
  // it landed on, a disabled element cannot hold focus, and the browser drops focus to
  // `<body>` — outside the panel, where Escape reaches nothing. So sending keeps the
  // panel focused, and this asserts that rather than assuming it.
  await expect(composer).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(panel.getByText("Thinking…")).toHaveCount(0);
  await expect(composer).toHaveValue("waht ramp shoud i add");
  await expect(panel.locator(".deck-agent__message--user")).toHaveCount(0);
  // Focused with the caret at the end, so the typo is one keystroke from being fixed.
  await expect(composer).toBeFocused();
  expect(
    await composer.evaluate((node) => (node as HTMLTextAreaElement).selectionStart),
  ).toBe("waht ramp shoud i add".length);
  // The request really was dropped rather than left running behind the panel.
  await expect.poll(() => aborted).toBe(true);

  // And it is genuinely editable: corrected and sent again as one question.
  await composer.fill("what ramp should I add");
  await expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled();
});

/**
 * A brief as the agent writes one: Markdown, and one braced name of the kind a brief
 * saved before that convention was scoped to the transcript still carries.
 */
const BRIEF_MARKDOWN = [
  "cEDH power target, led by {Kinnan, Bonder Prodigy}.",
  "",
  "- Easy to pilot, with short combo turns.",
  "- Little instant-speed interaction.",
].join("\n");

test("the agent can name an untitled deck and maintain its editable brief", async ({
  page,
}) => {
  await clearDeck(page);
  await page.route("**/api/v1/agent/chat/stream", async (route) => {
    await fulfillSse(route, [
      {
        type: "tool",
        call: {
          name: "edit_deck_text",
          signature: "edit_deck_text(name, description)",
          ok: true,
          detail: null,
          id: "call-brief",
          arguments_json: JSON.stringify({
            name: "Decisive Kinnan",
            description: BRIEF_MARKDOWN,
            reason: "capturing the user's durable intent",
          }),
          result: "Updated the deck name and description.",
        },
      },
      {
        type: "deck_text_edit",
        edit: {
          deck_name: "Untitled Commander",
          reason: "capturing the user's durable intent",
          name: "Decisive Kinnan",
          description: BRIEF_MARKDOWN,
        },
      },
      {
        type: "done",
        reply: {
          message: {
            role: "assistant",
            content: "I captured that as the deck's direction.",
          },
          model: "openai/gpt-5.6-luna",
          replayed_message_count: 1,
          cost_usd: 0.001,
          unpriced_call_count: 0,
          tool_calls: [],
          card_links: [],
        },
      },
    ]);
  });
  await page.goto("/");

  await page.getByLabel("Message the deck agent").fill(
    "Build this for cEDH, but keep it easy to pilot without long combo turns.",
  );
  await page.getByLabel("Send message").click();

  await expect(
    page.getByRole("heading", { name: "Decisive Kinnan" }),
  ).toBeVisible();
  // Rendered as Markdown, and with the braces off the name: the box is not the
  // transcript, so there is no card to open and nothing to mark up.
  const brief = page.getByRole("region", { name: "Deck intent brief" });
  await expect(
    brief.getByText("cEDH power target, led by Kinnan, Bonder Prodigy."),
  ).toBeVisible();
  await expect(brief.getByRole("listitem")).toHaveText([
    "Easy to pilot, with short combo turns.",
    "Little instant-speed interaction.",
  ]);
  const transcript = page.getByRole("log", {
    name: "Deck agent conversation",
  });
  await expect(transcript.getByText("Applied deck details")).toBeVisible();

  await transcript.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByRole("heading", { name: "Untitled Commander" }),
  ).toBeVisible();
  const addDescription = page.getByRole("button", { name: "Add description" });
  await expect(addDescription).toBeVisible();
  await addDescription.click();
  await page.getByLabel("Deck description").fill(
    [
      "High-power creature combo with a cEDH target.",
      "Keep the primary lines short and easy to explain.",
      "Prefer low decision density during ordinary setup turns.",
      "Avoid plans that require holding up many instant-speed interactions.",
    ].join("\n"),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const seeAll = page.getByRole("button", { name: "See all" });
  await expect(seeAll).toBeVisible();
  await seeAll.click();
  await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
});

test("a deck leaves the application in a shape a shop can read", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route(SEARCH_ROUTE, async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    const cards = query.includes("Ghalta")
      ? [ghalta]
      : query.includes("Llanowar")
        ? [llanowarElves]
        : [solRing];
    await fulfillJson(route, searchPage(query, cards));
  });
  await page.goto("/");

  // Nothing to hand anyone yet.
  await expect(page.getByRole("button", { name: "Export" })).toBeDisabled();

  const closeSearch = () =>
    page
      .getByRole("button", { name: "Close card search", exact: true })
      .and(page.locator(".icon-button"))
      .click();

  // The commander goes in through the command zone's own trigger. The drawer keeps that
  // target for everything added while it is open, so the mainboard cards need a second
  // pass — a second card sent to the command zone is refused as an illegal pairing.
  await page.getByRole("button", { name: "Add to command zone" }).click();
  const search = page.getByRole("textbox", { name: "Search cards" });
  await search.fill("Ghalta");
  await page
    .getByRole("button", { name: "Add Ghalta, Primal Hunger to deck" })
    .click();
  await closeSearch();

  await openSearch(page);
  await search.fill("Sol Ring");
  await page.getByRole("button", { name: "Add Sol Ring to deck" }).click();
  await search.fill("Llanowar");
  await page
    .getByRole("button", { name: "Add Llanowar Elves to deck" })
    .click();
  await closeSearch();

  await page.getByRole("button", { name: "Export" }).click();
  const dialog = page.getByRole("dialog", { name: /^Export / });
  await expect(dialog).toBeVisible();

  // Commander first and no heading anywhere: every line is a card a shop can price.
  const preview = dialog.getByRole("textbox");
  await expect(preview).toHaveValue(
    "1 Ghalta, Primal Hunger\n1 Llanowar Elves\n1 Sol Ring",
  );

  await dialog.getByRole("button", { name: "MTG Arena", exact: true }).click();
  await expect(preview).toHaveValue(
    "Commander\n1 Ghalta, Primal Hunger (RIX) 130\n\n" +
      "Deck\n1 Llanowar Elves (FDN) 227\n1 Sol Ring (MSC) 211",
  );

  await dialog.getByRole("button", { name: "CSV", exact: true }).click();
  await expect(preview).toHaveValue(
    "Quantity,Name,Set,Collector number,Price EUR\n" +
      '1,"Ghalta, Primal Hunger",RIX,130,0.23\n' +
      "1,Llanowar Elves,FDN,227,0.23\n" +
      "1,Sol Ring,MSC,211,0.95",
  );

  // The cart carries the buyable list whatever the preview is currently showing.
  const cart = dialog.getByRole("link", { name: "Buy on TCGplayer" });
  await expect(cart).toHaveAttribute(
    "href",
    "https://www.tcgplayer.com/massentry?productline=Magic" +
      "&c=1%20Ghalta%2C%20Primal%20Hunger%7C%7C1%20Llanowar%20Elves%7C%7C1%20Sol%20Ring",
  );

  await page.screenshot({
    path: testInfo.outputPath("export-deck.png"),
    fullPage: true,
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
