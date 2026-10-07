// Fetchers for the feed's sources: RSS/Atom, Hacker News and Bluesky. Each returns a
// SourceResult and never throws, so one broken source cannot sink a refresh.

import {
  BLUESKY,
  FETCH_CONCURRENCY,
  FETCH_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  HACKER_NEWS,
  MAX_AGE_HOURS,
  NEWS_FEEDS,
  USER_AGENT,
  type RssSource,
} from "./feed-sources";
import { canonicalUrl, clip, decodeEntities, httpsImage, makeId, parseFeed, rejectReason, tidy } from "./feed-parse";
import type { FeedItem, FeedKind } from "./feed-types";

export type SourceResult = {
  name: string;
  kind: FeedKind;
  ok: boolean;
  items: FeedItem[];
  error: string | null;
};

/** What is remembered about one HTTP source between refreshes. */
export type SourceCache = {
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  items: FeedItem[];
};

export type FetchContext = {
  now: number;
  caches: Map<string, SourceCache>;
};

const POST_MAX = 400;
const POST_MIN = 30;

const BSKY_WWW_RE = /^www\./;
const BSKY_HANDLE_RE = /^[a-z0-9.-]+$/i;
const BSKY_KEY_RE = /^[a-z0-9]+$/i;
const HN_ID_RE = /^\d+$/;
const NETWORK_DETAIL_RE = /^[A-Z0-9_]{3,40}$/;

class HttpError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

type ErrorCause = { code?: unknown; name?: unknown };

function causeDetail(error: unknown): string | null {
  const cause = error instanceof Error ? (error.cause as ErrorCause | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : typeof cause?.name === "string" ? cause.name : null;
}

function networkErrorCode(detail: string | null): string {
  return detail && NETWORK_DETAIL_RE.test(detail) ? `network_error (${detail})` : "network_error";
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const detail = causeDetail(error);
  if (detail === "TimeoutError" || detail === "AbortError" || detail === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (error instanceof TypeError) return networkErrorCode(detail);
  return `internal_error${name ? ` (${name.slice(0, 40)})` : ""}`;
}

/** Reads at most `limit` bytes of a body, so a runaway response cannot fill memory. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, limit);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    cache: "no-store",
  });
  if (response.status === 304) return { status: 304, headers: response.headers, body: "" };
  return { status: response.status, headers: response.headers, body: await readCapped(response, FETCH_MAX_BYTES) };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await get(url, { Accept: "application/json", ...headers });
  if (response.status < 200 || response.status >= 300) throw new HttpError(`http_${response.status}`);
  try {
    return JSON.parse(response.body);
  } catch {
    throw new HttpError("bad_json");
  }
}

async function mapLimit<T, R>(inputs: T[], limit: number, worker: (input: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, async () => {
      while (next < inputs.length) {
        const index = next++;
        results[index] = await worker(inputs[index]);
      }
    }),
  );
  return results;
}

const fresh = (items: FeedItem[], now: number, maxAgeHours: number) =>
  items.filter((item) => now - Date.parse(item.publishedAt) <= maxAgeHours * 3_600_000);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

// --- RSS / Atom ----------------------------------------------------------------------------------

function buildRssConditionalHeaders(cache: SourceCache | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5" };
  if (cache?.etag) headers["If-None-Match"] = cache.etag;
  if (cache?.lastModified) headers["If-Modified-Since"] = cache.lastModified;
  return headers;
}

type EntryWithCategories = FeedItem & { categories: string[] };

function filterRssItems(entries: EntryWithCategories[], now: number, maxAge: number): FeedItem[] {
  const items: FeedItem[] = [];
  for (const { categories, ...item } of fresh(entries, now, maxAge) as EntryWithCategories[]) {
    if (!rejectReason(item, categories)) items.push(item);
  }
  return items;
}

async function attemptRssFetch(source: RssSource, context: FetchContext, cache: SourceCache | undefined, maxAge: number): Promise<FeedItem[]> {
  const headers = buildRssConditionalHeaders(cache);
  const response = await get(source.url, headers);
  if (response.status === 304 && cache) {
    cache.fetchedAt = context.now;
    return fresh(cache.items, context.now, maxAge);
  }
  if (response.status < 200 || response.status >= 300) throw new HttpError(`http_${response.status}`);
  const parsed = parseFeed(response.body, source.name, context.now);
  if (!parsed.recognised) throw new HttpError("not_a_feed");
  const items = filterRssItems(parsed.entries as EntryWithCategories[], context.now, maxAge);
  context.caches.set(source.name, {
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    fetchedAt: context.now,
    items,
  });
  return items;
}

async function fetchRss(source: RssSource, context: FetchContext): Promise<SourceResult> {
  const maxAge = source.maxAgeHours ?? MAX_AGE_HOURS;
  const cache = context.caches.get(source.name);
  const cachedItems = (): FeedItem[] => { return fresh(cache ? cache.items : [], context.now, maxAge); };
  if (cache && source.everyMinutes && context.now - cache.fetchedAt < source.everyMinutes * 60_000 - 30_000) {
    return { name: source.name, kind: "news", ok: true, items: cachedItems(), error: null };
  }
  try {
    const items = await attemptRssFetch(source, context, cache, maxAge);
    return { name: source.name, kind: "news", ok: true, items, error: null };
  } catch (error) {
    // Keep showing what the last good fetch had while the source is down.
    return { name: source.name, kind: "news", ok: false, items: cachedItems(), error: errorCode(error) };
  }
}

// --- Hacker News ---------------------------------------------------------------------------------

function hnItemId(hit: Record<string, unknown>): string | null {
  return text(hit.objectID) ?? (typeof hit.story_id === "number" ? String(hit.story_id) : null);
}

function parseHnHit(hit: Record<string, unknown>, name: string, now: number): FeedItem | null {
  const title = text(hit.title);
  const id = hnItemId(hit);
  const published = Date.parse(text(hit.created_at) ?? "");
  if (!title || !id || !HN_ID_RE.test(id) || !Number.isFinite(published)) return null;
  if (typeof hit.points !== "number" || hit.points < HACKER_NEWS.minPoints) return null;
  return {
    id: makeId(name, id),
    kind: "news",
    source: name,
    author: null,
    handle: null,
    title: clip(tidy(decodeEntities(title)), 220),
    summary: null,
    url: canonicalUrl(text(hit.url)) ?? `https://news.ycombinator.com/item?id=${id}`,
    publishedAt: new Date(Math.min(published, now)).toISOString(),
    imageUrl: null,
  };
}

function cachedSourceItems(caches: Map<string, SourceCache>, name: string, now: number, maxAgeHours: number): FeedItem[] {
  const prior = caches.get(name);
  return fresh(prior ? prior.items : [], now, maxAgeHours);
}

async function fetchHackerNews(context: FetchContext): Promise<SourceResult> {
  const name = HACKER_NEWS.name;
  try {
    const data = await getJson(HACKER_NEWS.url);
    const hits = isRecord(data) && Array.isArray(data.hits) ? data.hits : null;
    if (!hits) throw new HttpError("unexpected_shape");
    const items: FeedItem[] = [];
    for (const hit of hits) {
      if (!isRecord(hit)) continue;
      const item = parseHnHit(hit, name, context.now);
      if (item && !rejectReason(item)) items.push(item);
    }
    const kept = fresh(items, context.now, MAX_AGE_HOURS);
    context.caches.set(name, { fetchedAt: context.now, items: kept });
    return { name, kind: "news", ok: true, items: kept, error: null };
  } catch (error) {
    return { name, kind: "news", ok: false, items: cachedSourceItems(context.caches, name, context.now, MAX_AGE_HOURS), error: errorCode(error) };
  }
}

// --- Bluesky -------------------------------------------------------------------------------------

function extractFeatureHost(feature: unknown, byteStart: number, byteEnd: number): { start: number; end: number; host: string } | null {
  if (!isRecord(feature) || feature.$type !== "app.bsky.richtext.facet#link") return null;
  try {
    return { start: byteStart, end: byteEnd, host: new URL(String(feature.uri)).hostname.replace(BSKY_WWW_RE, "") };
  } catch {
    return null;
  }
}

function extractFacetLinks(facets: unknown[]): { start: number; end: number; host: string }[] {
  const links: { start: number; end: number; host: string }[] = [];
  for (const facet of facets) {
    if (!isRecord(facet) || !isRecord(facet.index) || !Array.isArray(facet.features)) continue;
    const { byteStart, byteEnd } = facet.index as { byteStart: number; byteEnd: number };
    if (typeof byteStart !== "number" || typeof byteEnd !== "number" || byteEnd <= byteStart) continue;
    for (const feature of facet.features) {
      const link = extractFeatureHost(feature, byteStart, byteEnd);
      if (link) links.push(link);
    }
  }
  return links;
}

function applyLinkReplacements(raw: string, links: { start: number; end: number; host: string }[]): string {
  if (!links.length) return tidy(raw);
  const bytes = Buffer.from(raw, "utf8");
  let out = "";
  let at = 0;
  for (const link of links.sort((a, b) => a.start - b.start)) {
    if (link.start < at || link.end > bytes.length) continue;
    out += bytes.subarray(at, link.start).toString("utf8") + link.host;
    at = link.end;
  }
  return tidy(out + bytes.subarray(at).toString("utf8"));
}

/** Post text with each link facet (shown truncated, "example.com/a-long-pa...") replaced by its host. */
function blueskyText(record: Record<string, unknown>): string {
  const raw = text(record.text) ?? "";
  const facets = Array.isArray(record.facets) ? record.facets : [];
  return applyLinkReplacements(raw, extractFacetLinks(facets));
}

function hasContentLabel(post: Record<string, unknown>, record: Record<string, unknown>): boolean {
  if (Array.isArray(post.labels) && post.labels.length) return true;
  if (isRecord(record.labels) && Array.isArray(record.labels.values) && record.labels.values.length) return true;
  return false;
}

function isEnglishPost(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.langs) || !record.langs.length) return true;
  return record.langs.some((lang) => typeof lang === "string" && lang.toLowerCase().startsWith("en"));
}

function blueskyPostFields(entry: Record<string, unknown>): { post: Record<string, unknown>; record: Record<string, unknown>; author: Record<string, unknown> } | null {
  if (entry.reason || entry.reply) return null;
  const post = entry.post;
  if (!isRecord(post) || !isRecord(post.record) || !isRecord(post.author)) return null;
  const record = post.record;
  if (record.reply) return null;
  if (hasContentLabel(post, record)) return null;
  if (!isEnglishPost(record)) return null;
  return { post, record, author: post.author as Record<string, unknown> };
}

function blueskyPostIds(rawHandle: string | null, rawUri: string | null): { key: string; handle: string; uri: string } | null {
  if (!rawHandle || !rawUri) return null;
  if (!BSKY_HANDLE_RE.test(rawHandle)) return null;
  const key = rawUri.split("/").pop();
  if (!key || !BSKY_KEY_RE.test(key)) return null;
  return { key, handle: rawHandle, uri: rawUri };
}

function blueskyPostImage(post: Record<string, unknown>): string | null {
  const embed = isRecord(post.embed) ? post.embed : null;
  const firstImage = embed && Array.isArray(embed.images) && isRecord(embed.images[0]) ? text(embed.images[0].thumb) : null;
  const external = embed && isRecord(embed.external) ? text(embed.external.thumb) : null;
  return httpsImage(firstImage ?? external);
}

function buildBlueskyItem(post: Record<string, unknown>, record: Record<string, unknown>, author: Record<string, unknown>, now: number): FeedItem | null {
  const ids = blueskyPostIds(text(author.handle), text(post.uri));
  const published = Date.parse(text(record.createdAt) ?? "");
  if (!ids || !Number.isFinite(published)) return null;
  const body = blueskyText(record);
  if (body.length < POST_MIN) return null;
  return {
    id: makeId(BLUESKY.name, ids.uri),
    kind: "tweet",
    source: BLUESKY.name,
    author: text(author.displayName) ? tidy(String(author.displayName)) : ids.handle,
    handle: `@${ids.handle}`,
    title: clip(body, POST_MAX),
    summary: null,
    url: `https://bsky.app/profile/${ids.handle}/post/${ids.key}`,
    publishedAt: new Date(Math.min(published, now)).toISOString(),
    imageUrl: blueskyPostImage(post),
  };
}

function blueskyPosts(data: unknown, now: number): FeedItem[] {
  const feed = isRecord(data) && Array.isArray(data.feed) ? data.feed : null;
  if (!feed) throw new HttpError("unexpected_shape");
  const items: FeedItem[] = [];
  for (const entry of feed) {
    if (!isRecord(entry)) continue;
    const fields = blueskyPostFields(entry);
    if (!fields) continue;
    const item = buildBlueskyItem(fields.post, fields.record, fields.author, now);
    if (item && !rejectReason(item)) items.push(item);
  }
  return items;
}

async function fetchBluesky(context: FetchContext): Promise<SourceResult> {
  const name = BLUESKY.name;
  const failures: string[] = [];
  const perAccount = await mapLimit(BLUESKY.accounts, 3, async (actor) => {
    const key = `${name}:${actor}`;
    try {
      const url = `${BLUESKY.api}?actor=${encodeURIComponent(actor)}&limit=${BLUESKY.postsPerAccount}&filter=posts_no_replies`;
      const items = fresh(blueskyPosts(await getJson(url), context.now), context.now, BLUESKY.maxAgeHours);
      context.caches.set(key, { fetchedAt: context.now, items });
      return items;
    } catch (error) {
      failures.push(`${actor}: ${errorCode(error)}`);
      return fresh(context.caches.get(key)?.items ?? [], context.now, BLUESKY.maxAgeHours);
    }
  });
  const allFailed = failures.length === BLUESKY.accounts.length && BLUESKY.accounts.length > 0;
  return {
    name,
    kind: "tweet",
    ok: !allFailed,
    items: perAccount.flat(),
    error: failures.length ? clip(`${failures.length} of ${BLUESKY.accounts.length} accounts failed (${failures.join(", ")})`, 200) : null,
  };
}

// --- All sources ---------------------------------------------------------------------------------

/** Fetches every configured source once. Never throws. The order is the order of `sources` in the API. */
export async function gatherSources(context: FetchContext): Promise<SourceResult[]> {
  const jobs: (() => Promise<SourceResult>)[] = [
    ...NEWS_FEEDS.map((source) => () => fetchRss(source, context)),
    () => fetchHackerNews(context),
  ];
  if ((process.env.FEED_BLUESKY ?? "").toLowerCase() !== "off" && BLUESKY.accounts.length) jobs.push(() => fetchBluesky(context));
  return mapLimit(jobs, FETCH_CONCURRENCY, async (job) => {
    try {
      return await job();
    } catch {
      return { name: "unknown", kind: "news" as const, ok: false, items: [], error: "internal_error" };
    }
  });
}
