"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cx } from "./ui";
import type { JamView } from "../lib/jam";
import type { NowPlaying as NowPlayingData } from "../lib/now-playing";

const POLL_MS = 4_000;
const REQUEST_TIMEOUT_MS = 8_000;
// How long the last known track stays up while /api/now-playing is failing.
const KEEP_LAST_MS = 20_000;
const BAR_TICK_MS = 500;
// A showing with less than this left is not worth putting up (the last poll of a minute).
const JAM_MIN_LEFT_MS = 500;
// Side of the white square behind the Jam QR (size-75 in jamTile).
const JAM_QR_BOX_PX = 300;

type Reply = NowPlayingData & { jam?: JamView | null };
// endsAt is on this page's performance clock, so the tile goes back on time whatever the polls do.
type Jam = { view: JamView; endsAt: number };

const TILE = "flex shrink-0 gap-5 overflow-hidden transition-[height] duration-500 ease-out-soft";

function ProgressTrack({ children }: { children: React.ReactNode }) {
  return <div aria-hidden="true" className="mt-auto h-1.5 shrink-0 overflow-hidden rounded-full bg-rule">{children}</div>;
}

/**
 * The Jam invite link as a QR code, shown in place of the song for a minute after someone asks for it in Slack.
 * A plain function, not a component: its <section> then takes the place of the song's in the same DOM element,
 * so the tile's height eases between its two sizes (and the column below follows) instead of snapping.
 */
function jamTile(jam: Jam) {
  const { view } = jam;
  if (!view.qr) {
    return (
      <section className={cx(TILE, "h-28 items-center justify-center")} aria-label="Spotify Jam">
        <p className="text-center text-body text-balance text-text-secondary">No Jam link yet. Set one in Slack: @bot jam &lt;Jam invite link&gt;</p>
      </section>
    );
  }
  // A whole number of screen pixels per module, so every edge lands on a pixel boundary of the 1920x1080 stage.
  const side = Math.max(1, Math.floor(JAM_QR_BOX_PX / view.qr.modules)) * view.qr.modules;
  const inset = Math.max(0, Math.floor((JAM_QR_BOX_PX - side) / 2));
  // The bar empties over what is left of the minute. Fixed when this showing first arrived, so later polls do not restart it.
  const drain = { "--drain-from": (view.remainingMs / view.totalMs).toFixed(4), animationDuration: `${Math.round(view.remainingMs)}ms` } as CSSProperties;
  return (
    <section className={cx(TILE, "h-75")} aria-label="Spotify Jam">
      <div className="size-75 shrink-0 overflow-hidden rounded-inner bg-paper">
        <svg viewBox={`0 0 ${view.qr.modules} ${view.qr.modules}`} width={side} height={side} style={{ margin: inset }} className="fill-ink" shapeRendering="crispEdges" role="img" aria-label="QR code of the Jam invite link">
          <path d={view.qr.path} />
        </svg>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 py-2">
        <p className="font-narrow text-title font-semibold">Scan to join the Jam</p>
        <p className="text-label text-text-secondary">Add songs from your phone</p>
        <ProgressTrack>
          <span key={view.until} className="block h-full origin-left animate-drain bg-accent" style={drain} />
        </ProgressTrack>
      </div>
    </section>
  );
}

function unavailableMessage(data: NowPlayingData | "idle" | null) {
  if (data === null) return "";
  if (data === "idle" || data.status !== "unavailable") return "Nothing playing";
  return data.reason === "automation_permission"
    ? "To show the song, allow this app to control Spotify in System Settings > Privacy & Security > Automation"
    : "Spotify is not responding";
}

function playingTrack(data: NowPlayingData | "idle" | null) {
  if (!data || data === "idle") return null;
  return (data.status === "playing" || data.status === "paused") && data.title ? data : null;
}

const pickJam = (current: Jam | null, view: JamView | null, at: number): Jam | null => {
  if (!view) return null;
  if (current && current.view.until === view.until && current.view.url === view.url) return current;
  return { view, endsAt: at + view.remainingMs };
};

/** Polls /api/now-playing; keeps the last track up through short outages. */
function useNowPlaying() {
  const [data, setData] = useState<NowPlayingData | "idle" | null>(null);
  const [jam, setJam] = useState<Jam | null>(null);
  // Position at the last poll and when (performance clock) it was received; the bar runs forward from here.
  const anchor = useRef({ positionMs: 0, at: 0 });

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let request: AbortController | null = null;
    let lastOk = performance.now();

    const poll = async () => {
      request = new AbortController();
      const giveUp = window.setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/now-playing", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Now playing request failed");
        const next = (await response.json()) as Reply;
        if (!alive) return;
        lastOk = performance.now();
        anchor.current = { positionMs: next.positionMs ?? 0, at: lastOk };
        setData(next);
        const view = next.jam && next.jam.remainingMs > JAM_MIN_LEFT_MS ? next.jam : null;
        setJam((current) => pickJam(current, view, lastOk));
      } catch {
        if (alive && performance.now() - lastOk > KEEP_LAST_MS) setData("idle");
      } finally {
        window.clearTimeout(giveUp);
      }
      if (alive) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    return () => {
      alive = false;
      window.clearTimeout(timer);
      request?.abort();
    };
  }, []);

  // The QR comes down at its deadline even if no poll gets through to say so.
  const jamEndsAt = jam?.endsAt ?? null;
  useEffect(() => {
    if (jamEndsAt === null) return;
    const timer = window.setTimeout(
      () => setJam((current) => (current?.endsAt === jamEndsAt ? null : current)),
      Math.max(0, jamEndsAt - performance.now()),
    );
    return () => window.clearTimeout(timer);
  }, [jamEndsAt]);

  return { data, jam, anchor };
}

/** Between polls the bar is moved straight on the element, so the tile re-renders only when a poll lands. */
function useProgressBar(anchor: React.RefObject<{ positionMs: number; at: number }>, durationMs: number | null, playing: boolean, deps: readonly unknown[]) {
  const fill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = fill.current;
    if (!element || !durationMs) return;
    const paint = () => {
      const { positionMs, at } = anchor.current;
      const position = playing ? positionMs + (performance.now() - at) : positionMs;
      element.style.scale = `${Math.min(1, Math.max(0, position / durationMs)).toFixed(5)} 1`;
    };
    paint();
    if (!playing) return;
    const ticker = window.setInterval(paint, BAR_TICK_MS);
    return () => window.clearInterval(ticker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, playing, ...deps]);
  return fill;
}

type Track = NonNullable<ReturnType<typeof playingTrack>>;

function TrackArt({ track, playing }: { track: Track; playing: boolean }) {
  const [badArtwork, setBadArtwork] = useState<string | null>(null);
  const artwork = track.artworkUrl && track.artworkUrl !== badArtwork ? track.artworkUrl : null;
  return (
    <div className="aspect-square h-full shrink-0 overflow-hidden rounded-inner bg-surface-sunk">
      {artwork && <img key={artwork} src={artwork} alt={track.album ? `Cover of ${track.album}` : ""} onError={() => setBadArtwork(artwork)} className={cx("size-full object-cover outline-1 -outline-offset-1 outline-edge", !playing && "opacity-45")} />}
    </div>
  );
}

function TrackTile({ track, playing, fill }: { track: Track; playing: boolean; fill: React.RefObject<HTMLSpanElement | null> }) {
  const trackId = track.trackId ?? track.title;
  return (
    <section className={cx(TILE, "h-28")} aria-label="Now playing">
      <TrackArt track={track} playing={playing} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cx("font-narrow text-title font-semibold wrap-anywhere", track.queuedBy ? "line-clamp-1" : "line-clamp-2", !playing && "text-text-secondary")}>{track.title}</p>
        <p className="flex items-baseline justify-between gap-4 text-body whitespace-nowrap text-text-secondary">
          <span className="min-w-0 truncate">{track.artists ?? track.album ?? ""}</span>
          {!playing && <span className="shrink-0 text-label text-text-muted">Paused</span>}
        </p>
        {/* Only for a track that came in through the Slack song-request channel. */}
        {track.queuedBy && <p className="truncate text-label text-text-muted">Queued by <span className={playing ? "text-text" : "text-text-secondary"}>{track.queuedBy}</span></p>}
        {track.durationMs && (
          <ProgressTrack>
            <span key={trackId} ref={fill} className={cx("block h-full origin-left scale-x-0 rounded-full transition-[scale] duration-500 ease-linear", playing ? "bg-accent" : "bg-rule-strong")} />
          </ProgressTrack>
        )}
      </div>
    </section>
  );
}

export function NowPlaying() {
  const { data, jam, anchor } = useNowPlaying();
  const track = playingTrack(data);
  const playing = track?.status === "playing";
  const durationMs = track?.durationMs ?? null;
  const trackId = track ? track.trackId ?? track.title : null;
  const fill = useProgressBar(anchor, durationMs, playing, [data, trackId, jam]);

  if (jam) return jamTile(jam);
  if (!track) {
    return (
      <section className={cx(TILE, "h-28 items-center justify-center")} aria-label="Now playing">
        <p className="text-center text-body text-balance text-text-muted">{unavailableMessage(data)}</p>
      </section>
    );
  }
  return <TrackTile track={track} playing={playing} fill={fill} />;
}
