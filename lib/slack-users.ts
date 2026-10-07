// Resolves Slack user IDs to human names for the spot dashboard.
// Requires the `users:read` bot scope; without it everything degrades to null / omitted names.

type SlackUser = {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
};

type UsersInfoResponse = { ok: boolean; error?: string; user?: SlackUser };

type SpotMessage = { text?: string; user?: string; bot_id?: string; username?: string };

export type SpotDescription = {
  spotter: string | null;
  spotted: string[];
  text: string | null;
};

const NAME_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 2_000;

// Failures that affect every lookup, not just one user: pause all requests for the failure window.
const GLOBAL_ERRORS = new Set([
  "token_missing",
  "missing_scope",
  "rate_limited",
  "ratelimited",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "not_allowed_token_type",
  "access_denied",
]);

const USER_ID = /^[UW][A-Z0-9]{2,}$/;

class SlackUserLookupError extends Error {
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(code: string, retryAfterMs?: number) {
    super(`Slack API error: ${code}`);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const cache = new Map<string, { name: string | null; expiresAt: number }>();
const inFlight = new Map<string, Promise<string | null>>();
const lastLogged = new Map<string, number>();
let pausedUntil = 0;

function logFailure(code: string): void {
  const now = Date.now();
  if (now < (lastLogged.get(code) ?? 0) + FAILURE_TTL_MS) return;
  lastLogged.set(code, now);
  const hint = code === "missing_scope" ? " (add the users:read bot scope and reinstall the app)" : "";
  console.error(`Slack users.info failed: ${code}${hint}. Names will be omitted until it recovers.`);
}

function remember(userId: string, name: string | null, ttlMs: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(userId)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(userId, { name, expiresAt: Date.now() + ttlMs });
}

function pickName(user: SlackUser | undefined): string | null {
  const candidates = [user?.profile?.display_name, user?.real_name, user?.profile?.real_name, user?.name];
  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (name) return name;
  }
  return null;
}

async function fetchUserName(userId: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackUserLookupError("token_missing");

  const url = new URL("https://slack.com/api/users.info");
  url.searchParams.set("user", userId);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new SlackUserLookupError(
      "rate_limited",
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
  if (!response.ok) throw new SlackUserLookupError(`http_${response.status}`);

  const payload = (await response.json()) as UsersInfoResponse;
  if (!payload.ok) throw new SlackUserLookupError(payload.error ?? "unknown");
  return pickName(payload.user);
}

async function lookup(userId: string): Promise<string | null> {
  try {
    const name = await fetchUserName(userId);
    // A user with no usable name is unlikely to gain one soon, but don't pin the miss for an hour.
    remember(userId, name, name ? NAME_TTL_MS : FAILURE_TTL_MS);
    return name;
  } catch (error) {
    const code =
      error instanceof SlackUserLookupError
        ? error.code
        : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout"
          : "network_error";
    if (GLOBAL_ERRORS.has(code)) {
      const retryAfterMs = error instanceof SlackUserLookupError ? error.retryAfterMs ?? 0 : 0;
      const pause = Math.min(Math.max(FAILURE_TTL_MS, retryAfterMs), MAX_BACKOFF_MS);
      pausedUntil = Math.max(pausedUntil, Date.now() + pause);
    } else {
      remember(userId, null, FAILURE_TTL_MS);
    }
    logFailure(code);
    return null;
  }
}

/** Display name for a Slack user ID, or null if it can't be resolved. Cached. Never throws. */
export async function resolveUserName(userId: string): Promise<string | null> {
  try {
    if (typeof userId !== "string" || !USER_ID.test(userId)) return null;

    const cached = cache.get(userId);
    if (cached && Date.now() < cached.expiresAt) return cached.name;

    const pending = inFlight.get(userId);
    if (pending) return await pending;

    // Inside a failure window that applies to every user (missing scope, rate limit, bad token).
    if (Date.now() < pausedUntil) return null;

    const request = lookup(userId).finally(() => {
      inFlight.delete(userId);
    });
    inFlight.set(userId, request);
    return await request;
  } catch {
    return null;
  }
}

// One Slack control sequence: <@U123>, <@U123|label>, <#C123|name>, <!here>, <https://x|label>, ...
const TOKEN = /<([^<>]*)>/g;

function decodeEntities(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function splitLabel(body: string): { target: string; label: string | null } {
  const index = body.indexOf("|");
  if (index === -1) return { target: body, label: null };
  const label = decodeEntities(body.slice(index + 1)).trim();
  return { target: body.slice(0, index), label: label || null };
}

function mentionedUserId(body: string): string | null {
  if (!body.startsWith("@")) return null;
  const id = splitLabel(body.slice(1)).target;
  return USER_ID.test(id) ? id : null;
}

function renderAtToken(body: string, names: Map<string, string>): string {
  const { target, label } = splitLabel(body.slice(1));
  const name = names.get(target) ?? label?.replace(/^@/, "");
  return name ? `@${name}` : "";
}

function renderSpecialMention(body: string): string {
  const { target, label } = splitLabel(body.slice(1));
  if (target === "here" || target === "channel" || target === "everyone") return `@${target}`;
  return label ?? "";
}

function renderToken(body: string, names: Map<string, string>): string {
  if (body.startsWith("@")) return renderAtToken(body, names);
  if (body.startsWith("#")) {
    const { label } = splitLabel(body.slice(1));
    return label ? `#${label.replace(/^#/, "")}` : "";
  }
  if (body.startsWith("!")) return renderSpecialMention(body);
  const { target, label } = splitLabel(body);
  if (label) return label;
  return decodeEntities(target).replace(/^(mailto|tel):/, "");
}

function renderText(text: string, names: Map<string, string>): string | null {
  // Substitute tokens and decode entities in a single pass so resolved names are never re-decoded.
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    output += decodeEntities(text.slice(cursor, match.index)) + renderToken(match[1], names);
    cursor = match.index + match[0].length;
  }
  output += decodeEntities(text.slice(cursor));

  const tidy = output
    .split("\n")
    .map((line) => line.replace(/[ \t\xa0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return tidy || null;
}

function buildMentionLabels(text: string): Map<string, string | null> {
  const labels = new Map<string, string | null>();
  for (const match of text.matchAll(TOKEN)) {
    const id = mentionedUserId(match[1]);
    if (!id) continue;
    const label = splitLabel(match[1].slice(1)).label?.replace(/^@/, "") || null;
    if (!labels.has(id) || (!labels.get(id) && label)) labels.set(id, label);
  }
  return labels;
}

/** Names for one spot message. Never throws. */
export async function describeSpot(message: SpotMessage): Promise<SpotDescription> {
  try {
    const text = typeof message?.text === "string" ? message.text : "";
    const labels = buildMentionLabels(text);
    const mentionedIds = [...labels.keys()];

    const [spotterName, ...mentionedNames] = await Promise.all([
      message?.user ? resolveUserName(message.user) : Promise.resolve(null),
      ...mentionedIds.map((id) => resolveUserName(id)),
    ]);

    const names = new Map<string, string>();
    const spotted: string[] = [];
    mentionedIds.forEach((id, index) => {
      const name = mentionedNames[index] ?? labels.get(id) ?? null;
      if (!name) return;
      names.set(id, name);
      if (!spotted.includes(name)) spotted.push(name);
    });

    return {
      spotter: spotterName ?? (message?.username?.trim() || null),
      spotted,
      text: renderText(text, names),
    };
  } catch {
    return { spotter: null, spotted: [], text: null };
  }
}
