// Shapes served by GET /api/feed. The dashboard's feed column is written against these.

export type FeedKind = "news" | "tweet";

/** The kinds of item the feed can label (lib/feed-labels.ts). */
export const FEED_LABELS = ["breaking", "release", "announcement", "research", "event"] as const;
export type FeedLabel = (typeof FEED_LABELS)[number];

export type FeedItem = {
  /** Stable across refreshes: a hash of the source and the item's guid or URL. */
  id: string;
  kind: FeedKind;
  /** Publication or network name, e.g. "CoinDesk", "Bluesky". */
  source: string;
  /** Person or account display name, if the source gives one. */
  author: string | null;
  /** e.g. "@VitalikButerin" for posts, otherwise null. */
  handle: string | null;
  /** Headline, or the post text. Plain text: no markup, entities decoded. */
  title: string;
  /** One or two plain-text sentences for news when the feed has them; null for posts. */
  summary: string | null;
  url: string;
  /** ISO 8601. */
  publishedAt: string;
  /** https thumbnail, or null. */
  imageUrl: string | null;
  /** A current safety incident on or near campus: pinned above the scrolling feed. Only set on served items. */
  alert?: boolean;
  /** What kind of item this is, when the labelling model is sure of it. Only set on served items. */
  label?: FeedLabel;
};

export type FeedSourceStatus = {
  name: string;
  kind: FeedKind;
  ok: boolean;
  /** Usable items from this source in the last refresh (after the age cutoff and filters). */
  items: number;
  error: string | null;
};

/** Which model runner made a selection. */
export type FeedAgentName = "codex" | "claude-cli" | "claude-api";

export type FeedResponse = {
  status: "ok" | "degraded" | "empty" | "error";
  /** The curated selection in display order. */
  items: FeedItem[];
  /** When the selection was last made. */
  updatedAt: string | null;
  sources: FeedSourceStatus[];
  /** "agent" when a model (Codex or Claude) picked the items, "fallback" when the deterministic ordering was used. */
  curation: "agent" | "fallback";
  /** Which agent picked the current selection; null when the fallback ordering is showing. */
  agent: FeedAgentName | null;
  /** The model that agent ran, e.g. "gpt-6-luna" or "claude-haiku-4-5"; null with the fallback. */
  agentModel: string | null;
  message?: string;
};

/**
 * A token that is in the news, with the note shown beside it. Served by GET /api/newsworthy.
 * Everything but `summary` is taken from fixed lists (the token universe and the feed sources);
 * `summary` is written by a model and checked in lib/newsworthy.ts before it gets here.
 */
export type NewsworthyToken = {
  symbol: string;
  name: string;
  /** Where its price is read: Hyperliquid's perpetual market, or Gate's spot market. */
  venue: "hyperliquid" | "gate";
  /** The market's id at that venue, e.g. "LINK", "kPEPE" or "ABC_USDT". */
  market: string;
  /** Tokens per contract at the venue (1,000 for Hyperliquid's "k" markets, otherwise 1). */
  lot: number;
  /** One or two plain-text sentences. */
  summary: string;
  /** The outlets whose reports the summary is drawn from. */
  outlets: string[];
  /** ISO 8601: when the newest of those reports was published. */
  newestAt: string;
};

export type NewsworthyResponse = {
  /** "off": no agent is configured, so there is nothing to show. "error": the list could not be made lately. */
  status: "ok" | "empty" | "off" | "error";
  tokens: NewsworthyToken[];
  /** When the list was last made or confirmed. */
  updatedAt: string | null;
  agent: FeedAgentName | null;
  agentModel: string | null;
  message?: string;
};
