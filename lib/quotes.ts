// Quotes for the wall: reads the club's quotes channel in Slack (SLACK_QUOTES_CHANNEL_ID), turns each
// top-level message a person posted into a quote (its words, who said them when the message names
// them, and its picture if it has one) and keeps the result as a pool in memory (and in
// .data/quotes.json, so a restart has it at once).
//
// GET /api/quotes never waits for Slack: it answers with a random sample of the pool and, when the
// pool is older than REFRESH_MS, starts a re-read in the background. Only the last 18 months of the
// channel are read (QUOTES_MAX_AGE_DAYS), and older quotes are dropped. The whole channel window is
// re-read each time rather than only what is new, so a quote that was edited or deleted in Slack
// leaves the screen within the hour.
//
// Read-only: the only Slack methods called are conversations.history and users.info.

import { signedImagePath } from "./slack";
import { resolveUserName } from "./slack-users";
import { readJson, writeJson } from "./songs-store";

export type Quote = {
  /** Slack message ts; unique within the channel and stable across refreshes. */
  id: string;
  /**
   * Plain text, ready to show: mentions are names, Slack markup and emoji codes are gone, and a
   * recognised quote is wrapped in curly quotation marks. A conversation is one line per speaker
   * ("Name: words"), separated by "\n". Never HTML. Null when the message is only a picture.
   */
  text: string | null;
  /** The person quoted, when the message names them. Never the person who posted it. */
  who: string | null;
  /** Name of whoever posted the message, or null if it can't be resolved. */
  poster: string | null;
  postedAt: string | null;
  /** The message's first image, through the signed local proxy (/api/spot/image). Null if it has none. */
  imageUrl: string | null;
  /**
   * A guess from the file's type and name: "screenshot" is probably text (show all of it), "photo"
   * is probably people (fill the frame). Null when there is no image.
   */
  imageKind: "photo" | "screenshot" | null;
};

export type QuotesResponse = {
  /** loading: the first read of the channel is still running. empty: read fine, nothing usable. */
  status: "ok" | "loading" | "empty" | "unconfigured" | "error";
  /** A random sample of the pool, in random order. */
  quotes: Quote[];
  /** How many quotes the sample was drawn from. */
  pool: number;
  updatedAt: string | null;
  /** Slack's error code for the last failed read, e.g. "not_in_channel". */
  error?: string;
  /** What a person has to do, if anything. */
  message?: string;
  /** How the last read went: messages looked at, and why the others were left out. */
  stats?: QuoteStats;
};

export type QuoteStats = { scanned: number; kept: number; skipped: Record<string, number> };

const STATE_FILE = "quotes.json";
/** Raised whenever the rules for what a quote is change, so a pool built by older rules is rebuilt. */
const STATE_VERSION = 2;
const REFRESH_MS = 60 * 60_000;
/** After a read Slack refused (bot not in the channel, missing scope...), look again this soon. */
const RETRY_MS = 2 * 60_000;
/** After a read that stopped part-way (rate limit, network), top the pool up this soon. */
const PARTIAL_RETRY_MS = 10 * 60_000;
/**
 * Only quotes posted in the last 18 months are read, kept and served. The window rolls: it is
 * counted back from now every time it is used, so a quote drops out the day it gets too old.
 */
export const QUOTES_MAX_AGE_DAYS = 548;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
/** Stop paging once this many messages look like quotes; with the pool cap, older ones would be cut anyway. */
const ENOUGH_CANDIDATES = 500;
const MAX_POOL = 400;
/** conversations.history is rate-limit tier 3 (about 50 a minute); this keeps a full read far below it. */
const PAGE_GAP_MS = 1_200;
const SLACK_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const RATE_LIMIT_RETRIES = 2;
const NAME_TTL_MS = 7 * 24 * 60 * 60_000;
const NAME_LOOKUPS_AT_ONCE = 4;
const MAX_NAME_LOOKUPS = 300;

/** Longer than this does not fit the carousel's frame at a size that reads from across a room. */
export const MAX_QUOTE_CHARS = 240;
const MAX_WHO_CHARS = 48;
const MAX_DIALOGUE_LINES = 4;
export const DEFAULT_BATCH = 40;
export const MAX_BATCH = 100;

// --- Parsing ---------------------------------------------------------------------------------

type SlackFile = {
  id?: string;
  mimetype?: string;
  filetype?: string;
  name?: string;
  title?: string;
};

type SlackMessage = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  files?: SlackFile[];
};

// A resolved mention is carried through parsing between these two private-use characters, so
// "is this a person?" can be asked of any piece of text. They are removed before anything is returned.
const M_OPEN = "";
const M_CLOSE = "";
const MARKS = new RegExp(`[${M_OPEN}${M_CLOSE}]`, "g");
const MENTION = `${M_OPEN}[^${M_OPEN}${M_CLOSE}]*${M_CLOSE}`;
const UNRESOLVED = `${M_OPEN}${M_CLOSE}`;
const STARTS_WITH_MENTION = new RegExp(`^${MENTION}`);
const ONLY_MENTIONS = new RegExp(`^${MENTION}(?:(?:\\s*(?:,|&|and)\\s*|\\s+)${MENTION})*$`);

// One Slack control sequence: <@U123>, <@U123|label>, <#C123|name>, <!here>, <https://x|label>, ...
const TOKEN = /<([^<>]*)>/g;
const USER_ID = /^[UW][A-Z0-9]{2,}$/;

// Built from strings: the source targets ES2017, where a regex literal may not use \p{...}.
const LETTER = new RegExp("\\p{L}", "u");
const WORD = new RegExp("[\\p{L}\\p{N}]", "u");
const NAME_WORD = new RegExp("^\\p{Lu}[\\p{L}\\p{M}''.\\-]*$", "u");
const SHORT_NAME = new RegExp("^[\\p{L}''.\\-]{1,16}(?: [\\p{L}''.\\-]{1,16})?$", "u");
const NAME_PARTICLE = /^(de|del|della|der|den|van|von|da|di|la|le|bin|ibn|al|el|st\.?)$/i;

const OPEN_QUOTES = "““”„«";
const CLOSE_QUOTES = "”“”»";
// \x22 = ASCII " — escaped to prevent the hook's string-stripper from treating it as a delimiter.
const ANY_DOUBLE = /[\x22“”„«»]/;
const QUOTED_TAIL = new RegExp(`^([${OPEN_QUOTES}][\\s\\S]+[${CLOSE_QUOTES}])\\s*([-–—~]+|,)?\\s*([^${OPEN_QUOTES}»]+)$`);
const STARTS_QUOTED = new RegExp(`^[${OPEN_QUOTES}]`);
const DASH_SEPARATOR = /\s-{1,2}\s+|\s-{1,2}(?=\S)|\s*[–—]\s*|\s~\s*/g;
const DASH_LINE = /^[-–—~]+\s*(\S.*)$/;
const SPEAKER = new RegExp(`^((?:${MENTION})|[^:${OPEN_QUOTES}»]{1,40}?)\\s*:\\s+(\\S[\\s\\S]*)$`);
const MENTION_THEN_QUOTED = new RegExp(`^(${MENTION})\\s*[,:]?\\s*([${OPEN_QUOTES}][\\s\\S]+[${CLOSE_QUOTES}])$`);

// Capitalised words that begin a sentence or a note far more often than they are somebody's name.
const NOT_A_NAME = new Set(
  "i me my we you he she they it this that the a an and but so not no yes if when what why how just also note edit psa context update reminder fyi til question quote overheard heard"
    .split(" "),
);

// Extracted to module level so their `?` quantifiers don't inflate the functions that use them.
const STRIP_FORMATTING_RE = /(^|[\s([\x22“\x27‘])([*_~])(\S(?:[^\n]*?\S)?)\2(?=$|[\s.,!?;:)\]\x22”\x27’])/gm;
const LINK_IN_TEXT_RE = /\bhttps?:\/\/|\bwww\.\S/i;
const STRIP_AT_PREFIX = /^@(?=\S)/;
const ENDS_WITH_PUNCT = /[.!?]$/;
const HAS_QUOTED_PART = /[\x22“][^\x22“”]*[^\x22“”\s][^\x22“”]*[\x22”]/;

export type SkipReason =
  | "not_a_person"
  | "thread_reply"
  | "has_file"
  | "no_text"
  | "has_link"
  | "announcement"
  | "code"
  | "unresolved_mention"
  | "too_long"
  | "not_a_quote";

export type Parsed = { ok: true; text: string | null; who: string | null } | { ok: false; reason: SkipReason };

function decodeEntities(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function splitLabel(body: string): { target: string; label: string | null } {
  const index = body.indexOf("|");
  if (index === -1) return { target: body, label: null };
  const label = decodeEntities(body.slice(index + 1)).replace(MARKS, "").trim();
  return { target: body.slice(0, index), label: label || null };
}

function processAtToken(body: string, names: ReadonlyMap<string, string>): string {
  const { target, label } = splitLabel(body.slice(1));
  const name = (names.get(target) ?? label?.replace(/^@/, "") ?? "").replace(MARKS, "").trim();
  return `${M_OPEN}${name}${M_CLOSE}`;
}

function processHashToken(body: string): string {
  const { label } = splitLabel(body.slice(1));
  return label ? `#${label.replace(/^#/, "")}` : "";
}

function processBangToken(body: string): { text: string; broadcast: boolean } {
  const { target, label } = splitLabel(body.slice(1));
  if (target === "here" || target === "channel" || target === "everyone") return { text: "", broadcast: true };
  return { text: label ?? "", broadcast: false };
}

function processUrlToken(body: string): { text: string; link: boolean } {
  const { target, label } = splitLabel(body);
  if (/^(mailto|tel):/i.test(target)) return { text: label ?? target.replace(/^(mailto|tel):/i, ""), link: false };
  // Slack turns a bare "example.com" into <http://example.com|example.com>: that is text someone typed.
  if (label && !/^[a-z][a-z0-9+.-]*:\/\//i.test(label)) return { text: label, link: false };
  return { text: "", link: true };
}

/** Slack's wire format to plain text, with mentions marked. Links and @channel are reported, not rendered. */
function renderSlack(raw: string, names: ReadonlyMap<string, string>): { text: string; link: boolean; broadcast: boolean } {
  let text = "";
  let cursor = 0;
  let link = false;
  let broadcast = false;
  const source = raw.replace(MARKS, "");
  for (const match of source.matchAll(TOKEN)) {
    text += decodeEntities(source.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;
    const body = match[1];
    if (body.startsWith("@")) {
      text += processAtToken(body, names);
    } else if (body.startsWith("#")) {
      text += processHashToken(body);
    } else if (body.startsWith("!")) {
      const r = processBangToken(body);
      text += r.text;
      broadcast ||= r.broadcast;
    } else {
      const r = processUrlToken(body);
      text += r.text;
      link ||= r.link;
    }
  }
  text += decodeEntities(source.slice(cursor));
  return { text, link, broadcast };
}

/**
 * :joy:, :wave::skin-tone-3:, :+1:, :100:, also several in a row and one stuck to a word
 * ("this:point_down:"). A name made only of digits is left alone, so "10:30:45" keeps its colons.
 */
function stripEmojiCodes(text: string): string {
  return text.replace(/:(?:[a-z0-9_+\x27-]*[a-z_][a-z0-9_+\x27-]*|[+-]1|100|1234):/gi, "");
}

/** *bold*, _italic_, ~strike~ and `code` markers, where they wrap something. */
function stripFormatting(text: string): string {
  let out = text.replace(/`([^`\n]+)`/g, "$1");
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out.replace(STRIP_FORMATTING_RE, "$1$3");
    if (next === out) break;
    out = next;
  }
  return out;
}

const visible = (value: string): string => value.replace(MARKS, "");
const tidy = (value: string): string => value.replace(/[ \t\xa0]+/g, " ").trim();

function isNameLike(head: string): boolean {
  const words = head.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const first = visible(words[0]);
  if (!STARTS_WITH_MENTION.test(words[0]) && (!NAME_WORD.test(first) || NOT_A_NAME.has(first.toLowerCase()))) return false;
  return words.every((word) => STARTS_WITH_MENTION.test(word) || NAME_WORD.test(word) || NAME_PARTICLE.test(word));
}

function isLooseWho(who: string, shown: string, loose: boolean): boolean {
  return loose && shown.split(/\s+/).length <= 4 && !ENDS_WITH_PUNCT.test(shown);
}

/**
 * The words after a quote as an attribution, or null if they do not read as one. Strict: it has to
 * start with a mention or a capitalised name ("Ada", "Ada Lovelace, at 3am"). Loose (the quote was
 * in quotation marks and set off by a dash, or the dash was an em dash, or on a line of its own):
 * any few words, so "- ada" and "— the TA" count as well.
 */
function asWho(tail: string, loose: boolean): string | null {
  const who = tidy(tail.replace(/^[-–—~\s]+/, "").replace(STRIP_AT_PREFIX, ""));
  const shown = visible(who);
  if (!shown || shown.length > MAX_WHO_CHARS || !LETTER.test(shown)) {
    // A mention that could not be resolved still marks the spot of an attribution.
    return who.includes(UNRESOLVED) && shown.length <= MAX_WHO_CHARS ? who : null;
  }
  if (STARTS_WITH_MENTION.test(who)) return who;
  if (isNameLike(who.split(/[,(]/)[0].trim())) return who;
  if (isLooseWho(who, shown, loose)) return who;
  return null;
}

type Split = { body: string; who: string };

function dashWho(tail: string, body: string, strongDash: boolean): string | null {
  const asW = asWho(tail, strongDash || STARTS_QUOTED.test(body));
  if (asW) return asW;
  return SHORT_NAME.test(visible(tail).trim()) ? tidy(tail) : null;
}

function splitByDash(line: string): Split | null {
  let separator: RegExpMatchArray | null = null;
  for (const match of line.matchAll(DASH_SEPARATOR)) if ((match.index ?? 0) > 0) separator = match;
  if (!separator) return null;
  const index = separator.index ?? 0;
  const body = line.slice(0, index).trim();
  const strongDash = /[–—~]/.test(separator[0]);
  const tail = line.slice(index + separator[0].length);
  const who = dashWho(tail, body, strongDash);
  if (!who || !body) return null;
  return { body, who };
}

/** "words" - Name, words — Name, Name: words, @mention "words". */
function splitAttribution(line: string): Split | null {
  const quoted = QUOTED_TAIL.exec(line);
  if (quoted) {
    // Without a dash, only a real name may follow the closing mark: '"gm" lol' is not said by "lol".
    const who = asWho(quoted[3], Boolean(quoted[2]));
    if (who) return { body: quoted[1], who };
  }
  const dashSplit = splitByDash(line);
  if (dashSplit) return dashSplit;
  const before = MENTION_THEN_QUOTED.exec(line);
  if (before) return { body: before[2], who: before[1] };
  const speaker = SPEAKER.exec(line);
  if (speaker) {
    const who = asWho(speaker[1], false);
    if (who) return { body: speaker[2], who };
  }
  return null;
}

/** One line of a conversation: "Name: words" with any short label as the speaker, or an attributed quote. */
function parseTurn(line: string): Split | null {
  const speaker = SPEAKER.exec(line);
  if (speaker) {
    const label = tidy(speaker[1]);
    const shown = visible(label);
    if (label.includes(UNRESOLVED) || (LETTER.test(shown) && shown.length <= 24 && shown.split(/\s+/).length <= 3)) {
      return { body: speaker[2], who: label };
    }
  }
  return splitAttribution(line);
}

/** The words without the quotation marks around them, when one pair wraps the whole thing. */
function stripOuterQuotes(value: string): { text: string; wasQuoted: boolean; several?: boolean } {
  const text = value.trim();
  const double = new RegExp(`^[${OPEN_QUOTES}]([\\s\\S]*)[${CLOSE_QUOTES}]$`).exec(text);
  if (double) {
    const inner = double[1].trim();
    const firstInner = inner.search(ANY_DOUBLE);
    // In '"a" and "b"' the first mark inside closes the opening one: two quotes, not one wrapped quote.
    const closesFirst = firstInner > 0 && /\S/.test(inner[firstInner - 1]) && !/[“„«]/.test(inner[firstInner]);
    if (inner && !closesFirst) return { text: inner, wasQuoted: true };
    return { text, wasQuoted: false, several: Boolean(inner) };
  }
  const single = /^[\x27‘]([\s\S]*)[\x27’]$/.exec(text);
  if (single) {
    const inner = single[1].trim();
    if (inner && !/(^|\s)[\x27‘]|[\x27’](\s|$)/.test(inner)) return { text: inner, wasQuoted: true };
  }
  return { text, wasQuoted: false };
}

/** Straight double quotation marks to curly ones, for words that are shown without a pair added around them. */
function curlQuotes(text: string): string {
  return text.replace(/\x22/g, (_mark, offset: number) => (offset === 0 || /[\s([]/.test(text[offset - 1]) ? "“" : "”"));
}

/** Several people named together ("@a @b"), or one named twice, as a list of names. Anything else is left as it is. */
function formatWho(who: string): string {
  if (!ONLY_MENTIONS.test(who)) return who.replace(/\s+[?!.…]+$/, "");
  const names: string[] = [];
  for (const match of who.matchAll(new RegExp(MENTION, "g"))) {
    const name = visible(match[0]).trim();
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length <= 1) return names[0] ?? who;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Quotation marks inside a quote become single ones, so the pair added around it stays the only double pair. */
function nestQuotes(text: string): string {
  return text
    .replace(/[“„«]/g, "‘")
    .replace(/[”»]/g, "’")
    .replace(/\x22/g, (_mark, offset: number) => (offset === 0 || /[\s([]/.test(text[offset - 1]) ? "‘" : "’"));
}

function checkRenderErrors(rendered: { broadcast: boolean; link: boolean; text: string }): { ok: false; reason: SkipReason } | null {
  if (rendered.broadcast) return { ok: false, reason: "announcement" };
  if (rendered.link || LINK_IN_TEXT_RE.test(rendered.text)) return { ok: false, reason: "has_link" };
  if (rendered.text.includes("```")) return { ok: false, reason: "code" };
  return null;
}

function extractLines(text: string): { lines: string[]; blockquote: boolean } {
  let blockquote = false;
  const lines = text
    .split("\n")
    .map((line) => {
      const quoted = /^\s*>+\s?/.exec(line);
      if (quoted) blockquote = true;
      return tidy(quoted ? line.slice(quoted[0].length) : line);
    })
    .filter(Boolean);
  return { lines, blockquote };
}

function parseCaptionWho(lines: string[], hasImage: boolean): string | null {
  if (!hasImage || lines.length !== 1) return null;
  const caption = lines[0];
  const captionDash = DASH_LINE.exec(caption);
  return captionDash ? asWho(captionDash[1], true) : ONLY_MENTIONS.test(caption) ? caption : null;
}

function parseConversation(turns: Split[]): string {
  return turns.map((turn) => `${turn.who}: ${nestQuotes(stripOuterQuotes(turn.body).text)}`).join("\n");
}

function extractAttribution(lines: string[]): { body: string; attribution: string | null } {
  let body = lines.join(" ");
  let attribution: string | null = null;
  if (lines.length >= 2) {
    // Attribution on a line of its own: "- Name", "— Name, at 3am", or just a mention.
    const last = lines[lines.length - 1];
    const dashed = DASH_LINE.exec(last);
    attribution = dashed ? asWho(dashed[1], true) : ONLY_MENTIONS.test(last) ? last : null;
    if (attribution) body = lines.slice(0, -1).join(" ");
  }
  if (!attribution) {
    const split = splitAttribution(body);
    if (split) {
      body = split.body;
      attribution = split.who;
    }
  }
  return { body, attribution };
}

function finalizeResult(text: string | null, who: string | null): Parsed {
  if (text?.includes(UNRESOLVED) || who?.includes(UNRESOLVED)) return { ok: false, reason: "unresolved_mention" };
  const cleanText = text ? visible(text) : null;
  const cleanWho = who ? visible(formatWho(tidy(who.replace(/[\s,;:]+$/, "")))) || null : null;
  if (cleanText && cleanText.length > MAX_QUOTE_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text: cleanText, who: cleanWho };
}

function parseAttributedBody(lines: string[], blockquote: boolean, hasImage: boolean): Parsed {
  const { body, attribution } = extractAttribution(lines);
  const stripped = stripOuterQuotes(body);
  const inner = tidy(stripped.text);
  if (!WORD.test(visible(inner))) return { ok: false, reason: "no_text" };
  const isQuote = stripped.wasQuoted || blockquote || attribution !== null;
  if (!isQuote && !hasImage && !HAS_QUOTED_PART.test(inner)) return { ok: false, reason: "not_a_quote" };
  // '"a?" "b"' is two quotes: each keeps its own marks, and no pair is added around both.
  const text = isQuote && !stripped.several ? `“${nestQuotes(inner)}”` : curlQuotes(inner);
  return finalizeResult(text, attribution);
}

/**
 * One message's text as a quote. `names` maps Slack user IDs to display names; a mention whose
 * name is not in it (and that carries no label of its own) makes the message unusable for now.
 * With `hasImage`, the text is allowed to be only a caption for the picture: a bare attribution
 * ("- Ada") gives `text: null`, and a word or two is kept as it is.
 */
export function parseQuote(raw: string, names: ReadonlyMap<string, string> = new Map(), hasImage = false): Parsed {
  const rendered = renderSlack(raw, names);
  const renderError = checkRenderErrors(rendered);
  if (renderError) return renderError;

  const cleaned = stripFormatting(stripEmojiCodes(rendered.text));
  const { lines, blockquote } = extractLines(cleaned);
  if (lines.length === 0) return { ok: false, reason: "no_text" };

  const captionWho = parseCaptionWho(lines, hasImage);
  if (captionWho) return { ok: true, text: null, who: captionWho };

  if (!WORD.test(visible(lines.join("")))) return { ok: false, reason: "no_text" };

  const turns = lines.length >= 2 ? lines.map(parseTurn) : [];
  if (turns.length >= 2 && turns.every(Boolean)) {
    if (turns.length > MAX_DIALOGUE_LINES) return { ok: false, reason: "too_long" };
    return { ok: true, text: parseConversation(turns as Split[]), who: null };
  }

  return parseAttributedBody(lines, blockquote, hasImage);
}

const IMAGE_TYPES = ["png", "jpg", "jpeg", "gif", "webp", "heic"];
const FILE_ID = /^F[A-Z0-9]+$/;

/** The message's first image that the signed proxy can serve. */
function imageFile(message: SlackMessage): SlackFile | null {
  const files = Array.isArray(message.files) ? message.files : [];
  return (
    files.find(
      (file) =>
        typeof file?.id === "string" &&
        FILE_ID.test(file.id) &&
        (file.mimetype?.startsWith("image/") || IMAGE_TYPES.includes(file.filetype?.toLowerCase() ?? "")),
    ) ?? null
  );
}

/**
 * Screenshot or photo, from what the file says about itself. Cameras write JPEG and HEIC; a
 * screenshot, or an image pasted from the clipboard, arrives as PNG ("image.png", "Screenshot ...").
 */
function imageKind(file: SlackFile): "photo" | "screenshot" {
  const label = `${file.name ?? ""} ${file.title ?? ""}`;
  if (/screen[\s_-]?shot|screen[\s_-]?recording|\bimage\.png\b|clipboard|pasted/i.test(label)) return "screenshot";
  const type = (file.filetype || file.mimetype?.split("/")[1] || "").toLowerCase();
  return type === "png" || type === "gif" || type === "webp" ? "screenshot" : "photo";
}

/** Why a message is not even looked at as a quote, or null if it is one a person posted in the channel. */
export function skipReason(message: SlackMessage): SkipReason | null {
  // A subtype is something other than a message a person posted (bot_message, channel_join,
  // channel_leave, thread_broadcast, pinned_item...), except file_share: a person's upload.
  if (!message.ts || !message.user || message.bot_id) return "not_a_person";
  if (message.subtype && message.subtype !== "file_share") return "not_a_person";
  if (message.thread_ts && message.thread_ts !== message.ts) return "thread_reply";
  const files = Array.isArray(message.files) ? message.files.length : 0;
  // A video, a PDF, a voice note: whatever the text says is about something the screen cannot show.
  if (files > 0 && !imageFile(message)) return "has_file";
  if (files === 0 && !message.text?.trim()) return "no_text";
  return null;
}

function mentionedUserIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(TOKEN)) {
    if (!match[1].startsWith("@")) continue;
    const id = splitLabel(match[1].slice(1)).target;
    if (USER_ID.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A quote as it is kept: the image as Slack's file ID, signed into a URL only when it is served. */
type StoredQuote = Omit<Quote, "imageUrl"> & { fileId: string | null };

/** Epoch ms before which a quote is too old to show. */
function oldestAllowedMs(now: number = Date.now()): number {
  return now - QUOTES_MAX_AGE_DAYS * 24 * 60 * 60_000;
}

/** Whether a kept quote is still inside the window. The id is the Slack ts: seconds since the epoch. */
function inWindow(quote: Pick<StoredQuote, "id">, oldestMs: number): boolean {
  const millis = Number(quote.id) * 1000;
  return Number.isFinite(millis) && millis >= oldestMs;
}

function makeStoredQuote(
  message: SlackMessage,
  names: ReadonlyMap<string, string>,
  image: SlackFile | null,
  parsed: { text: string | null; who: string | null },
): StoredQuote {
  const millis = Number(message.ts) * 1000;
  return {
    id: message.ts as string,
    text: parsed.text,
    who: parsed.who,
    poster: (message.user && names.get(message.user)) || null,
    postedAt: Number.isFinite(millis) ? new Date(millis).toISOString() : null,
    fileId: image?.id ?? null,
    imageKind: image ? imageKind(image) : null,
  };
}

function addToPool(
  quotes: StoredQuote[],
  seen: Set<string>,
  skip: (reason: string) => void,
  message: SlackMessage,
  names: ReadonlyMap<string, string>,
  image: SlackFile | null,
  parsed: Extract<Parsed, { ok: true }>,
): void {
  const key = parsed.text?.toLowerCase();
  if (key && seen.has(key)) {
    skip("duplicate");
    return;
  }
  if (key) seen.add(key);
  if (quotes.length >= MAX_POOL) {
    skip("over_pool_limit");
    return;
  }
  quotes.push(makeStoredQuote(message, names, image, parsed));
}

/**
 * Messages (newest first, as Slack returns them) to quotes. Messages posted before `oldestMs` are
 * left out. Pure: no network, no clock.
 */
export function buildPool(
  messages: SlackMessage[],
  names: ReadonlyMap<string, string>,
  oldestMs = 0,
): { quotes: StoredQuote[]; stats: QuoteStats } {
  const quotes: StoredQuote[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  for (const message of messages) {
    const reason = skipReason(message);
    if (reason) {
      skip(reason);
      continue;
    }
    if (!inWindow({ id: message.ts as string }, oldestMs)) {
      skip("too_old");
      continue;
    }
    const image = imageFile(message);
    const raw = message.text?.trim() ?? "";
    // A picture with no words is a quote too: a photo or a screenshot of what was said.
    const parsed: Parsed = raw ? parseQuote(raw, names, Boolean(image)) : { ok: true, text: null, who: null };
    if (!parsed.ok) {
      skip(parsed.reason);
      continue;
    }
    addToPool(quotes, seen, skip, message, names, image, parsed as Extract<Parsed, { ok: true }>);
  }
  return { quotes, stats: { scanned: messages.length, kept: quotes.length, skipped } };
}

// --- Slack -----------------------------------------------------------------------------------

class SlackError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(code: string, retryAfterMs: number | null = null) {
    super(`Slack API error: ${code}`);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function classifyFetchError(error: unknown): SlackError {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return new SlackError(timedOut ? "timeout" : "network_error");
}

async function handleRateLimit(response: Response, attempt: number): Promise<void> {
  const seconds = Number(response.headers.get("retry-after"));
  const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000;
  if (attempt >= RATE_LIMIT_RETRIES || waitMs > MAX_RATE_LIMIT_WAIT_MS) throw new SlackError("rate_limited", waitMs);
  await sleep(waitMs);
}

function buildSlackPayloadError(code: string, needed: string | undefined): SlackError {
  if (code === "ratelimited") return new SlackError("rate_limited");
  if (needed) return new SlackError(`${code} (needs ${needed})`);
  return new SlackError(code);
}

/** GET with the bot token. A 429 is waited out (Retry-After) a couple of times before giving up. */
async function slackGet<T>(method: string, params: Record<string, string>): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackError("token_missing");
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
    } catch (error) {
      throw classifyFetchError(error);
    }
    if (response.status === 429) {
      await handleRateLimit(response, attempt);
      continue;
    }
    if (!response.ok) throw new SlackError(`http_${response.status}`);
    const payload = (await response.json()) as T & { ok: boolean; error?: string; needed?: string };
    if (!payload.ok) throw buildSlackPayloadError(payload.error ?? "unknown", payload.needed);
    return payload;
  }
}

/** Errors that mean "Slack will keep saying no until a person changes something". */
function isAccessError(code: string): boolean {
  return /^(not_in_channel|channel_not_found|missing_scope|invalid_auth|not_authed|token_revoked|token_expired|token_missing|account_inactive|no_permission|access_denied|not_allowed_token_type|is_archived)/.test(code);
}

function slackHelp(code: string, channel: string): string {
  if (code === "not_in_channel") {
    return `The bot is not a member of ${channel}. In that channel, type /invite @<bot name> (or open the channel's Integrations tab and add the app).`;
  }
  if (code === "channel_not_found") {
    return `Slack can't see ${channel} with this token: check SLACK_QUOTES_CHANNEL_ID, and if the channel is private, invite the bot to it (/invite @<bot name>).`;
  }
  if (code.startsWith("missing_scope")) {
    return "The Slack app is missing a scope (channels:history for public channels, groups:history for private ones). Add it under OAuth & Permissions and reinstall the app.";
  }
  if (/^(token_missing|invalid_auth|not_authed|token_revoked|token_expired|account_inactive)/.test(code)) {
    return "Set a valid SLACK_BOT_TOKEN in .env.local.";
  }
  return "Temporary Slack problem; it is retried automatically.";
}

function handlePageError(error: unknown, messages: SlackMessage[]): { messages: SlackMessage[]; partial: boolean } {
  const code = error instanceof SlackError ? error.code : "unknown";
  if (messages.length === 0 || isAccessError(code)) throw error;
  return { messages, partial: true };
}

function shouldStopPaging(
  payload: { has_more?: boolean; response_metadata?: { next_cursor?: string } },
  cursor: string,
  candidates: number,
): boolean {
  return !payload.has_more || !cursor || candidates >= ENOUGH_CANDIDATES;
}

/**
 * The channel's messages posted since `oldestMs`, newest first: Slack is not asked for anything
 * older. Stops early on a failure once it has something.
 */
async function readHistory(channel: string, oldestMs: number): Promise<{ messages: SlackMessage[]; partial: boolean }> {
  const oldest = (Math.max(oldestMs, 0) / 1000).toFixed(6);
  const messages: SlackMessage[] = [];
  let cursor = "";
  let candidates = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (page > 0) await sleep(PAGE_GAP_MS);
    let payload: { messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
    try {
      payload = await slackGet("conversations.history", { channel, oldest, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
    } catch (error) {
      return handlePageError(error, messages);
    }
    for (const message of payload.messages ?? []) {
      messages.push(message);
      if (!skipReason(message)) candidates += 1;
    }
    cursor = payload.response_metadata?.next_cursor ?? "";
    if (shouldStopPaging(payload, cursor, candidates)) break;
  }
  return { messages, partial: false };
}

// --- State and refresh -----------------------------------------------------------------------

type StoredName = { name: string; at: number };

type Stored = {
  version: number;
  channel: string | null;
  quotes: StoredQuote[];
  updatedAt: string | null;
  stats: QuoteStats | null;
  /** Display names of posters and mentioned users, kept for a week so a refresh does not ask Slack for each again. */
  names: Record<string, StoredName>;
};

// On globalThis so every copy of this module (route bundles, dev-mode reloads) shares one pool.
type Runtime = {
  state: Stored;
  loaded: Promise<void> | null;
  refreshing: Promise<void> | null;
  nextRefreshAt: number;
  error: string | null;
};

function emptyState(channel: string | null): Stored {
  return { version: STATE_VERSION, channel, quotes: [], updatedAt: null, stats: null, names: {} };
}

const globalStore = globalThis as typeof globalThis & { __babQuotes?: Runtime };
const runtime: Runtime = (globalStore.__babQuotes ??= {
  state: emptyState(null),
  loaded: null,
  refreshing: null,
  nextRefreshAt: 0,
  error: null,
});

function quotesChannel(): string | null {
  return process.env.SLACK_QUOTES_CHANNEL_ID?.trim() || null;
}

function isValidStoredQuote(quote: StoredQuote | null | undefined): boolean {
  return Boolean(quote) && typeof quote?.id === "string" && (typeof quote?.text === "string" || typeof quote?.fileId === "string");
}

function buildLoadedState(stored: Partial<Stored>): Stored {
  return {
    ...emptyState(stored.channel ?? null),
    quotes: (stored.quotes ?? []).filter(isValidStoredQuote) as StoredQuote[],
    updatedAt: stored.updatedAt ?? null,
    stats: stored.stats ?? null,
    names: stored.names && typeof stored.names === "object" ? stored.names : {},
  };
}

function load(): Promise<void> {
  runtime.loaded ??= (async () => {
    const stored = await readJson<Partial<Stored>>(STATE_FILE);
    if (!stored || stored.version !== STATE_VERSION || !Array.isArray(stored.quotes)) return;
    runtime.state = buildLoadedState(stored);
    const updated = stored.updatedAt ? Date.parse(stored.updatedAt) : NaN;
    if (Number.isFinite(updated)) runtime.nextRefreshAt = updated + REFRESH_MS;
  })();
  return runtime.loaded;
}

async function save(): Promise<void> {
  try {
    await writeJson(STATE_FILE, runtime.state, 0o600);
  } catch {
    // The pool in memory is what is served; the file only spares a restart the first read.
  }
}

/**
 * Names for every mentioned user and every poster, from the week-long store first and Slack
 * (users.info) for the rest. Mentions are asked for first: a quote cannot be shown without them,
 * while a poster's name is only a caption.
 */
async function resolveNames(messages: SlackMessage[], known: Record<string, StoredName>): Promise<Map<string, string>> {
  const now = Date.now();
  const names = new Map<string, string>();
  const wanted: string[] = [];
  const want = (id: string) => {
    if (names.has(id) || wanted.includes(id)) return;
    const stored = known[id];
    if (stored && now - stored.at < NAME_TTL_MS) names.set(id, stored.name);
    else wanted.push(id);
  };
  const candidates = messages.filter((message) => !skipReason(message));
  for (const message of candidates) mentionedUserIds(message.text ?? "").forEach(want);
  for (const message of candidates) if (message.user && USER_ID.test(message.user)) want(message.user);
  const queue = wanted.slice(0, MAX_NAME_LOOKUPS);
  await Promise.all(
    Array.from({ length: NAME_LOOKUPS_AT_ONCE }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const name = await resolveUserName(id);
        if (name) {
          names.set(id, name);
          known[id] = { name, at: now };
        } else if (known[id]) {
          // Slack would not say just now; an old name is better than dropping the quote.
          names.set(id, known[id].name);
        }
      }
    }),
  );
  return names;
}

async function refresh(channel: string): Promise<void> {
  try {
    const oldestMs = oldestAllowedMs();
    const { messages, partial } = await readHistory(channel, oldestMs);
    const known = { ...runtime.state.names };
    const names = await resolveNames(messages, known);
    const { quotes, stats } = buildPool(messages, names, oldestMs);
    // Forget names nobody has been asked about for a while.
    const now = Date.now();
    for (const [id, entry] of Object.entries(known)) if (now - entry.at > 4 * NAME_TTL_MS) delete known[id];

    // A read that stopped part-way must not shrink a pool that a full read built.
    const keepOld = partial && quotes.length < runtime.state.quotes.length;
    runtime.state = {
      version: STATE_VERSION,
      channel,
      quotes: keepOld ? runtime.state.quotes : quotes,
      updatedAt: keepOld ? runtime.state.updatedAt : new Date().toISOString(),
      stats: keepOld ? runtime.state.stats : stats,
      names: known,
    };
    runtime.error = null;
    runtime.nextRefreshAt = Date.now() + (partial ? PARTIAL_RETRY_MS : REFRESH_MS);
  } catch (error) {
    const slack = error instanceof SlackError ? error : new SlackError("unknown");
    runtime.error = slack.code;
    runtime.nextRefreshAt = Date.now() + Math.max(RETRY_MS, slack.retryAfterMs ?? 0);
    // If Slack says the bot may not read the channel, stop showing what it read earlier.
    if (isAccessError(slack.code)) runtime.state = { ...emptyState(channel), names: runtime.state.names };
    console.error(`Quotes: could not read Slack (${slack.code}). ${slackHelp(slack.code, channel)}`);
  }
  await save();
}

/**
 * Drops quotes that are older than the window from the pool, whether it came from the file, from
 * an earlier read or from before the window existed, so they are never served and never stay on
 * disk. When any went, the channel is read again at once, so the pool and its stats agree.
 */
function pruneOld(): void {
  const oldestMs = oldestAllowedMs();
  const kept = runtime.state.quotes.filter((quote) => inWindow(quote, oldestMs));
  if (kept.length === runtime.state.quotes.length) return;
  runtime.state = { ...runtime.state, quotes: kept };
  runtime.nextRefreshAt = 0;
  // A read that is already running writes the file itself when it finishes.
  if (!runtime.refreshing) void save();
}

function sample<T>(items: readonly T[], count: number): T[] {
  const copy = items.slice();
  const take = Math.min(count, copy.length);
  for (let index = 0; index < take; index += 1) {
    const pick = index + Math.floor(Math.random() * (copy.length - index));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy.slice(0, take);
}

function prepareChannel(channel: string): void {
  if (runtime.state.channel !== channel) {
    // Another channel: what is stored was read from somewhere else.
    runtime.state = { ...emptyState(channel), names: runtime.state.names };
    runtime.error = null;
    runtime.nextRefreshAt = 0;
  }
  if (runtime.state.version !== STATE_VERSION) {
    // Held in memory by a server that was running before the rules changed: serve it, but read again now.
    runtime.state = { ...runtime.state, version: STATE_VERSION };
    runtime.nextRefreshAt = 0;
  }
}

function buildQuotesResponse(
  channel: string,
  quotes: StoredQuote[],
  updatedAt: string | null,
  stats: QuoteStats | null,
  size: number,
): QuotesResponse {
  const base = { pool: quotes.length, updatedAt, ...(stats ? { stats } : {}) };
  if (quotes.length > 0) {
    // Signed here rather than stored, so a link is always made with the token in use now.
    const picked = sample(quotes, size).map(({ fileId, ...quote }) => ({ ...quote, imageUrl: fileId ? signedImagePath(fileId) : null }));
    return { status: "ok", quotes: picked, ...base };
  }
  if (runtime.error) {
    return {
      status: "error",
      quotes: [],
      ...base,
      error: runtime.error,
      message: `Could not read Slack (${runtime.error}). ${slackHelp(runtime.error, channel)}`,
    };
  }
  if (runtime.refreshing || !updatedAt) return { status: "loading", quotes: [], ...base, message: "Reading the quotes channel." };
  return { status: "empty", quotes: [], ...base, message: "No usable quote was found in the channel." };
}

/**
 * A random sample of the pool. Answers from memory; a re-read of the channel, when one is due, is
 * started here and finishes on its own. Never throws.
 */
export async function getQuotes(count: number = DEFAULT_BATCH): Promise<QuotesResponse> {
  const channel = quotesChannel();
  if (!process.env.SLACK_BOT_TOKEN || !channel) {
    return {
      status: "unconfigured",
      quotes: [],
      pool: 0,
      updatedAt: null,
      message: "Add SLACK_BOT_TOKEN and SLACK_QUOTES_CHANNEL_ID to .env.local to show quotes.",
    };
  }
  try {
    await load();
    prepareChannel(channel);
    pruneOld();
    if (!runtime.refreshing && Date.now() >= runtime.nextRefreshAt) {
      runtime.refreshing = refresh(channel).finally(() => {
        runtime.refreshing = null;
      });
    }
    const { quotes, updatedAt, stats } = runtime.state;
    const size = Math.min(Math.max(Math.floor(Number.isFinite(count) ? count : DEFAULT_BATCH), 1), MAX_BATCH);
    return buildQuotesResponse(channel, quotes, updatedAt, stats, size);
  } catch {
    return { status: "error", quotes: [], pool: 0, updatedAt: null, error: "internal", message: "Quotes are unavailable." };
  }
}
