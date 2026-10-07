// Chumming photos for the carousel: the newest pictures posted in the club's "chumming" Slack channel
// (SLACK_CHUM_CHANNEL_ID), where members post photos of themselves hanging out with other members.
//
// Read-only, and separate from the spots in lib/slack.ts: its own channel, its own cache, its own
// status. It shares only the Slack request helper, the signed image proxy (/api/spot/image) and the
// name lookups, so a failure here never reaches /api/spot or /api/quotes.

import { SlackApiError, isImageFile, signedImagePath, slackGet, type SlackMessage } from "./slack";
import { describeSpot } from "./slack-users";

/** How many photos /api/chum returns (newest first). */
export const MAX_CHUM_PHOTOS = 6;

export type ChumPhoto = {
  /** Message ts plus file id: unique per photo and stable across polls. */
  id: string;
  imageUrl: string;
  /** The message as plain text (mentions as @Name; emoji codes and links removed), or null. */
  text: string | null;
  /** Who posted the photo, or null if the name can't be resolved. */
  poster: string | null;
  /** The people the poster named: who they were chumming with. In order of appearance. */
  chums: string[];
  postedAt: string | null;
  permalink: string | null;
};

export type ChumResult = {
  status: "ok" | "empty" | "unconfigured" | "error";
  /**
   * The newest photos, newest first, at most MAX_CHUM_PHOTOS. Photos are counted one by one: a
   * message with two pictures gives two entries (in the order they were attached) with the same
   * text, poster and chums.
   */
  photos: ChumPhoto[];
  message?: string;
};

const OK_TTL_MS = 60_000;
const RETRY_TTL_MS = 20_000;

/** Slack emoji codes (":fire:", ":wave::skin-tone-3:") and bare links say nothing on a TV. */
function tidyText(text: string | null): string | null {
  if (!text) return null;
  const tidy = text
    .replace(/(?<!\d):[a-z0-9_+'-]+:(?!\d)/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return tidy || null;
}

/** A photo post: typed by a person at the top level of the channel. */
function isPost(message: SlackMessage): boolean {
  if (!message.ts || !message.user || message.bot_id) return false;
  // Join notices, Slackbot responses, deleted-message tombstones, replies also sent to the channel...
  if (message.subtype && message.subtype !== "file_share") return false;
  return !message.thread_ts || message.thread_ts === message.ts;
}

type Fetched = { value: ChumResult; ttlMs: number };
type PhotoMatch = { message: SlackMessage; ts: string; fileId: string };

function addImageFiles(matches: PhotoMatch[], message: SlackMessage): void {
  for (const file of message.files ?? []) {
    if (matches.length >= MAX_CHUM_PHOTOS) break;
    if (!file.id || !isImageFile(file) || (file.mode && file.mode !== "hosted")) continue;
    matches.push({ message, ts: message.ts as string, fileId: file.id });
  }
}

function collectPhotoMatches(messages: SlackMessage[]): PhotoMatch[] {
  const matches: PhotoMatch[] = [];
  for (const message of messages) {
    if (matches.length >= MAX_CHUM_PHOTOS) break;
    if (!isPost(message)) continue;
    addImageFiles(matches, message);
  }
  return matches;
}

function buildChumPhotos(matches: PhotoMatch[], descriptions: Map<SlackMessage, Awaited<ReturnType<typeof describeSpot>>>, channel: string): ChumPhoto[] {
  return matches.map(({ message, ts, fileId }) => {
    const timestamp = Number(ts);
    const desc = descriptions.get(message);
    return {
      id: `${ts}-${fileId}`,
      imageUrl: signedImagePath(fileId),
      text: tidyText(desc?.text ?? null),
      poster: desc?.spotter ?? null,
      chums: desc?.spotted ?? [],
      postedAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null,
      permalink: `https://app.slack.com/archives/${encodeURIComponent(channel)}/p${ts.replace(".", "")}`,
    };
  });
}

async function fetchChum(): Promise<Fetched> {
  const channel = process.env.SLACK_CHUM_CHANNEL_ID;
  if (!process.env.SLACK_BOT_TOKEN || !channel) {
    return { ttlMs: RETRY_TTL_MS, value: { status: "unconfigured", photos: [], message: "Add SLACK_BOT_TOKEN and SLACK_CHUM_CHANNEL_ID to .env.local to show chumming photos." } };
  }

  try {
    const payload = await slackGet<{ messages?: SlackMessage[] }>("conversations.history", { channel, limit: "100" });
    const matches = collectPhotoMatches(payload.messages ?? []);
    if (matches.length === 0) {
      return { ttlMs: OK_TTL_MS, value: { status: "empty", photos: [], message: "No photo was found in the latest channel messages." } };
    }

    const uniqueMessages = [...new Set(matches.map(({ message }) => message))];
    const described = await Promise.all(uniqueMessages.map((message) => describeSpot(message)));
    const descriptions = new Map(uniqueMessages.map((message, index) => [message, described[index]]));
    const photos = buildChumPhotos(matches, descriptions, channel);
    const namesMissing = photos.some((photo) => !photo.poster);
    return { ttlMs: namesMissing ? RETRY_TTL_MS : OK_TTL_MS, value: { status: "ok", photos } };
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "network_error";
    return { ttlMs: RETRY_TTL_MS, value: { status: "error", photos: [], message: `Could not read the chumming channel (${code}). Check SLACK_CHUM_CHANNEL_ID, the scopes, and that the bot is in the channel.` } };
  }
}

let cached: { value: ChumResult; expiresAt: number } | undefined;
let inFlight: Promise<ChumResult> | undefined;

/** The newest chumming photos. Asks Slack at most once a minute per server process. Never throws. */
export async function getChumPhotos(): Promise<ChumResult> {
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  if (!inFlight) {
    inFlight = fetchChum()
      .then(({ value, ttlMs }) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}
