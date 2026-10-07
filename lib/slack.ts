import { createHmac, timingSafeEqual } from "node:crypto";
import { describeSpot } from "./slack-users";

/** How many recent image messages /api/spot returns in `spots` (newest first). */
export const MAX_SPOTS = 6;

// Slack-generated previews to serve instead of the multi-megabyte original, best first.
// The dashboard frame is roughly 900x1000 device pixels, so ~1024px on the long edge is plenty.
const PREFERRED_THUMBNAILS = ["thumb_1024", "thumb_960", "thumb_800"] as const;

export type SlackFile = {
  id?: string;
  mimetype?: string;
  filetype?: string;
  /** "hosted" for an upload; "tombstone" / "hidden_by_limit" when the content is gone. */
  mode?: string;
  url_private?: string;
  thumb_1024?: string;
  thumb_960?: string;
  thumb_800?: string;
};

export type SlackMessage = {
  ts?: string;
  /** Set on replies (and on a thread's parent, where it equals ts). */
  thread_ts?: string;
  subtype?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  files?: SlackFile[];
  blocks?: Array<{ type?: string; slack_file?: { id?: string }; image_url?: string }>;
  attachments?: Array<{ image_url?: string }>;
};

type SlackResponse<T> = T & { ok: boolean; error?: string };

export type Spot = {
  /** Slack message ts; unique within the channel and stable across polls. */
  id: string;
  imageUrl: string;
  /** Message text with mentions rendered as @Name, or null if there is none. */
  text: string | null;
  /** Name of whoever posted the photo, or null if it can't be resolved. */
  spotter: string | null;
  /** Names of the @mentioned people, in order of appearance. */
  spotted: string[];
  postedAt: string | null;
  permalink: string | null;
};

export type SpotResult = {
  status: "ok" | "empty" | "unconfigured" | "error";
  // The legacy top-level fields mirror spots[0].
  imageUrl: string | null;
  text: string | null;
  permalink: string | null;
  postedAt: string | null;
  /** Spotter's name, falling back to the Slack username / raw id / "Spotbot". */
  author: string | null;
  spotter: string | null;
  spotted: string[];
  /** Most recent image messages, newest first, at most MAX_SPOTS. */
  spots: Spot[];
  message?: string;
};

function emptyFields() {
  return {
    imageUrl: null,
    text: null,
    permalink: null,
    postedAt: null,
    author: null,
    spotter: null,
    spotted: [] as string[],
    spots: [] as Spot[],
  };
}

export class SlackApiError extends Error {
  constructor(public readonly code: string) {
    super(`Slack API error: ${code}`);
  }
}

export async function slackGet<T>(method: string, params: Record<string, string>): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackApiError("token_missing");

  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (response.status === 429) throw new SlackApiError("rate_limited");
  if (!response.ok) throw new SlackApiError(`http_${response.status}`);

  const payload = (await response.json()) as SlackResponse<T>;
  if (!payload.ok) throw new SlackApiError(payload.error ?? "unknown");
  return payload;
}

/** An uploaded file that is a picture (not a video, a document, ...). */
export function isImageFile(file: SlackFile): boolean {
  return Boolean(
    file.id &&
      (file.mimetype?.startsWith("image/") ||
        ["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(file.filetype ?? "")),
  );
}

function imageFile(message: SlackMessage): SlackFile | undefined {
  const files = message.files ?? [];
  const image = files.find(isImageFile);
  if (image) return image;

  // Image blocks can reference a Slack file without listing it in message.files.
  const blockFileId = message.blocks?.find(
    (block) => block.type === "image" && block.slack_file?.id,
  )?.slack_file?.id;
  return blockFileId ? { id: blockFileId } : undefined;
}

function externalImageUrl(message: SlackMessage): string | undefined {
  const candidate =
    message.blocks?.find((block) => block.type === "image" && block.image_url)?.image_url ??
    message.attachments?.find((attachment) => attachment.image_url)?.image_url;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    // Slack-hosted files need a token and must go through the signed file proxy.
    return url.protocol === "https:" && !/(^|\.)slack\.com$/.test(url.hostname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function imageSignature(fileId: string): string {
  return createHmac("sha256", process.env.SLACK_BOT_TOKEN ?? "")
    .update(fileId)
    .digest("hex");
}

export function signedImagePath(fileId: string): string {
  return `/api/spot/image?file=${encodeURIComponent(fileId)}&sig=${imageSignature(fileId)}`;
}

export function validImageSignature(fileId: string, signature: string): boolean {
  if (!process.env.SLACK_BOT_TOKEN || !/^F[A-Z0-9]+$/.test(fileId) || !/^[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(imageSignature(fileId), "hex"));
}

export async function getSlackFileUrl(fileId: string): Promise<string> {
  const payload = await slackGet<{ file?: SlackFile }>("files.info", { file: fileId });
  const file = payload.file;
  if (!file?.mimetype?.startsWith("image/") || !file.url_private) {
    throw new SlackApiError("not_an_image");
  }
  // Thumbnails are static, so keep the original for GIFs to preserve animation.
  const thumbnails = file.mimetype === "image/gif" ? [] : PREFERRED_THUMBNAILS.map((key) => file[key]);
  for (const candidate of [...thumbnails, file.url_private]) {
    const url = slackHostedUrl(candidate);
    if (url) return url;
  }
  throw new SlackApiError("invalid_file_url");
}

function slackHostedUrl(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && /(^|\.)slack\.com$/.test(url.hostname) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const OK_TTL_MS = 60_000;
const RETRY_TTL_MS = 10_000;

type Fetched = { value: SpotResult; ttlMs: number };
type SpotMatch = { message: SlackMessage; ts: string; imageUrl: string };

let cachedSpot: { value: SpotResult; expiresAt: number } | undefined;
let inFlight: Promise<SpotResult> | undefined;

function buildUnconfiguredResult(): Fetched {
  return {
    ttlMs: RETRY_TTL_MS,
    value: {
      status: "unconfigured",
      ...emptyFields(),
      message: "Add SLACK_BOT_TOKEN and SLACK_CHANNEL_ID to .env.local to show Spotbot images.",
    },
  };
}

function buildEmptyResult(): Fetched {
  return {
    ttlMs: OK_TTL_MS,
    value: {
      status: "empty",
      ...emptyFields(),
      message: "No image from Spotbot was found in the latest channel messages.",
    },
  };
}

function buildErrorResult(error: unknown): Fetched {
  const code = error instanceof SlackApiError ? error.code : "network_error";
  return {
    ttlMs: RETRY_TTL_MS,
    value: {
      status: "error",
      ...emptyFields(),
      message: `Could not read Slack (${code}). Check the token, scopes, and channel access.`,
    },
  };
}

function collectSpotMatches(messages: SlackMessage[], spotbotId: string | undefined): SpotMatch[] {
  const matches: SpotMatch[] = [];
  for (const message of messages) {
    if (matches.length >= MAX_SPOTS) break;
    if (spotbotId && message.user !== spotbotId && message.bot_id !== spotbotId) continue;
    const fileId = imageFile(message)?.id;
    const imageUrl = fileId ? signedImagePath(fileId) : externalImageUrl(message);
    if (!message.ts || !imageUrl) continue;
    matches.push({ message, ts: message.ts, imageUrl });
  }
  return matches;
}

function buildSpots(matches: SpotMatch[], descriptions: Awaited<ReturnType<typeof describeSpot>>[], channel: string): Spot[] {
  return matches.map(({ ts, imageUrl }, index) => {
    const timestamp = Number(ts);
    const { spotter, spotted, text } = descriptions[index];
    return {
      id: ts,
      imageUrl,
      text,
      spotter,
      spotted,
      postedAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null,
      permalink: `https://app.slack.com/archives/${encodeURIComponent(channel)}/p${ts.replace(".", "")}`,
    };
  });
}

function buildOkResult(spots: Spot[], matches: SpotMatch[]): Fetched {
  const latest = spots[0];
  const latestMessage = matches[0].message;
  const namesMissing = matches.some(({ message }, index) => message.user && !spots[index].spotter);
  const author =
    latest.spotter || latestMessage.username || latestMessage.user || latestMessage.bot_id || "Spotbot";
  return {
    ttlMs: namesMissing ? RETRY_TTL_MS : OK_TTL_MS,
    value: {
      status: "ok",
      imageUrl: latest.imageUrl,
      text: latest.text,
      permalink: latest.permalink,
      postedAt: latest.postedAt,
      author,
      spotter: latest.spotter,
      spotted: latest.spotted,
      spots,
    },
  };
}

async function fetchLatestSpot(): Promise<Fetched> {
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!process.env.SLACK_BOT_TOKEN || !channel) return buildUnconfiguredResult();

  try {
    const payload = await slackGet<{ messages?: SlackMessage[] }>("conversations.history", {
      channel,
      limit: "100",
    });
    const matches = collectSpotMatches(payload.messages ?? [], process.env.SLACK_SPOTBOT_USER_ID);
    if (matches.length === 0) return buildEmptyResult();

    const descriptions = await Promise.all(matches.map(({ message }) => describeSpot(message)));
    const spots = buildSpots(matches, descriptions, channel);
    return buildOkResult(spots, matches);
  } catch (error) {
    return buildErrorResult(error);
  }
}

export async function getLatestSpot(): Promise<SpotResult> {
  if (cachedSpot && Date.now() < cachedSpot.expiresAt) return cachedSpot.value;
  if (!inFlight) {
    inFlight = fetchLatestSpot().then(({ value, ttlMs }) => {
      cachedSpot = { value, expiresAt: Date.now() + ttlMs };
      return value;
    }).finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}
