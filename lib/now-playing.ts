import { execFile } from "node:child_process";
import { getSongCredit } from "./song-credit";

// Reads what the Spotify desktop app on this Mac is playing, through its AppleScript dictionary.
// Read-only: it never launches Spotify and never touches playback. No Spotify account or API key is involved.

export type NowPlayingStatus = "playing" | "paused" | "stopped" | "not_running" | "unavailable";

export type NowPlaying = {
  status: NowPlayingStatus;
  reason?: "automation_permission" | "timeout" | "error";
  title: string | null;
  artists: string | null;
  album: string | null;
  artworkUrl: string | null;
  durationMs: number | null;
  positionMs: number | null;
  trackId: string | null;
  /** Slack display name of whoever queued this track through the song-request channel; null when it got here another way. */
  queuedBy: string | null;
  queuedAt: string | null;
  fetchedAt: number;
};

const CACHE_MS = 1_500;
// After a failure (most likely the macOS permission prompt waiting for an answer) ask less often.
const FAILURE_CACHE_MS = 10_000;
const OSASCRIPT_TIMEOUT_MS = 4_000;
const SPOTIFY_BUNDLE_ID = "com.spotify.client";

const HTTPS_URL_RE = /^https?:\/\//i;
const HTTP_TO_HTTPS_RE = /^http:\/\//i;

// JXA rather than AppleScript so the fields come back as JSON: track names can hold any punctuation, newlines or emoji.
// `running()` does not launch the app, and nothing else is sent unless it is already running.
const READ_SCRIPT = `
function run(argv) {
  var app = Application(argv[0]);
  if (!app.running()) return JSON.stringify({ running: false });
  var out = { running: true };
  try {
    out.state = String(app.playerState());
    out.position = app.playerPosition();
  } catch (e) {
    return JSON.stringify({ running: true, error: String(e), errorNumber: e && e.errorNumber });
  }
  try {
    var t = app.currentTrack;
    out.track = { name: t.name(), artist: t.artist(), album: t.album(), artworkUrl: t.artworkUrl(), duration: t.duration(), id: t.id() };
  } catch (e) {
    out.trackError = String(e);
  }
  return JSON.stringify(out);
}`;

type Raw = {
  running?: boolean;
  state?: string;
  position?: unknown;
  error?: string;
  errorNumber?: unknown;
  trackError?: string;
  track?: { name?: unknown; artist?: unknown; album?: unknown; artworkUrl?: unknown; duration?: unknown; id?: unknown };
};

function run(file: string, args: string[], timeout: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    execFile(file, args, { timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr) + (failure && typeof failure.code === "string" ? ` ${failure.code}` : ""),
        timedOut: Boolean(failure?.killed),
      });
    });
  });
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const isPermissionError = (message: string) => /-1743|not authori[sz]ed to send apple events/i.test(message);

function blank(status: NowPlayingStatus, reason?: NowPlaying["reason"]): NowPlaying {
  return { status, ...(reason ? { reason } : {}), title: null, artists: null, album: null, artworkUrl: null, durationMs: null, positionMs: null, trackId: null, queuedBy: null, queuedAt: null, fetchedAt: Date.now() };
}

function interpretOsaError(result: { timedOut: boolean; code: number | null; stderr: string }): NowPlaying | null {
  if (result.timedOut) return blank("unavailable", "timeout");
  if (result.code !== 0) return blank("unavailable", isPermissionError(result.stderr) ? "automation_permission" : "error");
  return null;
}

function interpretRawErrors(raw: Raw): NowPlaying | null {
  if (!raw.running) return blank("not_running");
  if (raw.error) return blank("unavailable", isPermissionError(`${raw.error} ${String(raw.errorNumber)}`) ? "automation_permission" : "error");
  if (raw.trackError && isPermissionError(raw.trackError)) return blank("unavailable", "automation_permission");
  return null;
}

function buildTrackResult(raw: Raw, track: NonNullable<Raw["track"]>, title: string): NowPlaying {
  const status: NowPlayingStatus = raw.state === "playing" || raw.state === "paused" ? raw.state : "stopped";
  const artwork = text(track.artworkUrl);
  const durationMs = count(track.duration);
  const seconds = count(raw.position);
  const positionMs = seconds === null ? null : Math.round(seconds * 1000);
  return {
    status,
    title,
    artists: text(track.artist),
    album: text(track.album),
    // Local files, some podcasts and ads have no artwork (or a non-web one).
    artworkUrl: artwork && HTTPS_URL_RE.test(artwork) ? artwork.replace(HTTP_TO_HTTPS_RE, "https://") : null,
    durationMs: durationMs && durationMs > 0 ? Math.round(durationMs) : null,
    positionMs: positionMs !== null && durationMs ? Math.min(positionMs, durationMs) : positionMs,
    trackId: text(track.id),
    // Filled in per reply by getNowPlaying, from the song-request log.
    queuedBy: null,
    queuedAt: null,
    fetchedAt: Date.now(),
  };
}

async function read(): Promise<NowPlaying> {
  // Cheap first check that cannot launch anything; pgrep exits 1 when there is no such process.
  const probe = await run("/usr/bin/pgrep", ["-x", "Spotify"], 2_000);
  if (probe.code === 1) return blank("not_running");

  const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", READ_SCRIPT, SPOTIFY_BUNDLE_ID], OSASCRIPT_TIMEOUT_MS);
  const osaError = interpretOsaError(result);
  if (osaError) return osaError;

  let raw: Raw;
  try {
    raw = JSON.parse(result.stdout) as Raw;
  } catch {
    return blank("unavailable", "error");
  }
  const rawError = interpretRawErrors(raw);
  if (rawError) return rawError;

  const track = raw.track;
  const title = text(track?.name);
  if (!track || !title) return blank("stopped");
  return buildTrackResult(raw, track, title);
}

function advancePosition(value: NowPlaying, now: number): NowPlaying {
  if (value.status !== "playing" || value.positionMs === null) return { ...value, fetchedAt: now };
  const position = value.positionMs + (now - value.fetchedAt);
  return { ...value, positionMs: value.durationMs ? Math.min(position, value.durationMs) : position, fetchedAt: now };
}

async function fetchCreditedValue(latest: NowPlaying): Promise<NowPlaying> {
  const credit = latest.status === "playing" || latest.status === "paused" ? await getSongCredit(latest.trackId) : null;
  return { ...latest, queuedBy: credit?.queuedBy ?? null, queuedAt: credit?.queuedAt ?? null };
}

let cached: NowPlaying | null = null;
let pending: Promise<NowPlaying> | null = null;

// One osascript at a time, and at most one every CACHE_MS however many clients poll.
export async function getNowPlaying(): Promise<NowPlaying> {
  const maxAge = cached?.status === "unavailable" ? FAILURE_CACHE_MS : CACHE_MS;
  if (!cached || Date.now() - cached.fetchedAt >= maxAge) {
    pending ??= read()
      .catch(() => blank("unavailable", "error"))
      .then((value) => {
        cached = value;
        pending = null;
        return value;
      });
    await pending;
  }
  const latest = cached as NowPlaying;
  const value = await fetchCreditedValue(latest);
  return advancePosition(value, Date.now());
}
