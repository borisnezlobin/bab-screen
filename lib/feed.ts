// News-and-posts feed for the wall: gathers candidates from the sources in feed-sources.ts,
// has a model pick about twenty (feed-agent.ts: Codex by default, or Claude), and serves the
// selection from memory.
//
// GET /api/feed never waits for any of that. It answers from the last selection (kept in memory
// and in .data/feed.json, so a restart shows it at once) and starts a refresh in the background
// when the selection is older than REFRESH_MINUTES. The loop only runs while a screen is asking:
// after IDLE_PAUSE_MINUTES without a request it stops fetching and stops calling the model.
//
// The same refresh also feeds lib/newsworthy.ts (tokens in the news, served by /api/newsworthy).

import { AgentError, agentPlan, fallbackOrder, pickWithAgent, type AgentAttempt } from "./feed-agent";
import { labelItems } from "./feed-labels";
import { gatherSources, type SourceCache, type SourceResult } from "./feed-fetch";
import { cluster } from "./feed-parse";
import {
  ALERT_MAX_AGE_HOURS,
  HISTORY_SELECTIONS,
  IDLE_PAUSE_MINUTES,
  MAX_CANDIDATES,
  MAX_ITEMS,
  PER_ACCOUNT_CANDIDATES,
  PER_SOURCE_CANDIDATES,
  REFRESH_MINUTES,
  TARGET_ITEMS,
} from "./feed-sources";
import { refreshNewsworthy } from "./newsworthy";
import { readJson, writeJson } from "./songs-store";
import type { FeedAgentName, FeedItem, FeedResponse, FeedSourceStatus } from "./feed-types";

export type { FeedAgentName, FeedItem, FeedResponse, FeedSourceStatus } from "./feed-types";

const STATE_FILE = "feed.json";
const STATE_VERSION = 1;
/** The loop wakes this often to see whether a refresh is due. */
const TICK_MS = 60_000;
/** After a refresh that produced nothing, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;
/** A selection older than this is reported as "degraded". */
const STALE_AFTER_MS = 3 * REFRESH_MINUTES * 60_000;

/** How the last curation went: who produced it (null if nobody did) and everyone who was tried. */
type AgentReport = { at: string; agent: FeedAgentName | null; model: string | null; ms: number | null; ok: boolean; error: string | null; attempts: AgentAttempt[] };

type Stored = {
  version: number;
  items: FeedItem[];
  updatedAt: string | null;
  curation: "agent" | "fallback";
  sources: FeedSourceStatus[];
  /** Ids of the last HISTORY_SELECTIONS selections, newest first. */
  history: string[][];
  /** Diagnostics for the last curation call; not part of the API. */
  agent: AgentReport | null;
};

// On globalThis so every copy of this module (route bundles, dev-mode reloads) shares one loop.
type Runtime = {
  state: Stored;
  loaded: Promise<void> | null;
  refreshing: Promise<void> | null;
  /** When the last refresh finished, and whether it produced a selection. */
  lastRefreshAt: number;
  lastRefreshFailed: boolean;
  lastError: string | null;
  lastRequestAt: number;
  caches: Map<string, SourceCache>;
  timer?: ReturnType<typeof setInterval>;
  tick?: () => void;
};

function emptyState(): Stored {
  return { version: STATE_VERSION, items: [], updatedAt: null, curation: "fallback", sources: [], history: [], agent: null };
}

const globalStore = globalThis as typeof globalThis & { __babFeed?: Runtime };
const runtime: Runtime = (globalStore.__babFeed ??= {
  state: emptyState(),
  loaded: null,
  refreshing: null,
  lastRefreshAt: 0,
  lastRefreshFailed: false,
  lastError: null,
  lastRequestAt: 0,
  caches: new Map(),
});

function refreshMs(): number {
  const minutes = Number(process.env.FEED_REFRESH_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 5 ? minutes : REFRESH_MINUTES) * 60_000;
}

const HTTPS_RE = /^https?:\/\//;

function isValidUrl(url: unknown): url is string {
  return typeof url === "string" && HTTPS_RE.test(url);
}

function isValidFeedItem(item: Record<string, unknown>): boolean {
  return (
    typeof item.id === "string" &&
    (item.kind === "news" || item.kind === "tweet") &&
    typeof item.source === "string" &&
    typeof item.title === "string" &&
    isValidUrl(item.url) &&
    typeof item.publishedAt === "string" &&
    Number.isFinite(Date.parse(item.publishedAt as string))
  );
}

const isItem = (value: unknown): value is FeedItem => {
  if (typeof value !== "object" || value === null) return false;
  return isValidFeedItem(value as Record<string, unknown>);
};

function hydrateStoredState(state: Stored, stored: Partial<Stored>): void {
  if (Array.isArray(stored.items)) state.items = stored.items.filter(isItem).slice(0, MAX_ITEMS);
  if (typeof stored.updatedAt === "string" && Number.isFinite(Date.parse(stored.updatedAt))) state.updatedAt = stored.updatedAt;
  if (stored.curation === "agent") state.curation = "agent";
  if (Array.isArray(stored.sources)) state.sources = stored.sources;
  if (Array.isArray(stored.history)) {
    state.history = stored.history
      .filter(Array.isArray)
      .slice(0, HISTORY_SELECTIONS)
      .map((ids) => ids.filter((id): id is string => typeof id === "string"));
  }
  if (stored.agent && typeof stored.agent === "object") state.agent = stored.agent as AgentReport;
  if (!state.items.length) state.updatedAt = null;
}

/** Reads .data/feed.json once per process. A missing, old or damaged file just means starting empty. */
function load(): Promise<void> {
  return (runtime.loaded ??= (async () => {
    const stored = await readJson<Partial<Stored>>(STATE_FILE);
    if (!stored || stored.version !== STATE_VERSION) return;
    const state = emptyState();
    hydrateStoredState(state, stored);
    runtime.state = state;
    // A restart inside the refresh interval shows the stored selection and waits its turn.
    if (state.updatedAt) runtime.lastRefreshAt = Date.parse(state.updatedAt);
  })());
}

async function save(): Promise<void> {
  try {
    await writeJson(STATE_FILE, runtime.state);
  } catch (error) {
    console.warn("[feed] could not save .data/feed.json:", error instanceof Error ? error.message : error);
  }
}

/** A story carried by at least this many sources may stay on screen two selections running. */
const MAJOR_STORY_OUTLETS = 3;

/**
 * Newest items of every source, deduped across outlets and capped so one prompt holds them all.
 * `outlets` says how many sources carried each story that more than one did.
 *
 * Rotation is built in here rather than left to the model: whatever was in the last selection
 * (`lastShown`) is not offered again this time, except stories big enough to be covered by
 * MAJOR_STORY_OUTLETS sources. When that would leave too little to choose from, everything is
 * offered and the "shown" marks in the prompt do the work.
 */
export function buildCandidates(results: SourceResult[], lastShown: string[] = []): { pool: FeedItem[]; outlets: Map<string, number> } {
  const newestFirst = (a: FeedItem, b: FeedItem) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  const stories = cluster(results.flatMap((result) => result.items));
  const outlets = new Map(stories.filter((story) => story.outlets > 1).map((story) => [story.item.id, story.outlets]));
  const shown = new Set(lastShown);
  const rested = stories.filter((story) => !shown.has(story.item.id) || story.outlets >= MAJOR_STORY_OUTLETS);
  const offered = rested.length >= 2 * TARGET_ITEMS ? rested : stories;
  const groups = new Map<string, FeedItem[]>();
  const perAccount = new Map<string, number>();
  for (const item of offered.map((story) => story.item).sort(newestFirst)) {
    if (item.kind === "tweet") {
      // One prolific account must not use up the network's whole share of the candidate list.
      const account = `${item.source} ${item.handle ?? ""}`;
      const count = (perAccount.get(account) ?? 0) + 1;
      perAccount.set(account, count);
      if (count > PER_ACCOUNT_CANDIDATES) continue;
    }
    const group = groups.get(item.source);
    if (!group) groups.set(item.source, [item]);
    else if (group.length < PER_SOURCE_CANDIDATES) group.push(item);
  }
  // Take turns between sources so the cap cannot squeeze a quiet source out.
  const picked: FeedItem[] = [];
  for (let round = 0; round < PER_SOURCE_CANDIDATES && picked.length < MAX_CANDIDATES; round += 1) {
    for (const group of groups.values()) {
      if (group[round] && picked.length < MAX_CANDIDATES) picked.push(group[round]);
    }
  }
  return { pool: picked.sort(newestFirst), outlets };
}

/** A pick the model filed under `alerts`, still recent enough to pin above the feed. */
function isLiveAlert(item: FeedItem, alerts: ReadonlySet<string>, now: number) {
  return alerts.has(item.id) && now - Date.parse(item.publishedAt) < ALERT_MAX_AGE_HOURS * 3_600_000;
}

function publish(ids: string[], pool: FeedItem[], curation: "agent" | "fallback", now: number, remember: boolean, alerts: ReadonlySet<string> = new Set()) {
  const byId = new Map(pool.map((item) => [item.id, item]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((item): item is FeedItem => Boolean(item))
    .slice(0, MAX_ITEMS)
    .map((item) => (isLiveAlert(item, alerts, now) ? { ...item, alert: true } : item));
  if (!items.length) return;
  const state = runtime.state;
  state.items = items;
  state.curation = curation;
  state.updatedAt = new Date(now).toISOString();
  if (remember) state.history = [items.map((item) => item.id), ...state.history].slice(0, HISTORY_SELECTIONS);
}

async function refresh(): Promise<void> {
  const now = Date.now();
  const state = runtime.state;
  const results = await gatherSources({ now, caches: runtime.caches });
  state.sources = results.map(({ name, kind, ok, items, error }) => ({ name, kind, ok, items: items.length, error }));
  const { pool, outlets } = buildCandidates(results, state.history[0]);
  if (!pool.length) {
    // Nothing usable: keep whatever is on screen and say why.
    runtime.lastRefreshFailed = true;
    runtime.lastError = results.some((result) => result.ok) ? "no recent items in any source" : "no source could be reached";
    await save();
    return;
  }
  runtime.lastRefreshFailed = false;
  runtime.lastError = null;

  // First selection ever: put the plain ordering up now rather than wait for the model.
  if (!state.items.length) publish(fallbackOrder(pool, state.history), pool, "fallback", now, false);

  try {
    const outcome = await pickWithAgent(pool, state.history, now, outlets);
    publish(outcome.ids, pool, "agent", Date.now(), true, new Set(outcome.alerts));
    state.agent = { at: new Date().toISOString(), agent: outcome.agent, model: outcome.model, ms: outcome.ms, ok: true, error: null, attempts: outcome.attempts };
  } catch (error) {
    const code = error instanceof AgentError ? error.code : "internal_error";
    publish(fallbackOrder(pool, state.history), pool, "fallback", Date.now(), true);
    state.agent = { at: new Date().toISOString(), agent: null, model: null, ms: null, ok: false, error: code, attempts: error instanceof AgentError ? error.attempts : [] };
    if (agentPlan().order.length) console.warn(`[feed] AI curation failed (${code}); using the fallback ordering`);
  }
  state.items = await labelItems(state.items);
  await save();
  // The newsworthy tokens are chosen from the same fetch, after the feed is up. It keeps its own
  // schedule (not every refresh) and its own state, and never rejects.
  await refreshNewsworthy(results, Date.now());
}

/**
 * Runs one refresh unless one is already running (overlapping calls share it). Never rejects.
 * `force` skips the interval check; it is for scripts and tests, not for the route.
 */
export function refreshFeed(options: { force?: boolean } = {}): Promise<void> {
  if (runtime.refreshing) return runtime.refreshing;
  const wait = runtime.lastRefreshFailed ? RETRY_AFTER_FAILURE_MS : refreshMs();
  if (!options.force && runtime.lastRefreshAt && Date.now() - runtime.lastRefreshAt < wait) return Promise.resolve();
  runtime.refreshing = (async () => {
    try {
      await load();
      await refresh();
    } catch (error) {
      runtime.lastRefreshFailed = true;
      runtime.lastError = "refresh failed";
      console.warn("[feed] refresh failed:", error instanceof Error ? error.message : error);
    } finally {
      runtime.lastRefreshAt = Date.now();
      runtime.refreshing = null;
    }
  })();
  return runtime.refreshing;
}

runtime.tick = () => {
  // Nobody is looking: no fetches, no model calls.
  if (Date.now() - runtime.lastRequestAt > IDLE_PAUSE_MINUTES * 60_000) return;
  void refreshFeed();
};

/** Starts the background loop. Safe to call on every request: there is one timer per server process. */
export function ensureFeedLoop(): void {
  if (!runtime.timer) {
    runtime.timer = setInterval(() => runtime.tick?.(), TICK_MS);
    runtime.timer.unref?.();
  }
}

function pickedAgent(state: Stored): AgentReport | null {
  return state.curation === "agent" && state.agent && state.agent.ok ? state.agent : null;
}

function feedBaseResponse(state: Stored) {
  const picked = pickedAgent(state);
  return {
    items: state.items,
    updatedAt: state.updatedAt,
    sources: state.sources,
    curation: state.curation,
    agent: picked ? picked.agent : null,
    agentModel: picked ? picked.model : null,
  };
}

function failingSourceNote(failing: FeedSourceStatus[]): string | null {
  if (!failing.length) return null;
  return `${failing.length} source${failing.length === 1 ? "" : "s"} failing: ${failing.map((source) => source.name).join(", ")}`;
}

function agentCurationNote(state: Stored): string | null {
  const agentError = state.agent ? state.agent.error : null;
  if (state.curation !== "fallback" || !agentError || agentError === "agent_off") return null;
  return `AI curation unavailable (${agentError}); showing the newest items`;
}

function feedStatusNotes(state: Stored, stale: boolean, failing: FeedSourceStatus[]): string[] {
  const notes: (string | null)[] = [
    stale ? "selection is stale" : null,
    runtime.lastRefreshFailed ? (runtime.lastError ?? "last refresh failed") : null,
    failingSourceNote(failing),
    agentCurationNote(state),
  ];
  return notes.filter(Boolean) as string[];
}

function response(): FeedResponse {
  const state = runtime.state;
  const base = feedBaseResponse(state);
  if (!state.items.length) {
    if (runtime.lastRefreshFailed) return { status: "error", ...base, message: runtime.lastError ?? "refresh failed" };
    return { status: "empty", ...base, message: "First refresh in progress" };
  }
  const failing = state.sources.filter((source) => !source.ok);
  const stale = state.updatedAt !== null && Date.now() - Date.parse(state.updatedAt) > STALE_AFTER_MS;
  const notes = feedStatusNotes(state, stale, failing);
  const degraded = stale || runtime.lastRefreshFailed || failing.length > 0;
  return { status: degraded ? "degraded" : "ok", ...base, ...(notes.length ? { message: notes.join("; ") } : {}) };
}

/**
 * The current selection, immediately. Starts the loop and, if the selection is due, a refresh in
 * the background; the caller gets what is in memory now and the next poll gets the new one.
 */
export async function getFeed(): Promise<FeedResponse> {
  runtime.lastRequestAt = Date.now();
  try {
    await load();
  } catch {
    // Start empty.
  }
  ensureFeedLoop();
  void refreshFeed();
  return response();
}
