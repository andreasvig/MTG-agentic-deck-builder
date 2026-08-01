import type {
  DeckAgentCardLink,
  DeckAgentChatReply,
  DeckAgentDeckSnapshot,
  DeckAgentMessage,
  DeckAgentToolCall,
} from "../domain/agent";
import type {
  CardEnrichment,
  EdhrecCommanderContext,
  EdhrecSimilarCards,
  CardSearchFilters,
  CardSearchPage,
  CardSearchResult,
  CardSubtypeMatch,
  CardTagMatch,
  SearchDebugSummary,
} from "../domain/card";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:43127/api/v1";

export interface HealthResponse {
  status: "ok";
  service: "mtg-agentic-deck-builder-api";
  version: string;
}

export interface CardSearchEnhancements {
  enhanceWithEdhrec: boolean;
  commanderOracleId: string;
  edhrecTheme?: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debug: SearchDebugSummary | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  getHealth(signal?: AbortSignal): Promise<HealthResponse>;
  getCardEnrichment?(
    oracleId: string,
    signal?: AbortSignal,
  ): Promise<CardEnrichment>;
  getCard?(
    oracleId: string,
    signal?: AbortSignal,
  ): Promise<CardSearchResult>;
  getCommanderEdhrecContext?(
    oracleId: string,
    signal?: AbortSignal,
  ): Promise<EdhrecCommanderContext>;
  getCardEdhrecSimilar?(
    oracleId: string,
    signal?: AbortSignal,
  ): Promise<EdhrecSimilarCards>;
  searchCardTags?(
    query: string,
    signal?: AbortSignal,
  ): Promise<CardTagMatch[]>;
  searchCardSubtypes?(
    query: string,
    signal?: AbortSignal,
  ): Promise<CardSubtypeMatch[]>;
  searchCards(
    query: string,
    page?: number,
    signal?: AbortSignal,
    filters?: CardSearchFilters,
    debug?: boolean,
    enhancements?: CardSearchEnhancements,
  ): Promise<CardSearchPage>;
  searchCardsAgentic?(
    query: string,
    page?: number,
    signal?: AbortSignal,
    filters?: CardSearchFilters,
    debug?: boolean,
    searchSessionId?: string | null,
    alreadyShownOracleIds?: string[],
    enhancements?: CardSearchEnhancements,
  ): Promise<CardSearchPage>;
  streamDeckAgentChat?(
    messages: DeckAgentMessage[],
    deck: DeckAgentDeckSnapshot | null | undefined,
    handlers: DeckAgentStreamHandlers,
    signal?: AbortSignal,
    debug?: boolean,
  ): Promise<DeckAgentChatReply>;
}

/** What to do with a turn's progress while it is still being produced. */
export interface DeckAgentStreamHandlers {
  /** A piece of the answer as the model writes it. */
  onText(content: string): void;
  /** One tool call, the moment it finished running. */
  onToolCall(call: DeckAgentToolCall): void;
}

export function createApiClient(
  baseUrl = import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL,
  fetcher: typeof fetch = (...args) => fetch(...args),
): ApiClient {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return {
    async getHealth(signal) {
      const response = await fetcher(`${normalizedBaseUrl}/health`, {
        headers: { Accept: "application/json" },
        signal,
      });

      if (!response.ok) {
        throw new ApiError("The backend health check failed.", response.status);
      }

      const body: unknown = await response.json();
      if (
        !isRecord(body) ||
        body.status !== "ok" ||
        body.service !== "mtg-agentic-deck-builder-api" ||
        typeof body.version !== "string"
      ) {
        throw new ApiError("The backend health response was invalid.", 502);
      }

      return {
        status: body.status,
        service: body.service,
        version: body.version,
      };
    },
    async getCardEnrichment(oracleId, signal) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/${encodeURIComponent(oracleId)}/enrichment`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readCardEnrichmentResponse(response);
    },
    async getCard(oracleId, signal) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/${encodeURIComponent(oracleId)}`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readCardResponse(response);
    },
    async getCommanderEdhrecContext(oracleId, signal) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/${encodeURIComponent(oracleId)}/edhrec`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readEdhrecCommanderContextResponse(response);
    },
    async getCardEdhrecSimilar(oracleId, signal) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/${encodeURIComponent(oracleId)}/edhrec/similar`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readEdhrecSimilarCardsResponse(response);
    },
    async searchCardTags(query, signal) {
      const url = new URL(`${normalizedBaseUrl}/cards/tags/search`);
      url.searchParams.set("q", query.trim());
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal,
      });
      return readCardTagSearchResponse(response);
    },
    async searchCardSubtypes(query, signal) {
      const url = new URL(`${normalizedBaseUrl}/cards/subtypes/search`);
      url.searchParams.set("q", query.trim());
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal,
      });
      return readCardSubtypeSearchResponse(response);
    },
    async searchCards(
      query,
      page = 1,
      signal,
      filters,
      debug = false,
      enhancements,
    ) {
      const url = new URL(`${normalizedBaseUrl}/cards/search`);
      url.searchParams.set("q", query.trim());
      url.searchParams.set("page", String(page));
      filters?.colors.forEach((color) => url.searchParams.append("color", color));
      if (filters?.includeColorless) {
        url.searchParams.set("include_colorless", "true");
      }
      if (filters && (filters.colors.length > 0 || filters.includeColorless)) {
        url.searchParams.set("color_mode", filters.colorMode);
      }
      if (filters?.includeNonCommanderLegal) {
        url.searchParams.set("include_non_commander_legal", "true");
      }
      if (filters?.includeOutsideCommanderColorIdentity) {
        url.searchParams.set("include_outside_commander_identity", "true");
      }
      filters?.commanderColorIdentity?.forEach((color) =>
        url.searchParams.append("commander_color", color),
      );
      if (filters?.commanderColorIdentity !== null) {
        url.searchParams.set("commander_identity_known", "true");
      }
      filters?.tags.forEach((tag) => url.searchParams.append("tag", tag.id));
      filters?.cardTypes?.forEach((cardType) =>
        url.searchParams.append("card_type", cardType),
      );
      filters?.subtypes?.forEach((subtype) =>
        url.searchParams.append("subtype", subtype),
      );
      setNumberParam(url, "mana_min", filters?.manaValueMin);
      setNumberParam(url, "mana_max", filters?.manaValueMax);
      setNumberParam(url, "price_min", filters?.priceEurMin);
      setNumberParam(url, "price_max", filters?.priceEurMax);
      if (enhancements?.enhanceWithEdhrec) {
        url.searchParams.set("enhance_with_edhrec", "true");
        url.searchParams.set(
          "commander_oracle_id",
          enhancements.commanderOracleId,
        );
        if (enhancements.edhrecTheme) {
          url.searchParams.set("edhrec_theme", enhancements.edhrecTheme);
        }
      }
      if (debug) {
        url.searchParams.set("debug", "true");
      }
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        signal,
      });

      return readCardSearchResponse(response);
    },
    async searchCardsAgentic(
      query,
      page = 1,
      signal,
      filters = {
        colors: [],
        includeColorless: false,
        colorMode: "subset",
        includeNonCommanderLegal: false,
        includeOutsideCommanderColorIdentity: false,
        commanderColorIdentity: null,
        tags: [],
        cardTypes: [],
        subtypes: [],
        manaValueMin: null,
        manaValueMax: null,
        priceEurMin: null,
        priceEurMax: null,
      },
      debug = false,
      searchSessionId = null,
      alreadyShownOracleIds = [],
      enhancements,
    ) {
      const response = await fetcher(
        `${normalizedBaseUrl}/cards/search/agentic`,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            q: query.trim(),
            page,
            filters: {
              colors: filters.colors,
              include_colorless: filters.includeColorless,
              color_mode: filters.colorMode,
              include_non_commander_legal:
                filters.includeNonCommanderLegal,
              include_outside_commander_color_identity:
                filters.includeOutsideCommanderColorIdentity,
              commander_color_identity: filters.commanderColorIdentity,
              tags: filters.tags,
              card_types: filters.cardTypes ?? [],
              subtypes: filters.subtypes ?? [],
              mana_value_min: filters.manaValueMin,
              mana_value_max: filters.manaValueMax,
              price_eur_min: filters.priceEurMin,
              price_eur_max: filters.priceEurMax,
            },
            debug,
            search_session_id: searchSessionId,
            already_shown_oracle_ids: alreadyShownOracleIds,
            ...(enhancements
              ? {
                  commander_oracle_id: enhancements.commanderOracleId,
                  enhance_with_edhrec: enhancements.enhanceWithEdhrec,
                  edhrec_theme:
                    enhancements.enhanceWithEdhrec
                      ? (enhancements.edhrecTheme ?? null)
                      : null,
                }
              : {}),
          }),
          signal,
        },
      );
      return readCardSearchResponse(response);
    },
    async streamDeckAgentChat(messages, deck, handlers, signal, debug = false) {
      const response = await fetcher(`${normalizedBaseUrl}/agent/chat/stream`, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(deck ? { deck } : {}),
          debug,
        }),
        signal,
      });
      return readDeckAgentStream(response, handlers);
    },
  };
}

export const apiClient = createApiClient();

function setNumberParam(
  url: URL,
  name: string,
  value: number | null | undefined,
) {
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    url.searchParams.set(name, String(value));
  }
}

/** A reported number, or the absence of one. Absent is never the same as zero. */
function isOptionalNumber(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCardSearchPage(value: unknown): value is CardSearchPage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.query === "string" &&
    typeof value.page === "number" &&
    typeof value.total_results === "number" &&
    typeof value.has_more === "boolean" &&
    Array.isArray(value.cards) &&
    value.cards.every(isCardSearchResult) &&
    isRecord(value.name_match_scores) &&
    Object.values(value.name_match_scores).every(
      (score) =>
        typeof score === "number" &&
        Number.isFinite(score) &&
        score >= 0 &&
        score <= 1,
    ) &&
    isRecord(value.title_confidence_scores) &&
    Object.values(value.title_confidence_scores).every(
      (score) =>
        typeof score === "number" &&
        Number.isFinite(score) &&
        score >= 0 &&
        score <= 1,
    ) &&
    Array.isArray(value.warnings) &&
    ["fuzzy", "agentic"].includes(String(value.strategy)) &&
    (value.interpretation === null ||
      typeof value.interpretation === "string") &&
    typeof value.reranked === "boolean" &&
    typeof value.agentic_required === "boolean" &&
    (value.search_session_id === null ||
      typeof value.search_session_id === "string") &&
    isEdhrecSearchEnhancement(value.edhrec) &&
    (value.debug === null || isSearchDebugSummary(value.debug)) &&
    Array.isArray(value.debug_runs) &&
    value.debug_runs.every(isSearchDebugSummary)
  );
}

function isEdhrecSearchEnhancement(value: unknown): boolean {
  return (
    isRecord(value) &&
    ["not_requested", "applied", "unavailable"].includes(
      String(value.status),
    ) &&
    (value.source === null ||
      value.source === "cache" ||
      value.source === "network") &&
    (value.message === null || typeof value.message === "string")
  );
}

function isCardSearchResult(value: unknown): value is CardSearchResult {
  return (
    isRecord(value) &&
    typeof value.oracle_id === "string" &&
    typeof value.scryfall_id === "string" &&
    typeof value.name === "string" &&
    typeof value.type_line === "string" &&
    typeof value.mana_value === "number" &&
    (value.power === null || typeof value.power === "string") &&
    (value.toughness === null || typeof value.toughness === "string") &&
    isRecord(value.prices)
  );
}

async function readCardSearchResponse(
  response: Response,
): Promise<CardSearchPage> {
  if (!response.ok) {
    let message = "Card search is temporarily unavailable.";
    let debug: SearchDebugSummary | null = null;
    try {
      const body: unknown = await response.json();
      if (
        isRecord(body) &&
        isRecord(body.detail) &&
        typeof body.detail.message === "string"
      ) {
        message = body.detail.message;
        if (isSearchDebugSummary(body.detail.debug)) {
          debug = body.detail.debug;
        }
      }
    } catch {
      // Keep the stable fallback for non-JSON upstream failures.
    }
    throw new ApiError(message, response.status, debug);
  }

  const body: unknown = await response.json();
  if (!isCardSearchPage(body)) {
    throw new ApiError("The card search response was invalid.", 502);
  }
  return body;
}

async function readCardEnrichmentResponse(
  response: Response,
): Promise<CardEnrichment> {
  if (!response.ok) {
    let message = "Card tags and relationships are temporarily unavailable.";
    try {
      const body: unknown = await response.json();
      if (
        isRecord(body) &&
        isRecord(body.detail) &&
        typeof body.detail.message === "string"
      ) {
        message = body.detail.message;
      }
    } catch {
      // Keep the stable fallback for non-JSON failures.
    }
    throw new ApiError(message, response.status);
  }

  const body: unknown = await response.json();
  if (!isCardEnrichment(body)) {
    throw new ApiError("The card enrichment response was invalid.", 502);
  }
  return body;
}

/** Tolerate an absent list, so a reply from an older backend still loads. */
function isDeckAgentToolCallList(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        typeof entry.signature === "string" &&
        (entry.ok === undefined || typeof entry.ok === "boolean") &&
        (entry.detail === null ||
          entry.detail === undefined ||
          typeof entry.detail === "string") &&
        isOptionalString(entry.arguments_json) &&
        isOptionalString(entry.result),
    )
  );
}

/** Present text, or the absence of it. Absent is never the same as empty. */
function isOptionalString(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string";
}

function readDeckAgentToolCalls(value: unknown): DeckAgentToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    name: String(entry.name),
    signature: String(entry.signature),
    ok: entry.ok !== false,
    detail: typeof entry.detail === "string" ? entry.detail : null,
    // Only a debug turn carries these, so anything else is an absence rather
    // than an empty call or an empty result.
    arguments_json:
      typeof entry.arguments_json === "string" ? entry.arguments_json : null,
    result: typeof entry.result === "string" ? entry.result : null,
  }));
}

/** Read a reply, from either agent route, or report that it was not one. */
function readDeckAgentReply(body: unknown): DeckAgentChatReply | null {
  if (
    !isRecord(body) ||
    !isRecord(body.message) ||
    body.message.role !== "assistant" ||
    typeof body.message.content !== "string" ||
    body.message.content.length === 0 ||
    typeof body.model !== "string" ||
    typeof body.replayed_message_count !== "number" ||
    !isOptionalNumber(body.cost_usd) ||
    !isOptionalNumber(body.unpriced_call_count) ||
    !isDeckAgentToolCallList(body.tool_calls)
  ) {
    return null;
  }
  return {
    message: { role: "assistant", content: body.message.content },
    model: body.model,
    replayed_message_count: body.replayed_message_count,
    cost_usd: typeof body.cost_usd === "number" ? body.cost_usd : null,
    unpriced_call_count:
      typeof body.unpriced_call_count === "number" ? body.unpriced_call_count : 0,
    tool_calls: readDeckAgentToolCalls(body.tool_calls),
    card_links: readDeckAgentCardLinks(body.card_links),
  };
}

/**
 * Read the resolved card names, dropping any entry that is not one.
 *
 * Absent is tolerated rather than rejected: links only make an answer clickable, so
 * an older backend that does not send them should still produce a readable turn.
 */
function readDeckAgentCardLinks(value: unknown): DeckAgentCardLink[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.name === "string" &&
    typeof entry.oracle_id === "string"
      ? [{ name: entry.name, oracle_id: entry.oracle_id }]
      : [],
  );
}

async function readDeckAgentFailure(response: Response): Promise<never> {
  let message = "The deck agent is temporarily unavailable.";
  try {
    const body: unknown = await response.json();
    if (
      isRecord(body) &&
      isRecord(body.detail) &&
      typeof body.detail.message === "string"
    ) {
      message = body.detail.message;
    }
  } catch {
    // Keep the stable fallback for non-JSON failures.
  }
  throw new ApiError(message, response.status);
}

/**
 * Read one streamed turn, reporting its progress and returning its finished reply.
 *
 * The `done` event carries the same reply the JSON route returns, so everything
 * downstream — what is stored, what a turn cost, which tools ran — is identical
 * whichever route produced it. Text and tool events are presentation only.
 */
async function readDeckAgentStream(
  response: Response,
  handlers: DeckAgentStreamHandlers,
): Promise<DeckAgentChatReply> {
  if (!response.ok) {
    await readDeckAgentFailure(response);
  }

  let reply: DeckAgentChatReply | null = null;
  for await (const event of readServerSentEvents(response)) {
    if (!isRecord(event)) {
      continue;
    }
    if (event.type === "text" && typeof event.content === "string") {
      handlers.onText(event.content);
    } else if (event.type === "tool" && isDeckAgentToolCallList([event.call])) {
      const [call] = readDeckAgentToolCalls([event.call]);
      if (call) {
        handlers.onToolCall(call);
      }
    } else if (event.type === "error") {
      // The response was already a 200 by the time this happened, so the failure
      // arrives in-band; it is still the same failure the JSON route reports.
      throw new ApiError(
        typeof event.message === "string"
          ? event.message
          : "The deck agent is temporarily unavailable.",
        event.code === "deck_agent_contract_error" ? 502 : 503,
      );
    } else if (event.type === "done") {
      reply = readDeckAgentReply(event.reply);
      if (!reply) {
        throw new ApiError("The deck agent response was invalid.", 502);
      }
    }
  }
  if (!reply) {
    // A stream that stopped without a finished turn has produced nothing that can
    // be stored, however much text it sent on the way.
    throw new ApiError("The deck agent did not finish answering.", 502);
  }
  return reply;
}

/**
 * Yield the JSON payload of each `data:` event in a server-sent-event body.
 *
 * Falls back to reading the whole body when the response exposes no stream, so a
 * runtime without `ReadableStream` still gets its turn — just all at once.
 */
async function* readServerSentEvents(
  response: Response,
): AsyncGenerator<unknown> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    yield* parseServerSentEvents(await response.text());
    return;
  }
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffered += decoder.decode(value, { stream: true });
    // An event is only complete at a blank line; anything after the last one is a
    // partial frame that has to wait for the next read.
    const frames = buffered.split("\n\n");
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      yield* parseServerSentEvents(frame);
    }
  }
  yield* parseServerSentEvents(buffered);
}

function* parseServerSentEvents(body: string): Generator<unknown> {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (!data) {
      continue;
    }
    try {
      yield JSON.parse(data);
    } catch {
      // A frame that is not JSON is not an event this client understands.
    }
  }
}

async function readCardResponse(response: Response): Promise<CardSearchResult> {
  if (!response.ok) {
    throw new ApiError(
      "That card is not available in the local catalog.",
      response.status,
    );
  }
  const body: unknown = await response.json();
  if (!isCardSearchResult(body)) {
    throw new ApiError("The card response was invalid.", 502);
  }
  return body;
}

async function readEdhrecCommanderContextResponse(
  response: Response,
): Promise<EdhrecCommanderContext> {
  if (!response.ok) {
    throw new ApiError(
      "EDHREC commander themes are temporarily unavailable.",
      response.status,
    );
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !["not_requested", "applied", "unavailable"].includes(
      String(body.status),
    ) ||
    (body.source !== null &&
      body.source !== "cache" &&
      body.source !== "network") ||
    typeof body.commander_oracle_id !== "string" ||
    (body.commander_name !== null &&
      typeof body.commander_name !== "string") ||
    !Array.isArray(body.themes) ||
    !body.themes.every(
      (theme) =>
        isRecord(theme) &&
        typeof theme.slug === "string" &&
        typeof theme.name === "string" &&
        typeof theme.deck_count === "number" &&
        theme.deck_count >= 0,
    ) ||
    (body.message !== null && typeof body.message !== "string")
  ) {
    throw new ApiError("The EDHREC commander-theme response was invalid.", 502);
  }
  return body as unknown as EdhrecCommanderContext;
}

async function readEdhrecSimilarCardsResponse(
  response: Response,
): Promise<EdhrecSimilarCards> {
  if (!response.ok) {
    throw new ApiError(
      "EDHREC similar cards are temporarily unavailable.",
      response.status,
    );
  }
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    !["not_requested", "applied", "unavailable"].includes(String(body.status)) ||
    (body.source !== null &&
      body.source !== undefined &&
      body.source !== "cache" &&
      body.source !== "network") ||
    typeof body.oracle_id !== "string" ||
    !Array.isArray(body.cards) ||
    !body.cards.every(
      (card) =>
        isRecord(card) &&
        typeof card.rank === "number" &&
        card.rank >= 1 &&
        typeof card.name === "string" &&
        (card.oracle_id === null ||
          card.oracle_id === undefined ||
          typeof card.oracle_id === "string"),
    )
  ) {
    throw new ApiError("The EDHREC similar-card response was invalid.", 502);
  }
  return body as unknown as EdhrecSimilarCards;
}

async function readCardTagSearchResponse(
  response: Response,
): Promise<CardTagMatch[]> {
  if (!response.ok) {
    throw new ApiError("Card tags are temporarily unavailable.", response.status);
  }
  const body: unknown = await response.json();
  if (
    !Array.isArray(body) ||
    !body.every(
      (tag) =>
        isRecord(tag) &&
        typeof tag.id === "string" &&
        typeof tag.name === "string" &&
        typeof tag.slug === "string" &&
        (tag.description === null || typeof tag.description === "string") &&
        typeof tag.match_score === "number" &&
        tag.match_score >= 0 &&
        tag.match_score <= 1,
    )
  ) {
    throw new ApiError("The card tag response was invalid.", 502);
  }
  return body;
}

async function readCardSubtypeSearchResponse(
  response: Response,
): Promise<CardSubtypeMatch[]> {
  if (!response.ok) {
    throw new ApiError("Card subtypes are temporarily unavailable.", response.status);
  }
  const body: unknown = await response.json();
  if (
    !Array.isArray(body) ||
    !body.every(
      (subtype) =>
        isRecord(subtype) &&
        typeof subtype.name === "string" &&
        typeof subtype.match_score === "number" &&
        subtype.match_score >= 0 &&
        subtype.match_score <= 1,
    )
  ) {
    throw new ApiError("The card subtype response was invalid.", 502);
  }
  return body;
}

function isCardEnrichment(value: unknown): value is CardEnrichment {
  return (
    isRecord(value) &&
    typeof value.oracle_id === "string" &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (tag) =>
        isRecord(tag) &&
        typeof tag.id === "string" &&
        typeof tag.name === "string" &&
        typeof tag.slug === "string" &&
        (tag.description === null || typeof tag.description === "string"),
    ) &&
    isRelatedCardList(value.similar_cards) &&
    isRelatedCardList(value.references) &&
    isRelatedCardList(value.referenced_by) &&
    isRelatedCardList(value.upgrades) &&
    isRelatedCardList(value.downgrades) &&
    isRelatedCardList(value.variants) &&
    isRelatedCardList(value.creature_versions) &&
    isRelatedCardList(value.spell_versions) &&
    isRelatedCardList(value.related_cards)
  );
}

function isRelatedCardList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (card) =>
        isRecord(card) &&
        typeof card.oracle_id === "string" &&
        typeof card.name === "string",
    )
  );
}

function isSearchDebugSummary(value: unknown): value is SearchDebugSummary {
  return (
    isRecord(value) &&
    typeof value.trace_id === "string" &&
    typeof value.log_path === "string" &&
    typeof value.log_written === "boolean" &&
    typeof value.total_duration_ms === "number" &&
    isOptionalNumber(value.total_cost_usd) &&
    Array.isArray(value.stages) &&
    value.stages.every(
      (stage) =>
        isRecord(stage) &&
        typeof stage.name === "string" &&
        ["ok", "skipped", "error"].includes(String(stage.status)) &&
        typeof stage.duration_ms === "number" &&
        (stage.input_count === null ||
          typeof stage.input_count === "number") &&
        (stage.output_count === null ||
          typeof stage.output_count === "number"),
    ) &&
    isSearchDebugTrace(value.trace)
  );
}

function isSearchDebugTrace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.schema_version === "number" &&
    typeof value.trace_id === "string" &&
    typeof value.started_at === "string" &&
    typeof value.completed_at === "string" &&
    typeof value.total_duration_ms === "number" &&
    isRecord(value.request) &&
    isRecord(value.configuration) &&
    isRecord(value.decision) &&
    Array.isArray(value.stages) &&
    value.stages.every(
      (stage) =>
        isRecord(stage) &&
        typeof stage.name === "string" &&
        ["ok", "skipped", "error"].includes(String(stage.status)) &&
        typeof stage.duration_ms === "number",
    ) &&
    isRecord(value.result)
  );
}
