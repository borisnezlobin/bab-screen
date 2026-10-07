// Where the news-and-posts feed comes from, and how often. Edit the lists here; nothing else needs
// to change. Every URL below was fetched and checked for recent items on 2026-10-01 (the AI, developer and
// campus-safety feeds on 2026-10-02).

/** A selection is made this often while a screen is polling /api/feed. One model call each. */
export const REFRESH_MINUTES = 15;
/** The refresh loop pauses when nobody has asked for the feed for this long (the page polls every minute). */
export const IDLE_PAUSE_MINUTES = 10;
/** Items older than this are ignored unless the source sets its own maxAgeHours. */
export const MAX_AGE_HOURS = 36;
/** At most this many candidates are shown to the agent. */
export const MAX_CANDIDATES = 120;
/** At most this many of one source's newest items become candidates. */
export const PER_SOURCE_CANDIDATES = 10;
/** At most this many of one account's newest posts become candidates. */
export const PER_ACCOUNT_CANDIDATES = 2;
/** How many items the agent is asked for, and the most that are ever served. */
export const TARGET_ITEMS = 20;
export const MAX_ITEMS = 25;
/** Fewer valid picks than this from the agent and the deterministic ordering is used instead. */
export const MIN_AGENT_PICKS = 10;
/** An item the model files under `alerts` is pinned only while it is newer than this. */
export const ALERT_MAX_AGE_HOURS = 12;
/** Ids from this many previous selections are marked "shown" so the next one rotates. */
export const HISTORY_SELECTIONS = 2;

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2_000_000;
export const FETCH_CONCURRENCY = 6;
export const USER_AGENT = "bab-screen/0.1 (Blockchain at Berkeley wall display; RSS reader)";

export type RssSource = {
  /** Shown on screen as the item's source. */
  name: string;
  url: string;
  /** Overrides MAX_AGE_HOURS; blogs that post rarely get a longer window. */
  maxAgeHours?: number;
  /** Fetch at most this often (default: every refresh). */
  everyMinutes?: number;
};

// RSS and Atom feeds. All keyless. Order matters only as a tie-break.
export const NEWS_FEEDS: RssSource[] = [
  // Crypto news desks
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "The Defiant", url: "https://thedefiant.io/api/feed" },
  { name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/feed" },
  { name: "Unchained", url: "https://unchainedcrypto.com/feed/" },
  { name: "Protos", url: "https://protos.com/feed/" },
  { name: "Bankless", url: "https://www.bankless.com/rss/feed", everyMinutes: 30 },
  // Technology and AI
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", everyMinutes: 30 },
  // AI labs and developer platforms: their own announcements of models, features and research. A few
  // posts a week each, so a three-day window.
  { name: "OpenAI", url: "https://openai.com/news/rss.xml", maxAgeHours: 72, everyMinutes: 30 },
  { name: "Google AI", url: "https://blog.google/technology/ai/rss/", maxAgeHours: 72, everyMinutes: 30 },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml", maxAgeHours: 72, everyMinutes: 30 },
  { name: "Cloudflare", url: "https://blog.cloudflare.com/rss/", maxAgeHours: 72, everyMinutes: 30 },
  { name: "GitHub", url: "https://github.blog/feed/", maxAgeHours: 72, everyMinutes: 60 },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", maxAgeHours: 48, everyMinutes: 30 },
  // Research and protocol blogs: a post a week at most, so a longer window and an hourly fetch
  { name: "Ethereum Foundation", url: "https://blog.ethereum.org/feed.xml", maxAgeHours: 7 * 24, everyMinutes: 60 },
  { name: "Vitalik Buterin", url: "https://vitalik.eth.limo/feed.xml", maxAgeHours: 7 * 24, everyMinutes: 60 },
  { name: "a16z crypto", url: "https://a16zcrypto.com/feed/", maxAgeHours: 7 * 24, everyMinutes: 60 },
  // Berkeley. The Daily Californian and The Berkeley Scanner report campus and city safety incidents within
  // the hour; they are fetched every refresh. Berkeley News is limited to its technology and engineering
  // section, and EECS to the department's own news: the campus-wide feed is mostly research from other fields.
  { name: "The Daily Californian", url: "https://www.dailycal.org/search/?f=rss&t=article&l=50&s=start_time&sd=desc" },
  { name: "The Berkeley Scanner", url: "https://www.berkeleyscanner.com/feed/" },
  { name: "Berkeley News", url: "https://news.berkeley.edu/category/research/technology-engineering/feed/", maxAgeHours: 7 * 24, everyMinutes: 60 },
  { name: "Berkeley EECS", url: "https://eecs.berkeley.edu/news/feed/", maxAgeHours: 7 * 24, everyMinutes: 60 },
  // The club's own Substack. Last post April 2024; listed so a new post shows up by itself.
  { name: "Blockchain at Berkeley", url: "https://blockchainatberkeley.substack.com/feed", maxAgeHours: 14 * 24, everyMinutes: 60 },
];

// Hacker News front page through the HN Search API (run by Algolia for Y Combinator): one keyless
// request instead of 31 against the Firebase API. Only stories with at least minPoints are used.
export const HACKER_NEWS = {
  name: "Hacker News",
  url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30",
  minPoints: 150,
};

// Bluesky's public AppView (public.api.bsky.app) needs no key. These accounts were posting in the
// week before 2026-10-01. Shown as kind "tweet" with source "Bluesky".
// Honest note: crypto founders are mostly absent from Bluesky; this list is technology, AI and
// security voices plus Vitalik and the campus account. Set FEED_BLUESKY=off to drop the source.
export const BLUESKY = {
  name: "Bluesky",
  api: "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed",
  maxAgeHours: 48,
  postsPerAccount: 15,
  accounts: [
    "vitalik.ca",
    "emollick.bsky.social",
    "simonwillison.net",
    "gergely.pragmaticengineer.com",
    "caseynewton.bsky.social",
    "antirez.bsky.social",
    "filippo.abyssdomain.expert",
    "web3isgoinggreat.com",
    "eff.org",
    "ucberkeleyofficial.bsky.social",
  ],
};
