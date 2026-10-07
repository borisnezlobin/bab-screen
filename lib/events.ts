// Upcoming events for the wall, read from the club's Google Calendar as an iCalendar (.ics) feed.
//
// GET /api/events never waits for Google. It answers from the last good parse held in memory and,
// when that is older than REFRESH_MS, starts a new download in the background. A failed download
// keeps the last good list (for at most KEEP_LAST_MS), and every answer is filtered against the
// clock, so an event that has ended is gone whether or not a refresh has happened since.
//
// Times: ical.js parses the file and steps through recurrence rules in the event's own wall-clock
// time, which is what RFC 5545 asks for ("every Monday at 21:00" stays at 21:00 across a DST
// change). Turning a wall-clock time in a named zone into an instant is done here with Intl and
// the machine's tz database, not with the VTIMEZONE blocks in the file and not with the server's
// local timezone. Calendar text is untrusted: only the title and a short location leave this
// module, as plain text with control characters removed and lengths clamped.

import { createHash } from "node:crypto";
import ICAL from "ical.js";

/** The zone the wall shows times in, and the zone all-day events are days of. */
export const EVENTS_TIME_ZONE = "America/Los_Angeles";

const DEFAULT_CALENDAR_ID = "jt8mpvuljj288e0pu5s55ocus0@group.calendar.google.com";
const REFRESH_MS = 10 * 60_000;
/** After a failed download, wait this long before the next try. */
const RETRY_MS = 60_000;
/** A list this old is no longer shown: an event may have moved or been cancelled since. */
const KEEP_LAST_MS = 24 * 3_600_000;
const LOOKAHEAD_DAYS = 28;
const MAX_EVENTS = 12;
/** Anything longer is a banner ("Fall semester"), not an event; it would hold the first row for weeks. */
const MAX_SPAN_DAYS = 14;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 8_000_000;
const USER_AGENT = "bab-screen/0.1 (+events)";
const TITLE_MAX = 120;
const LOCATION_MAX = 40;
/** Steps through one recurrence rule before giving up on it (daily for 50 years is about 18,000). */
const MAX_RULE_STEPS = 20_000;
const DAY_MS = 86_400_000;

export type CalendarEvent = {
  id: string;
  title: string;
  /** Instants, ISO 8601 in UTC. For an all-day event: midnight starting its first day and midnight ending its last, in `timeZone`. */
  start: string;
  end: string;
  allDay: boolean;
  /** All-day events only: first and last day (inclusive), YYYY-MM-DD. */
  startDate: string | null;
  endDate: string | null;
  location: string | null;
};

export type EventsResponse = {
  /** ok: `events` is current (possibly empty). loading: first download still running. error: nothing to show. */
  status: "ok" | "loading" | "error";
  events: CalendarEvent[];
  /** When the list was last read from the calendar. */
  updatedAt: string | null;
  /** The server's clock, so a screen whose clock is off can correct for it. */
  now: string;
  timeZone: string;
  /** True while `events` comes from an earlier download because the latest one failed. */
  stale: boolean;
  message?: string;
};

/** One event, or one instance of a recurring event, inside the parse window. */
export type Occurrence = {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
};

// --- Wall-clock time and zones ---------------------------------------------------------------

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

/** A formatter for an IANA zone, or null when the name is not one this machine knows. */
function zoneFormat(zone: string): Intl.DateTimeFormat | null {
  let format = zoneFormats.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      format = null;
    }
    zoneFormats.set(zone, format);
  }
  return format;
}

const isZone = (zone: string) => zone === "UTC" || zoneFormat(zone) !== null;

/** A wall-clock reading as if it were UTC: only for arithmetic and comparison between wall times. */
const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

function wallFromMs(ms: number): Wall {
  const date = new Date(ms);
  return { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds() };
}

/** What the clocks in `zone` read at an instant. */
function wallAt(ms: number, zone: string): Wall {
  if (zone === "UTC") return wallFromMs(ms);
  const wall: Wall = { y: 0, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
  for (const part of zoneFormat(zone)!.formatToParts(new Date(ms))) {
    const value = Number(part.value);
    if (part.type === "year") wall.y = value;
    else if (part.type === "month") wall.mo = value;
    else if (part.type === "day") wall.d = value;
    else if (part.type === "hour") wall.h = value % 24;
    else if (part.type === "minute") wall.mi = value;
    else if (part.type === "second") wall.s = value;
  }
  return wall;
}

const offsetAt = (ms: number, zone: string) => wallMs(wallAt(ms, zone)) - Math.floor(ms / 1000) * 1000;

/**
 * The instant at which the clocks in `zone` read `wall`. Where a clock change makes the reading
 * happen twice (autumn), the first one is taken; where it never happens (spring), the reading is
 * taken with the offset from before the change, so 02:30 becomes 03:30. Both as RFC 5545 says.
 */
export function zonedToUtc(wall: Wall, zone: string): number {
  const local = wallMs(wall);
  if (zone === "UTC") return local;
  const before = offsetAt(local - DAY_MS, zone);
  const after = offsetAt(local + DAY_MS, zone);
  const candidates = before === after ? [local - before] : [local - before, local - after];
  const valid = candidates.filter((candidate) => offsetAt(candidate, zone) === local - candidate);
  return valid.length ? Math.min(...valid) : local - before;
}

const pad = (value: number) => String(value).padStart(2, "0");
const dateKey = (w: Wall) => `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
const dateNumber = (w: Wall) => w.y * 10_000 + w.mo * 100 + w.d;
const midnight = (w: Wall): Wall => ({ y: w.y, mo: w.mo, d: w.d, h: 0, mi: 0, s: 0 });
const addDays = (w: Wall, days: number): Wall => wallFromMs(wallMs(midnight(w)) + days * DAY_MS);

// --- Untrusted text --------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CLEAN_INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Plain single-line text: no control or invisible formatting characters, clamped by code points. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(CLEAN_INVISIBLE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("").trimEnd()}…` : text;
}

/** A location short enough for the wall, or null. Addresses are cut to their first part; links are dropped. */
function shortLocation(value: unknown): string | null {
  const text = clean(value, 400);
  if (!text || /:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/\S/i.test(text)) return null;
  const length = (candidate: string) => Array.from(candidate).length;
  if (length(text) <= LOCATION_MAX) return text;
  const first = text.split(",")[0].trim();
  return first && length(first) <= LOCATION_MAX ? first : null;
}

// --- Parsing ---------------------------------------------------------------------------------

type IcalTime = InstanceType<typeof ICAL.Time>;
type IcalComponent = InstanceType<typeof ICAL.Component>;
type IcalProperty = InstanceType<typeof ICAL.Property>;

/** A DATE or DATE-TIME value: its fields as written, and for a date-time the zone they are in. */
type Stamp = { isDate: boolean; wall: Wall; zone: string };

const isTime = (value: unknown): value is IcalTime => value instanceof ICAL.Time;
const wallOf = (time: IcalTime): Wall => ({ y: time.year, mo: time.month, d: time.day, h: time.isDate ? 0 : time.hour, mi: time.isDate ? 0 : time.minute, s: time.isDate ? 0 : time.second });

/** Null when the value is not a time, or names a zone this machine does not know (the event is then skipped, not guessed). */
function stampOf(property: IcalProperty | null, value: unknown, calendarZone: string): Stamp | null {
  if (!property || !isTime(value)) return null;
  const wall = wallOf(value);
  if (value.isDate) return { isDate: true, wall, zone: calendarZone };
  if (value.zone?.tzid === "UTC") return { isDate: false, wall, zone: "UTC" };
  const tzid = property.getParameter("tzid");
  if (typeof tzid !== "string" || !tzid) return { isDate: false, wall, zone: calendarZone };
  return isZone(tzid) ? { isDate: false, wall, zone: tzid } : null;
}

const firstStamp = (component: IcalComponent, name: string, calendarZone: string): Stamp | null => {
  const property = component.getFirstProperty(name);
  return stampOf(property, property?.getFirstValue(), calendarZone);
};

const allStamps = (component: IcalComponent, name: string, calendarZone: string): Stamp[] =>
  component.getAllProperties(name).flatMap((property) =>
    property.getValues().flatMap((value: unknown) => stampOf(property, value, calendarZone) ?? []),
  );

/** How an instance is named by EXDATE and RECURRENCE-ID: by instant, or by day for all-day values. */
const stampKeys = (stamp: Stamp): string[] =>
  stamp.isDate ? [`d:${dateKey(stamp.wall)}`] : [`t:${zonedToUtc(stamp.wall, stamp.zone)}`];
/** A timed instance answers to its instant and to its local day; an all-day one to its day. */
const instanceKeys = (stamp: Stamp): string[] =>
  stamp.isDate ? [`d:${dateKey(stamp.wall)}`] : [`t:${zonedToUtc(stamp.wall, stamp.zone)}`, `d:${dateKey(stamp.wall)}`];

type Shape = { allDay: true; days: number } | { allDay: false; wallDurationMs: number };

/** How long the event lasts: whole days for an all-day event, wall-clock time otherwise. */
function shapeOf(component: IcalComponent, start: Stamp, calendarZone: string): Shape {
  const end = firstStamp(component, "dtend", calendarZone);
  const duration = component.getFirstPropertyValue("duration");
  const seconds = duration instanceof ICAL.Duration ? duration.toSeconds() : null;
  if (start.isDate) {
    const days = end?.isDate ? (wallMs(end.wall) - wallMs(start.wall)) / DAY_MS : seconds !== null ? Math.ceil(seconds / 86_400) : 1;
    return { allDay: true, days: Math.max(1, Math.round(days)) };
  }
  if (end && !end.isDate) {
    // The end as the start's own zone reads it, so a 22:00 to 02:00 event still ends at 02:00 on a night the clocks change.
    const endWall = wallAt(zonedToUtc(end.wall, end.zone), start.zone);
    return { allDay: false, wallDurationMs: Math.max(0, wallMs(endWall) - wallMs(start.wall)) };
  }
  return { allDay: false, wallDurationMs: seconds !== null ? Math.max(0, seconds * 1000) : 0 };
}

type Details = { uid: string; title: string; location: string | null };

function occurrence(details: Details, start: Stamp, shape: Shape, displayZone: string): Occurrence {
  const id = createHash("sha1").update(`${details.uid}\n${instanceKeys(start)[0]}`).digest("hex").slice(0, 16);
  if (shape.allDay) {
    const last = addDays(start.wall, shape.days - 1);
    return {
      id,
      title: details.title,
      startMs: zonedToUtc(midnight(start.wall), displayZone),
      endMs: zonedToUtc(addDays(start.wall, shape.days), displayZone),
      allDay: true,
      startDate: dateKey(start.wall),
      endDate: dateKey(last),
      location: details.location,
    };
  }
  const startMs = zonedToUtc(start.wall, start.zone);
  const endMs = shape.wallDurationMs ? zonedToUtc(wallFromMs(wallMs(start.wall) + shape.wallDurationMs), start.zone) : startMs;
  return { id, title: details.title, startMs, endMs: Math.max(startMs, endMs), allDay: false, startDate: null, endDate: null, location: details.location };
}

export type ParseOptions = {
  /** Only events ending after `from` and starting before `to` are returned. */
  from: number;
  to: number;
  /** Zone for all-day events and for times written without one, unless the file names its own. */
  displayZone?: string;
};

function buildReplacedMap(components: IcalComponent[], calendarZone: string): Map<string, Set<string>> {
  const replaced = new Map<string, Set<string>>();
  for (const component of components) {
    const original = firstStamp(component, "recurrence-id", calendarZone);
    if (!original) continue;
    const uid = clean(component.getFirstPropertyValue("uid"), 400);
    const keys = replaced.get(uid) ?? new Set<string>();
    for (const key of stampKeys(original)) keys.add(key);
    replaced.set(uid, keys);
  }
  return replaced;
}

function buildExcludedSet(component: IcalComponent, calendarZone: string, uid: string, replaced: Map<string, Set<string>>): Set<string> {
  const gone = new Set<string>(replaced.get(uid));
  for (const excluded of allStamps(component, "exdate", calendarZone)) {
    for (const key of stampKeys(excluded)) gone.add(key);
  }
  return gone;
}

function isRulePast(stamp: Stamp, untilStamp: Stamp): boolean {
  if (stamp.isDate || untilStamp.isDate) return dateNumber(stamp.wall) > dateNumber(untilStamp.wall);
  const roughly = wallMs(stamp.wall);
  return roughly - 2 * DAY_MS > wallMs(untilStamp.wall) || zonedToUtc(stamp.wall, stamp.zone) > zonedToUtc(untilStamp.wall, untilStamp.zone);
}

function untilStampOf(rule: InstanceType<typeof ICAL.Recur>, startZone: string): Stamp | null {
  const until = isTime(rule.until) ? rule.until : null;
  if (!until) return null;
  const zone = until.zone?.tzid === "UTC" ? "UTC" : startZone;
  return { isDate: until.isDate, wall: wallOf(until), zone };
}

function stepRule(
  rule: InstanceType<typeof ICAL.Recur>,
  start: Stamp,
  untilStamp: Stamp | null,
  from: number,
  to: number,
  spanMs: number,
  emit: (stamp: Stamp) => void,
): boolean {
  const stepping = rule.clone();
  stepping.until = null;
  const iterator = stepping.iterator(ICAL.Time.fromData({ year: start.wall.y, month: start.wall.mo, day: start.wall.d, hour: start.wall.h, minute: start.wall.mi, second: start.wall.s, isDate: start.isDate }));
  for (let step = 0; step < MAX_RULE_STEPS; step += 1) {
    const next = iterator.next();
    if (!next) return true;
    const stamp: Stamp = { isDate: start.isDate, wall: wallOf(next), zone: start.zone };
    const roughly = wallMs(stamp.wall);
    if (untilStamp && isRulePast(stamp, untilStamp)) return true;
    if (roughly - 2 * DAY_MS >= to) return true;
    if (roughly + spanMs + 2 * DAY_MS > from) emit(stamp);
  }
  return false;
}

function processRrules(
  component: IcalComponent,
  start: Stamp,
  details: Details,
  shape: Shape,
  calendarZone: string,
  displayZone: string,
  uid: string,
  replaced: Map<string, Set<string>>,
  options: ParseOptions,
  spanMs: number,
  keep: (item: Occurrence) => void,
): number {
  const rules = component.getAllProperties("rrule").map((p) => p.getFirstValue()).filter((r): r is InstanceType<typeof ICAL.Recur> => r instanceof ICAL.Recur);
  const extra = allStamps(component, "rdate", calendarZone);
  if (!rules.length && !extra.length) {
    keep(occurrence(details, start, shape, displayZone));
    return 0;
  }
  const gone = buildExcludedSet(component, calendarZone, uid, replaced);
  const emit = (stamp: Stamp) => {
    if (!instanceKeys(stamp).some((key) => gone.has(key))) keep(occurrence(details, stamp, shape, displayZone));
  };
  for (const stamp of extra) if (stamp.isDate === start.isDate) emit(stamp);
  if (!rules.length) { emit(start); return 0; }
  let unfinished = 0;
  for (const rule of rules) {
    const untilStamp = untilStampOf(rule, start.zone);
    if (!stepRule(rule, start, untilStamp, options.from, options.to, spanMs, emit)) unfinished += 1;
  }
  return unfinished;
}

function processComponent(
  component: IcalComponent,
  calendarZone: string,
  displayZone: string,
  replaced: Map<string, Set<string>>,
  options: ParseOptions,
  keep: (item: Occurrence) => void,
): number {
  const start = firstStamp(component, "dtstart", calendarZone);
  if (!start) return 1;
  if (clean(component.getFirstPropertyValue("status"), 40).toUpperCase() === "CANCELLED") return 0;
  const uid = clean(component.getFirstPropertyValue("uid"), 400);
  const details: Details = {
    uid,
    title: clean(component.getFirstPropertyValue("summary"), TITLE_MAX) || "(No title)",
    location: shortLocation(component.getFirstPropertyValue("location")),
  };
  const shape = shapeOf(component, start, calendarZone);
  const spanMs = shape.allDay ? shape.days * DAY_MS : shape.wallDurationMs;
  if (component.hasProperty("recurrence-id")) {
    keep(occurrence(details, start, shape, displayZone));
    return 0;
  }
  return processRrules(component, start, details, shape, calendarZone, displayZone, uid, replaced, options, spanMs, keep);
}

/**
 * Every event and recurrence instance in the window, soonest first. Throws if the text is not an
 * iCalendar file. `skipped` counts events left out because they could not be read with certainty
 * (an unknown timezone name, a rule that never reaches the window).
 */
export function parseCalendar(text: string, options: ParseOptions): { events: Occurrence[]; skipped: number } {
  const displayZone = options.displayZone ?? EVENTS_TIME_ZONE;
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== "vcalendar") throw new Error("not_a_calendar");
  const named = root.getFirstPropertyValue("x-wr-timezone");
  const calendarZone = typeof named === "string" && isZone(named.trim()) ? named.trim() : displayZone;
  const maxSpanMs = MAX_SPAN_DAYS * DAY_MS;

  const results = new Map<string, Occurrence>();
  let skipped = 0;
  const keep = (item: Occurrence) => {
    if (item.endMs - item.startMs > maxSpanMs) return;
    if (item.endMs <= options.from || item.startMs >= options.to) return;
    if (!results.has(item.id)) results.set(item.id, item);
  };

  const components = root.getAllSubcomponents("vevent");
  const replaced = buildReplacedMap(components, calendarZone);
  for (const component of components) {
    skipped += processComponent(component, calendarZone, displayZone, replaced, options, keep);
  }

  const events = [...results.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.title.localeCompare(b.title));
  return { events, skipped };
}

/** Events that have not ended at `now` and start within the lookahead, soonest first. */
export function upcoming(events: Occurrence[], now: number, limit = MAX_EVENTS): CalendarEvent[] {
  const horizon = now + LOOKAHEAD_DAYS * DAY_MS;
  return events
    .filter((event) => event.endMs > now && event.startMs < horizon)
    .slice(0, limit)
    .map((event) => ({
      id: event.id,
      title: event.title,
      start: new Date(event.startMs).toISOString(),
      end: new Date(event.endMs).toISOString(),
      allDay: event.allDay,
      startDate: event.startDate,
      endDate: event.endDate,
      location: event.location,
    }));
}

// --- Source ----------------------------------------------------------------------------------

type Source = { url: string; kind: "address" | "public" } | { url: null; problem: string };

/** EVENTS_ICS_URL (any https .ics address, e.g. Google's secret iCal address) wins over the public feed of EVENTS_CALENDAR_ID. */
function source(): Source {
  const direct = process.env.EVENTS_ICS_URL?.trim();
  if (direct) {
    try {
      const url = new URL(direct.replace(/^webcals?:/i, "https:"));
      if (url.protocol === "https:" && !url.username && !url.password) return { url: url.toString(), kind: "address" };
    } catch {
      // Reported below, without echoing the value: the address is a secret.
    }
    return { url: null, problem: "EVENTS_ICS_URL is not an https address" };
  }
  const id = process.env.EVENTS_CALENDAR_ID?.trim() || DEFAULT_CALENDAR_ID;
  if (!/^[\w.%+#-]{1,200}@[\w.-]{1,200}$/.test(id)) return { url: null, problem: "EVENTS_CALENDAR_ID is not a calendar ID" };
  return { url: `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`, kind: "public" };
}

class DownloadError extends Error {}

async function download(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/calendar, text/plain;q=0.8, */*;q=0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new DownloadError(`http_${response.status}`);
  }
  // Read at most FETCH_MAX_BYTES, so a runaway response cannot fill memory.
  const reader = response.body?.getReader();
  if (!reader) throw new DownloadError("empty_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.byteLength;
    if (size > FETCH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DownloadError("too_large");
    }
    chunks.push(value);
  }
  // Buffer strips nothing: a byte-order mark, if any, is still the first character.
  const body = Buffer.concat(chunks).toString("utf8").replace(/^\s+/, "");
  if (!/^BEGIN:VCALENDAR/i.test(body.slice(body.charCodeAt(0) === 0xfeff ? 1 : 0, 200))) throw new DownloadError("not_a_calendar");
  return body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;
}

/** A short code for what went wrong. Never includes the address, which may be a secret. */
function errorCode(error: unknown): string {
  if (error instanceof DownloadError) return error.message;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "network_error";
  return "unreadable_calendar";
}

function explain(code: string, kind: "address" | "public"): string {
  if (kind === "public" && (code === "http_404" || code === "http_403")) {
    return "The calendar is not public (or EVENTS_CALENDAR_ID is wrong). Make it public in Google Calendar, or set EVENTS_ICS_URL to its secret iCal address.";
  }
  if (kind === "address" && /^http_4/.test(code)) return `EVENTS_ICS_URL was refused (${code}). Copy the address again from the calendar's settings.`;
  return `Calendar unavailable (${code}).`;
}

// --- Cache -----------------------------------------------------------------------------------

// On globalThis so every copy of this module (route bundles, dev-mode reloads) shares one cache.
type Runtime = {
  /** The address the cache belongs to; a changed env var starts over. */
  url: string | null;
  events: Occurrence[];
  /** Last successful download, and last attempt of any kind. */
  fetchedAt: number;
  attemptAt: number;
  error: string | null;
  refreshing: Promise<void> | null;
};

const globalStore = globalThis as typeof globalThis & { __babEvents?: Runtime };
const runtime: Runtime = (globalStore.__babEvents ??= { url: null, events: [], fetchedAt: 0, attemptAt: 0, error: null, refreshing: null });

async function refresh(url: string, kind: "address" | "public"): Promise<void> {
  const startedAt = Date.now();
  let events: Occurrence[] | null = null;
  let error: string | null = null;
  try {
    const text = await download(url);
    // One day of margin behind, so an event in progress at any point before the next refresh is in the list.
    events = parseCalendar(text, { from: startedAt - DAY_MS, to: startedAt + (LOOKAHEAD_DAYS + 2) * DAY_MS }).events;
  } catch (failure) {
    error = explain(errorCode(failure), kind);
  }
  if (runtime.url !== url) return; // The source changed while this was running.
  runtime.attemptAt = Date.now();
  runtime.error = error;
  if (events) {
    runtime.events = events;
    runtime.fetchedAt = startedAt;
  }
}

function scheduleRefresh(from: { url: string; kind: "address" | "public" }, now: number): void {
  if (runtime.url !== from.url) {
    Object.assign(runtime, { url: from.url, events: [], fetchedAt: 0, attemptAt: 0, error: null, refreshing: null });
  }
  const wait = runtime.error ? RETRY_MS : REFRESH_MS;
  if (runtime.refreshing || now - runtime.attemptAt < wait) return;
  const run = refresh(from.url, from.kind).finally(() => {
    if (runtime.refreshing === run) runtime.refreshing = null;
  });
  runtime.refreshing = run;
}

/** The current list, from memory. Starts a background refresh when one is due; never waits for it. */
export function getEvents(now = Date.now()): EventsResponse {
  const base = { now: new Date(now).toISOString(), timeZone: EVENTS_TIME_ZONE };
  const from = source();
  if ("problem" in from) {
    return { ...base, status: "error", events: [], updatedAt: null, stale: false, message: from.problem };
  }
  scheduleRefresh(from, now);
  const message = runtime.error ?? undefined;
  if (!runtime.fetchedAt || now - runtime.fetchedAt > KEEP_LAST_MS) {
    const status = runtime.error ? "error" : "loading";
    return { ...base, status, events: [], updatedAt: null, stale: false, ...(message ? { message } : {}) };
  }
  return {
    ...base,
    status: "ok",
    events: upcoming(runtime.events, now),
    updatedAt: new Date(runtime.fetchedAt).toISOString(),
    stale: runtime.error !== null,
    ...(message ? { message } : {}),
  };
}
