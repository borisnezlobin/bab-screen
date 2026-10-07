"use client";

import { useEffect, useRef, useState } from "react";
import { Panel, Shard, cx, nameList, relativeAge } from "./ui";

export type Spot = {
  id: string;
  imageUrl: string;
  text: string | null;
  spotter: string | null;
  spotted: string[];
  postedAt: string | null;
  permalink: string | null;
};
type SpotResponse = { status: "ok" | "empty" | "unconfigured" | "error"; spots: Spot[] };

const POLL_MS = 30_000;
/** How long a new spot holds the whole screen. */
export const TAKEOVER_MS = 12_000;
/** How long a photo may take to load before the takeover goes up without it. */
const PHOTO_WAIT_MS = 6_000;
/** A spot stays in the recent list for this long after it was posted. */
export const RECENT_SPOT_MS = 60 * 60_000;
const RECENT_LIMIT = 3;
const FRESH_MS = 10 * 60_000;
const CLOCK_MS = 30_000;

/** The message is worth showing only when it says more than "spot" and the names already in the headline. */
function spotNote(spot: Spot) {
  if (!spot.text) return null;
  let rest = spot.text;
  for (const name of [...spot.spotted].sort((a, b) => b.length - a.length)) rest = rest.split(`@${name}`).join(" ");
  rest = rest.replace(/\bspot(s|ted|ting)?\b/gi, " ");
  return /[^\s.,!?:;'"()@#*_~-]/.test(rest) ? spot.text : null;
}

/** The message with the spotted people's @mentions taken out, since their names are the headline. */
function noteWithoutNames(spot: Spot, note: string) {
  let rest = note;
  for (const name of [...spot.spotted].sort((a, b) => b.length - a.length)) rest = rest.split(`@${name}`).join("");
  return rest.replace(/\s+/g, " ").trim();
}

const LONG_HEADLINE_CHARS = 34;

function spotHeadline(spot: Spot) {
  return spot.spotted.length ? nameList.format(spot.spotted) : spotNote(spot) ?? "Someone";
}

function spotCredit(spot: Spot) {
  return spot.spotter ? `Spotted by ${spot.spotter}` : "Spotted";
}

function postedWithin(spot: Spot, now: number, ms: number) {
  const posted = spot.postedAt ? Date.parse(spot.postedAt) : NaN;
  return Number.isFinite(posted) && now - posted < ms;
}

async function fetchSpots(): Promise<Spot[] | null> {
  try {
    const response = await fetch("/api/spot", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as SpotResponse;
    return Array.isArray(body.spots) ? body.spots : [];
  } catch {
    return null;
  }
}

function preload(url: string) {
  return new Promise<void>((resolve) => {
    const image = new Image();
    const done = () => resolve();
    image.onload = done;
    image.onerror = done;
    window.setTimeout(done, PHOTO_WAIT_MS);
    image.src = url;
  });
}

/**
 * Spotbot's posts, read every 30 seconds. A spot that was not in the previous answer takes over the screen for
 * a few seconds once its photo has loaded; spots from the last hour are listed in `recent`.
 */
export function useSpotAlerts() {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [takeover, setTakeover] = useState<Spot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const list = await fetchSpots();
      if (!alive || !list) return;
      const previous = known.current;
      known.current = new Set(list.map((spot) => spot.id));
      setSpots(list);
      setNow(Date.now());
      const arrival = previous ? list.find((spot) => !previous.has(spot.id)) : undefined;
      if (!arrival) return;
      await preload(arrival.imageUrl);
      if (alive) setTakeover(arrival);
    };
    void poll();
    const pollTimer = window.setInterval(poll, POLL_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => { alive = false; window.clearInterval(pollTimer); window.clearInterval(clockTimer); };
  }, []);

  const takeoverId = takeover?.id ?? null;
  useEffect(() => {
    if (!takeoverId) return;
    const timer = window.setTimeout(() => setTakeover(null), TAKEOVER_MS);
    return () => window.clearTimeout(timer);
  }, [takeoverId]);

  const recent = spots.filter((spot) => spot.id !== takeoverId && postedWithin(spot, now, RECENT_SPOT_MS)).slice(0, RECENT_LIMIT);
  return { takeover, recent, now };
}

function RecentSpot({ spot, now }: { spot: Spot; now: number }) {
  const fresh = postedWithin(spot, now, FRESH_MS);
  return (
    <li className="flex animate-rise-in items-center gap-4">
      <Shard tone={fresh ? "accent" : "muted"} className={cx(fresh && "animate-ember-pulse")} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-narrow text-title font-semibold">{spotHeadline(spot)}</p>
        <p className="flex items-baseline justify-between gap-4 text-body whitespace-nowrap text-text-secondary">
          <span className="min-w-0 truncate">{spotCredit(spot)}</span>
          <span className="shrink-0 text-label text-text-muted">{relativeAge(spot.postedAt, now)}</span>
        </p>
      </div>
    </li>
  );
}

/** Spots from the last hour, newest first, as a short list under the news. Takes no space when there are none. */
export function RecentSpots({ spots, now }: { spots: readonly Spot[]; now: number }) {
  if (!spots.length) return null;
  return (
    <Panel aria-label="Recent spots" className="shrink-0 border-t border-rule pt-5">
      <ol className="flex flex-col gap-4">
        {spots.map((spot) => <RecentSpot key={spot.id} spot={spot} now={now} />)}
      </ol>
    </Panel>
  );
}

const TRIAD = [
  { place: "col-start-2 row-start-1", delay: "0ms", mirrored: false },
  { place: "col-start-1 row-start-2", delay: "120ms", mirrored: true },
  { place: "col-start-3 row-start-2", delay: "240ms", mirrored: false },
] as const;

/** Three shards set like the pieces of the B@B mark; they arrive one after another. */
function Triad() {
  return (
    <div aria-hidden="true" className="grid w-fit grid-cols-3 gap-x-1 gap-y-2">
      {TRIAD.map((piece) => (
        <span key={piece.place} className={cx(piece.place, "flex animate-rise-in")} style={{ animationDelay: piece.delay }}>
          <Shard size="lg" mirrored={piece.mirrored} className="shadow-glow" />
        </span>
      ))}
    </div>
  );
}

/** A new spot, across the whole screen: the photo, who was spotted, and who spotted them. */
export function SpotTakeover({ spot, now }: { spot: Spot | null; now: number }) {
  if (!spot) return null;
  const fullNote = spot.spotted.length ? spotNote(spot) : null;
  const note = fullNote ? noteWithoutNames(spot, fullNote) : null;
  const headline = spotHeadline(spot);
  const age = relativeAge(spot.postedAt, now);
  return (
    <div key={spot.id} role="status" className="absolute inset-0 z-50 flex animate-fade-in items-center gap-20 bg-canvas px-24">
      <div className="h-190 w-260 shrink-0 animate-rise-in overflow-hidden bg-surface-sunk">
        <img src={spot.imageUrl} alt={headline} className="size-full object-cover outline-1 -outline-offset-1 outline-edge" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        <Triad />
        <p className={cx("animate-rise-in font-semibold text-balance wrap-anywhere [animation-delay:200ms]", headline.length > LONG_HEADLINE_CHARS ? "font-narrow text-feature" : "font-narrow text-hero")}>{headline}</p>
        {note && <p className="line-clamp-3 animate-rise-in text-subhead text-text-secondary [animation-delay:300ms]">{note}</p>}
        <p className="flex animate-rise-in items-baseline gap-5 text-subhead [animation-delay:400ms]">
          <span className="font-medium">{spotCredit(spot)}</span>
          {age && <span className="text-title text-text-muted">{age}</span>}
        </p>
      </div>
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1.5 origin-left animate-countdown bg-accent shadow-glow" style={{ animationDuration: `${TAKEOVER_MS}ms` }} />
    </div>
  );
}
