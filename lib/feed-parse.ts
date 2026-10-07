// Dependency-free RSS 2.0 / Atom extraction and the text hygiene shared by every feed source:
// HTML stripping, entity decoding, link cleaning, filler filters and cross-outlet dedupe.
// It is an extractor, not an XML parser: it reads the handful of tags a news feed uses and
// ignores everything else, so a malformed feed yields fewer items rather than an exception.

import { createHash } from "node:crypto";
import type { FeedItem } from "./feed-types";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°", middot: "·",
  bull: "•", times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", para: "¶",
  sect: "§", eacute: "é", egrave: "è", aacute: "á", agrave: "à", iacute: "í", oacute: "ó", uacute: "ú",
  ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä", ccedil: "ç", szlig: "ß", shy: "", zwnj: "", zwj: "",
  ensp: " ", emsp: " ", thinsp: " ", rarr: "→", larr: "←",
};

function decodeNumericRef(body: string): string {
  const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
  return String.fromCodePoint(code);
}

function decodeEntityRef(whole: string, body: string): string {
  if (body[0] === "#") return decodeNumericRef(body);
  const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
  return named === undefined ? whole : named;
}

/** Decodes numeric and common named character references once. Unknown ones are left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,10});/gi, decodeEntityRef);
}

// C0/C1 controls, zero-width characters, bidi overrides and isolates, BOM, and the Unicode
// tag block (invisible text, used to hide instructions).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|\udb40[\udc00-\udc7f]/g;

/** One line of plain text: invisible characters removed, whitespace collapsed. */
export function tidy(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/** HTML (or plain text) to plain text: tags, scripts and comments removed, entities decoded. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|iframe|noscript|figure|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  return tidy(decodeEntities(stripped));
}

/** Content of an XML text node: CDATA sections verbatim, the rest entity-decoded. */
function xmlText(raw: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const start = raw.indexOf("<![CDATA[", at);
    if (start < 0) return out + decodeEntities(raw.slice(at));
    out += decodeEntities(raw.slice(at, start));
    const end = raw.indexOf("]]>", start);
    if (end < 0) return out + raw.slice(start + 9);
    out += raw.slice(start + 9, end);
    at = end + 3;
  }
}

const tagPatterns = new Map<string, RegExp>();

/** Inner XML of the first <name>...</name> in the block (self-closing tags are skipped). */
function tagRaw(block: string, name: string): string | null {
  let pattern = tagPatterns.get(name);
  if (!pattern) {
    const escaped = name.replace(/[^a-zA-Z0-9:_-]/g, "");
    pattern = new RegExp(`<${escaped}(\\s[^>]*)?>([\\s\\S]*?)</${escaped}\\s*>`, "gi");
    tagPatterns.set(name, pattern);
  }
  pattern.lastIndex = 0;
  for (let match = pattern.exec(block); match; match = pattern.exec(block)) {
    if (!(match[1] ?? "").trim().endsWith("/")) return match[2];
  }
  return null;
}

function tagText(block: string, ...names: string[]): string | null {
  for (const name of names) {
    const raw = tagRaw(block, name);
    if (raw === null) continue;
    const text = htmlToText(xmlText(raw));
    if (text) return text;
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? "").trim() : null;
}

function openTags(block: string, name: string): string[] {
  return block.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];
}

const TRACKING_PARAMS = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|cmpid|ref|ref_src|ref_url|source|src|s|si|ncid|guccounter|guce_referrer(?:_sig)?|taid|sref|smid|rss)$/i;

/** http(s) only, tracking parameters and the fragment dropped. Null if it is not a usable link. */
export function canonicalUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** https image links only (the dashboard is never asked to load plain http). */
export function httpsImage(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function makeId(source: string, key: string): string {
  return createHash("sha1").update(`${source}\n${key}`).digest("hex").slice(0, 16);
}

/** Cuts at a word boundary and adds an ellipsis when the text is longer than max. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

const SUMMARY_MAX = 260;

const SUMMARY_WP_BOILERPLATE = /\s*(?:The|This) post\b.{0,400}?\b(?:appeared first|first appeared) on\b.*$/i;
const SUMMARY_READ_FULL = /\s*Read the full (?:story|article)\b.*$/i;
const SUMMARY_CONTINUE = /\s*(?:Continue reading|Read more)\b.{0,80}$/i;
const SUMMARY_TRAIL_ELLIPSIS = /\s*\[?(?:…|\.\.\.)\]?\s*$/;

function cleanSummary(text: string | null, title: string, source: string): string | null {
  if (!text) return null;
  let summary = text
    .replace(SUMMARY_WP_BOILERPLATE, "")
    .replace(SUMMARY_READ_FULL, "")
    .replace(SUMMARY_CONTINUE, "")
    .replace(SUMMARY_TRAIL_ELLIPSIS, "…");
  // WordPress boilerplate: "<Source> <Title> <actual summary>".
  for (const lead of [source, title]) {
    if (summary.toLowerCase().startsWith(lead.toLowerCase())) summary = summary.slice(lead.length);
    summary = summary.replace(/^[\s|:–—-]+/, "");
  }
  summary = summary.trim();
  if (summary.length < 30 || titleSimilarity(summary, title) >= 0.8) return null;
  if (summary.length <= SUMMARY_MAX) return summary;
  // Prefer to stop at the end of a sentence.
  const head = summary.slice(0, SUMMARY_MAX);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  return stop >= 80 ? head.slice(0, stop + 1) : clip(summary, SUMMARY_MAX);
}

function cleanAuthor(author: string | null, source: string): string | null {
  if (!author) return null;
  let name = author
    .replace(/^[^()]*@[^()]*\(([^)]+)\)$/, "$1") // "editor@example.com (Jane Doe)"
    .replace(new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+by\\s+`, "i"), "")
    .replace(/^by\s+/i, "")
    .trim();
  if (!name || name.length > 60 || /@/.test(name) || /^https?:/i.test(name)) return null;
  if (name.toLowerCase() === source.toLowerCase() || /\b(staff|team|editors?|newsroom)\b/i.test(name)) return null;
  name = name.replace(/\s*,\s*/g, ", ");
  return name;
}

function parseDate(text: string | null): number | null {
  if (!text) return null;
  const time = Date.parse(text.trim());
  return Number.isFinite(time) ? time : null;
}

const HTTP_PROTOCOL_RE = /^https?:\/\//i;

function atomLinkHref(block: string): string | null {
  let fallback: string | null = null;
  for (const tag of openTags(block, "link")) {
    const href = attribute(tag, "href");
    if (!href) continue;
    const rel = (attribute(tag, "rel") ?? "alternate").toLowerCase();
    if (rel === "alternate") return href;
    if (!fallback && rel !== "self" && rel !== "enclosure" && rel !== "replies") fallback = href;
  }
  return fallback;
}

function rssLinkFallback(block: string): string | null {
  const raw = tagRaw(block, "link");
  if (raw !== null) {
    const link = tidy(xmlText(raw));
    if (link) return link;
  }
  const guid = tagRaw(block, "guid");
  if (guid !== null) {
    const link = tidy(xmlText(guid));
    if (HTTP_PROTOCOL_RE.test(link)) return link;
  }
  return null;
}

function entryLink(block: string): string | null {
  return atomLinkHref(block) ?? rssLinkFallback(block);
}

function isImageMediaTag(tag: string): boolean {
  const type = (attribute(tag, "type") ?? "").toLowerCase();
  const medium = (attribute(tag, "medium") ?? "").toLowerCase();
  const isThumbnail = /^<media:thumbnail/i.test(tag);
  return isThumbnail || type.startsWith("image/") || medium === "image";
}

function entryImage(block: string): string | null {
  for (const tag of [...openTags(block, "media:content"), ...openTags(block, "media:thumbnail"), ...openTags(block, "enclosure")]) {
    if (!isImageMediaTag(tag)) continue;
    const image = httpsImage(attribute(tag, "url"));
    if (image) return image;
  }
  // WordPress and Cointelegraph put the lead image in the description HTML.
  for (const name of ["description", "content:encoded", "content", "summary"]) {
    const raw = tagRaw(block, name);
    if (raw === null) continue;
    const img = /<img\b[^>]*>/i.exec(xmlText(raw));
    const image = img ? httpsImage(attribute(img[0], "src")) : null;
    if (image) return image;
  }
  return null;
}

function categories(block: string): string[] {
  const found: string[] = [];
  const pattern = /<category\b([^>]*)>([\s\S]*?)<\/category\s*>|<category\b([^>]*)\/>/gi;
  for (let match = pattern.exec(block); match; match = pattern.exec(block)) {
    const text = match[2] !== undefined ? htmlToText(xmlText(match[2])) : (attribute(`<c ${match[3] ?? ""}>`, "term") ?? "");
    if (text) found.push(text);
  }
  return found;
}

export type ParsedEntry = FeedItem & { categories: string[] };

/** How many <item>/<entry> blocks are read from one document. */
const MAX_ENTRIES = 400;
const TITLE_MAX = 220;
/** Clock skew allowed on publication dates; anything further ahead is dropped as nonsense. */
const FUTURE_SLACK_MS = 6 * 60 * 60 * 1000;

const ENTRY_BLOCKS_RE = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;

function resolveAuthor(block: string): string | null {
  const direct = tagText(block, "dc:creator");
  if (direct) return direct;
  const atomAuthor = tagRaw(block, "author");
  if (atomAuthor === null) return null;
  return tagText(atomAuthor, "name") ?? htmlToText(xmlText(atomAuthor));
}

function parseEntry(block: string, source: string, now: number): ParsedEntry | null {
  const published = parseDate(tagText(block, "pubDate", "published", "dc:date", "updated"));
  if (published === null || published > now + FUTURE_SLACK_MS) return null;
  const title = tagText(block, "title");
  const url = canonicalUrl(entryLink(block));
  if (!title || !url) return null;
  const guid = tagRaw(block, "guid") ?? tagRaw(block, "id");
  const key = (guid !== null && tidy(xmlText(guid))) || url;
  return {
    id: makeId(source, key),
    kind: "news",
    source,
    author: cleanAuthor(resolveAuthor(block), source),
    handle: null,
    title: clip(title, TITLE_MAX),
    summary: cleanSummary(tagText(block, "description", "summary", "media:description"), title, source),
    url,
    publishedAt: new Date(Math.min(published, now)).toISOString(),
    imageUrl: entryImage(block),
    categories: categories(block),
  };
}

/**
 * Entries of an RSS 2.0 or Atom document, as news items. Entries without a title, a usable link
 * or a parseable date are skipped. Never throws; `recognised` is false when the document is not
 * a feed at all (an HTML error page, say).
 */
export function parseFeed(xml: string, source: string, now = Date.now()): { recognised: boolean; entries: ParsedEntry[] } {
  const recognised = /<(rss|feed|rdf:RDF)\b/i.test(xml.slice(0, 4000));
  const entries: ParsedEntry[] = [];
  ENTRY_BLOCKS_RE.lastIndex = 0;
  let seen = 0;
  for (let match = ENTRY_BLOCKS_RE.exec(xml); match && seen < MAX_ENTRIES; match = ENTRY_BLOCKS_RE.exec(xml)) {
    seen += 1;
    try {
      const entry = parseEntry(match[2], source, now);
      if (entry) entries.push(entry);
    } catch {
      // One odd entry must not cost the rest of the feed.
    }
  }
  return { recognised: recognised || entries.length > 0, entries };
}

// --- Filters -------------------------------------------------------------------------------------

const FILLER_TITLE: RegExp[] = [
  /\bprice (prediction|forecast|analysis|outlook|target)s?\b/i,
  /\b(price|coin|token)s? (could|may|might|set to|poised to|ready to|about to|to) (explode|soar|skyrocket|moon|surge \d|rally \d|\d+x)\b/i,
  /\b\d{2,}x\b.*\b(gains?|potential|returns?|coin|token|gem)\b/i,
  /\b(best|top) (\d+ )?(crypto(currenc(y|ies))?s?|altcoins?|meme ?coins?|tokens?|coins?|presales?) to (buy|watch|invest)\b/i,
  /\b(crypto|bitcoin|btc|eth|sol|xrp|doge)\b.*\bto (buy|watch) (now|today|this week|before)\b/i,
  /\bhow to buy\b/i,
  /\b(price target|could (hit|reach|top)|will (hit|reach|top)|set to (hit|reach|top)|on track (to|for)|hitting|eyes) \$[\d,.]+/i,
  /\bto \$[\d,.]+\s?(k|m|million|billion|trillion)? by (20\d\d|year[- ]end|eoy)\b/i,
  /\bwhat happened in crypto today\b/i,
  /^\s*(morning minute|daily (digest|recap|roundup|debrief)|week(ly)? (recap|roundup|in review)|this week in (crypto|defi|web3|ai))\s*[:|-]/i,
  /\b\d+%\s+(upside|downside)\b|\bsees\b.{0,60}\b(upside|hitting|reaching)\b/i,
  /\b(presale|pre-sale|ico) (raises|hits|surpasses|nears|ends|live)\b/i,
  /\b(giveaway|free airdrop|claim your|promo code|bonus code|referral code|sign-?up bonus)\b/i,
  /\b(casinos?|betting sites?|sportsbooks?|gambling sites?)\b/i,
  /\b(sponsored|press release|partner content|paid post|advertorial|advertisement)\b/i,
  /^\s*(sponsored|pr|ad)\s*[:|-]/i,
  /\b(here'?s why|you won'?t believe|this one (trick|coin))\b/i,
  /\bwhy is (the )?(crypto|bitcoin|btc|eth|ether|xrp|sol|doge|market).{0,30}(up|down|crashing|pumping|dumping) today\b/i,
];
// A publisher selling its own events: ticket deals, exhibitor and side-event deadlines, session previews. Checked on
// 2026-10-02 against TechCrunch's feed (five promos dropped, none of its news) and against headlines where "passes",
// "deal" or "tickets" are news ("Stablecoin bill passes Senate", "Ticketmaster breach").
const PROMO_TITLE = [
  /\b(expo\+?|vip|all[- ]access|early[- ]bird|general admission|attendee|founder|investor|student|conference|event)\s+(pass(es)?|tickets?)\b/i,
  /\b(\$\d+|save|savings|discount|deal)\b.{0,12}\b(on|for)\s+(your |a |an )?.{0,40}\b(pass(es)?|tickets?)\b/i,
  /\b(last|final|less than|only) \d+ (hours?|days?)\b.{0,40}\b(apply|exhibit|register|book|save|buy|get|grab)\b/i,
  /\b(exhibit|sponsor|host a side event|apply to (speak|exhibit|host))\b.{0,40}\b(disrupt|summit|conference|expo|sessions)\b/i,
  /^\s*techcrunch (disrupt|sessions)\b[^:]{0,12}:/i,
];
const FILLER_CATEGORY = /^(sponsored|press releases?|partner content|paid|advertis(ement|ing)|promoted|price (analysis|predictions?)|branded content|deals?)$/i;
const FILLER_PATH = /\/(press-releases?|sponsored|partner-content|advertorial|price-prediction|price-analysis|promoted|deals?)(\/|$)/i;

// Text that reads as an instruction to a language model is treated as an attack on the curation
// step and dropped before the model ever sees it.
const INJECTION = /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your)\b.{0,30}\b(instructions?|prompts?|rules?|guidelines?)\b|\bsystem prompt\b|\b(you are|as) an? (ai|llm|language model|assistant)\b|\b(assistant|ai|llm|claude|gpt|model)s?\s*[:,]?\s*(must|should|please)\s+(pick|select|choose|include|rank|output|return)\b|\battention,? (ai|llm|assistant|model|claude|curator)\b|\b(pick|select|choose|rank|include|show|display|feature)\b.{0,20}\bthis\b.{0,15}\b(item|story|post|headline|candidate|one)\b/i;

// Deliberately short: the agent handles nuance, this is the backstop for the no-AI ordering.
const UNSUITABLE = /\b(porn\w*|nsfw|onlyfans|nudes?|sex ?tapes?|xxx|fuck\w*|shit\w*|bitch\w*|cunt\w*|asshole\w*|dick ?pics?|rape[sd]?|nazi\w*|suicide|beheading)\b/i;

/** Why an item is kept off the screen whatever the agent thinks, or null if it may be a candidate. */
export function rejectReason(item: { title: string; summary?: string | null; url: string; kind: string }, itemCategories: string[] = []): string | null {
  const text = `${item.title} ${item.summary ?? ""}`;
  if (INJECTION.test(text)) return "instruction_like_text";
  if (UNSUITABLE.test(text)) return "unsuitable_language";
  if (item.kind === "news") {
    if (FILLER_TITLE.some((pattern) => pattern.test(item.title))) return "filler";
    if (PROMO_TITLE.some((pattern) => pattern.test(item.title))) return "promotion";
    if (itemCategories.some((category) => FILLER_CATEGORY.test(category.trim()))) return "sponsored";
    try {
      if (FILLER_PATH.test(new URL(item.url).pathname)) return "sponsored";
    } catch {
      return "bad_url";
    }
  } else if (/\b(giveaway|airdrop|whitelist|presale|dm (me|us)|link in bio|use (my )?code|100x|to the moon)\b/i.test(item.title)) {
    return "shilling";
  }
  return null;
}

// --- Dedupe --------------------------------------------------------------------------------------

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have how in into is it its new of on or over says say said that the their this to up us was were what when why will with after amid about than more could may might vs via just now report reports not no all yet still here get gets".split(" "),
);

const SUFFIX_RULES: Array<{ suffix: string; minLen: number; trim: number }> = [
  { suffix: "ing", minLen: 5, trim: 3 },
  { suffix: "ed",  minLen: 4, trim: 2 },
  { suffix: "es",  minLen: 4, trim: 2 },
];

function trimInflection(word: string): string {
  for (const { suffix, minLen, trim } of SUFFIX_RULES) {
    if (word.length > minLen && word.endsWith(suffix)) return word.slice(0, -trim);
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Crude stemmer, enough to match "seized"/"seize", "exits"/"exit", "launches"/"launched". */
function stem(word: string): string {
  const out = trimInflection(word);
  return out.length > 4 && out.endsWith("e") ? out.slice(0, -1) : out;
}

function titleTokens(title: string): Set<string> {
  const words = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[’'`]s\b/g, "")
    .replace(/[^a-z0-9$%.]+/g, " ")
    .split(" ")
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter((word) => word.length > 1 || /[0-9]/.test(word))
    .filter((word) => !STOPWORDS.has(word))
    .map(stem);
  return new Set(words);
}

/** 0..1 share of significant words two headlines have in common; 1 means the same headline. */
export function titleSimilarity(a: string, b: string): number {
  const first = titleTokens(a);
  const second = titleTokens(b);
  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;
  const union = first.size + second.size - shared;
  return union ? shared / union : 0;
}

/** A single shared word ("Bitcoin") never makes a duplicate. */
const MIN_SHARED_WORDS = 2;
/** Stories this far apart in time are different stories, however alike the headlines. */
const DUPLICATE_WINDOW_MS = 48 * 60 * 60 * 1000;

export type StoryThresholds = {
  /** Share of the shorter headline's weight carried by the words both have. */
  containment: number;
  /** Share of both headlines' combined weight carried by the words both have. */
  jaccard: number;
};

/** Same event reported twice: used to merge candidates before the agent sees them. */
export const DUPLICATE: StoryThresholds = { containment: 0.5, jaccard: 0.38 };
/** Probably the same subject: used on the final picks, where a miss costs a repeat on screen. */
export const RELATED: StoryThresholds = { containment: 0.3, jaccard: 0.22 };

/**
 * A test for "these two headlines are the same story". Words are weighted by how rare they are
 * in `corpus`, so "MetaMask" and "Cobalt" count for much more than "Bitcoin" or "crypto".
 */
export function storyMatcher(corpus: FeedItem[], thresholds: StoryThresholds = DUPLICATE): (a: FeedItem, b: FeedItem) => boolean {
  const cache = new Map<string, Set<string>>();
  const tokensOf = (item: FeedItem) => {
    let tokens = cache.get(item.title);
    if (!tokens) cache.set(item.title, (tokens = titleTokens(item.title)));
    return tokens;
  };
  const frequency = new Map<string, number>();
  for (const item of corpus) for (const word of tokensOf(item)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const weight = (word: string) => Math.log(1 + Math.max(corpus.length, 1) / (frequency.get(word) ?? 1));
  const mass = (tokens: Set<string>) => {
    let total = 0;
    for (const word of tokens) total += weight(word);
    return total;
  };
  return (a, b) => {
    if (Math.abs(Date.parse(a.publishedAt) - Date.parse(b.publishedAt)) > DUPLICATE_WINDOW_MS) return false;
    const first = tokensOf(a);
    const second = tokensOf(b);
    let shared = 0;
    let sharedMass = 0;
    for (const word of first) {
      if (second.has(word)) {
        shared += 1;
        sharedMass += weight(word);
      }
    }
    if (shared < MIN_SHARED_WORDS) return false;
    const massA = mass(first);
    const massB = mass(second);
    return sharedMass / Math.min(massA, massB) >= thresholds.containment || sharedMass / (massA + massB - sharedMass) >= thresholds.jaccard;
  };
}

export type Clustered<T> = {
  item: T;
  /** How many different sources carried this story, the kept item's included. */
  outlets: number;
  /** Those sources' names, earliest report first. */
  sources: string[];
};

/** Groups repeats of one story across outlets (same link or matching headlines) and keeps one version of each. */
export function cluster<T extends FeedItem>(items: T[]): Clustered<T>[] {
  const byAge = [...items].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const sameStory = storyMatcher(byAge);
  const stories: T[][] = [];
  const ids = new Set<string>();
  const urls = new Map<string, T[]>();
  for (const item of byAge) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    const story = urls.get(item.url) ?? stories.find((members) => members.some((member) => sameStory(item, member)));
    if (story) {
      story.push(item);
      continue;
    }
    const members = [item];
    urls.set(item.url, members);
    stories.push(members);
  }
  return stories.map((members) => {
    // Show the earliest version that has something to read under the headline.
    const lead = members.find((member) => member.summary) ?? members.find((member) => member.kind === "news") ?? members[0];
    const sources = [...new Set(members.map((member) => member.source))];
    return { item: lead, outlets: sources.length, sources };
  });
}

export function dedupe<T extends FeedItem>(items: T[]): T[] {
  return cluster(items).map((entry) => entry.item);
}
