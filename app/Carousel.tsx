"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChumCaption, chumAlt, createChumDeck, useChumPhotos, type ChumDeck, type ChumPhoto } from "./Chum";
import { QuoteCaption, QuoteFrame, useQuoteDeck, type Quote } from "./Quotes";
import { EmptyNote, Panel, cx } from "./ui";

/** How long each slide stays up. */
const SLIDE_MS = 9_000;
/** A slide whose picture is still loading when its turn comes is waited for this long, then passed over. */
const SLIDE_LOAD_GRACE_MS = 6_000;
const SLIDE_READY_POLL_MS = 250;
const PHOTO_RETRY_MS = 5 * 60_000;
const CLOCK_MS = 30_000;
/** Quotes drawn in a row while looking for one that has something to show. */
const QUOTE_DRAWS = 6;
/** A chumming photo follows this many quotes: two or three, at random. */
const chumGap = () => 2 + Math.floor(Math.random() * 2);

type Slide = { kind: "chum"; key: string; id: string } | { kind: "quote"; key: string; quote: Quote };
/** `upcoming` is chosen a turn ahead and mounted hidden so its picture loads first; `previous` stays to fade out. */
type Show = { previous: Slide | null; current: Slide | null; upcoming: Slide | null };

const chumKey = (id: string) => `chum:${id}`;
const chumSlide = (id: string): Slide => ({ kind: "chum", key: chumKey(id), id });
const quoteSlide = (quote: Quote): Slide => ({ kind: "quote", key: `quote:${quote.id}`, quote });

function slideReady(frame: HTMLElement | null, slide: Slide) {
  const layer = frame?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(slide.key)}"]`);
  if (!layer) return false;
  const image = layer instanceof HTMLImageElement ? layer : layer.querySelector("img");
  return !image || (image.complete && image.naturalWidth > 0);
}

function quotesOnShow(show: Show) {
  const quotes: Array<Extract<Slide, { kind: "quote" }>> = [];
  for (const slide of [show.previous, show.current, show.upcoming]) {
    if (slide?.kind === "quote" && !quotes.some((q) => q.key === slide.key)) quotes.push(slide);
  }
  return quotes;
}

/** Photos that fail to load drop out of the rotation and are retried every few minutes. */
function useFailedPhotos() {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [retry, setRetry] = useState(0);
  const anyFailed = failed.size > 0;
  useEffect(() => {
    if (!anyFailed) return;
    const timer = window.setInterval(() => setRetry((n) => n + 1), PHOTO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [anyFailed]);
  const mark = useCallback((key: string, bad: boolean) => setFailed((previous) => {
    if (previous.has(key) === bad) return previous;
    const next = new Set(previous);
    if (bad) next.add(key); else next.delete(key);
    return next;
  }), []);
  return { failed, retry, mark };
}

function useTicker(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** Decides what follows a slide: quotes from the deck, with a chumming photo slipped in every two or three. */
function usePicker(nextQuote: () => Quote | null, failed: ReadonlySet<string>, hasQuotes: boolean) {
  const chumDeck = useRef<ChumDeck | null>(null);
  if (chumDeck.current === null) chumDeck.current = createChumDeck();
  const untilChum = useRef(-1);
  if (untilChum.current < 0) untilChum.current = chumGap();
  const pool = useRef({ failed, hasQuotes });
  pool.current = { failed, hasQuotes };

  const pick = useCallback((after: Slide | null): Slide | null => {
    const { failed: bad, hasQuotes: quotes } = pool.current;
    const quoteAfter = (): Slide | null => {
      for (let draw = 0; quotes && draw < QUOTE_DRAWS; draw += 1) {
        const quote = nextQuote();
        if (!quote || (after?.kind === "quote" && after.quote.id === quote.id)) return null;
        if (quote.imageUrl || quote.text) return quoteSlide(quote);
      }
      return null;
    };
    const chumAfter = (): Slide | null => {
      const id = chumDeck.current?.next((photo) => !bad.has(chumKey(photo)), after?.kind === "chum" ? after.id : null);
      if (!id) return null;
      untilChum.current = chumGap();
      return chumSlide(id);
    };
    if (after?.kind !== "chum" && untilChum.current <= 0) {
      const due = chumAfter();
      if (due) return due;
    }
    const quote = quoteAfter();
    if (!quote) return chumAfter();
    untilChum.current = Math.max(0, untilChum.current - 1);
    return quote;
  }, [nextQuote]);

  return { pick, chumDeck };
}

const EMPTY_NOTES: Partial<Record<string, string>> = {
  loading: "",
  unconfigured: "Connect Slack to show quotes and chumming photos",
  error: "Slack can't be read right now",
};

function emptyCarouselNote(status: string) {
  return EMPTY_NOTES[status] ?? "No quotes or chumming photos yet";
}

/** Quotes and chumming photos from Slack, one at a time, crossfading every few seconds. */
export function Carousel() {
  const chum = useChumPhotos();
  const deck = useQuoteDeck();
  const hasQuotes = deck.count > 0;
  const { failed, retry, mark } = useFailedPhotos();
  const { pick, chumDeck } = usePicker(deck.next, failed, hasQuotes);
  const now = useTicker(CLOCK_MS);
  const [show, setShow] = useState<Show>({ previous: null, current: null, upcoming: null });
  const showRef = useRef(show);
  const shownAt = useRef(0);
  const frame = useRef<HTMLDivElement>(null);
  const [rearm, setRearm] = useState(0);

  const liveChum = chum.filter((photo) => !failed.has(chumKey(photo.id)));
  const chumIdsKey = chum.map((photo) => photo.id).join(",");
  const chumLiveKey = liveChum.map((photo) => photo.id).join(",");

  const commit = useCallback((next: Show) => {
    showRef.current = next;
    setShow(next);
  }, []);

  const putUp = useCallback((slide: Slide | null, previous: Slide | null) => {
    shownAt.current = performance.now();
    commit({ previous, current: slide, upcoming: slide ? pick(slide) : null });
  }, [commit, pick]);

  useEffect(() => {
    chumDeck.current?.sync(chumIdsKey ? chumIdsKey.split(",") : []);
  }, [chumIdsKey, chumDeck]);

  // Keep the show true to what there is: a slide whose photo left or failed, or a quote once there are none, is replaced.
  useEffect(() => {
    const live = new Set(chumLiveKey ? chumLiveKey.split(",") : []);
    const usable = (slide: Slide | null) => slide !== null && (slide.kind === "chum" ? live.has(slide.id) : hasQuotes);
    const { current, upcoming } = showRef.current;
    if (!usable(current)) {
      const first = usable(upcoming) ? upcoming : pick(null);
      if (first || current) putUp(first, null);
      return;
    }
    if (usable(upcoming)) return;
    const next = pick(current);
    if (next?.key !== upcoming?.key) commit({ ...showRef.current, upcoming: next });
  }, [chumLiveKey, hasQuotes, show, pick, putUp, commit]);

  const currentKey = show.current?.key ?? null;
  const upcomingKey = show.upcoming?.key ?? null;
  useEffect(() => {
    if (!currentKey || !upcomingKey) return;
    let timer: number | undefined;
    const turn = () => {
      const { current, upcoming } = showRef.current;
      if (!upcoming) return;
      if (slideReady(frame.current, upcoming)) return putUp(upcoming, current);
      if (performance.now() - shownAt.current < SLIDE_MS + SLIDE_LOAD_GRACE_MS) {
        timer = window.setTimeout(turn, SLIDE_READY_POLL_MS);
        return;
      }
      shownAt.current = performance.now();
      commit({ ...showRef.current, upcoming: pick(current) });
      setRearm((n) => n + 1);
    };
    timer = window.setTimeout(turn, Math.max(0, shownAt.current + SLIDE_MS - performance.now()));
    return () => window.clearTimeout(timer);
  }, [currentKey, upcomingKey, rearm, putUp, pick, commit]);

  // A quote whose picture will not load is shown as its words; with no words either, it gives up its turn.
  const quoteImageFailed = useCallback((quote: Quote) => {
    const wordsOnly = (slide: Slide | null): Slide | null => {
      if (slide?.kind !== "quote" || slide.quote.id !== quote.id) return slide;
      return quote.text ? { ...slide, quote: { ...slide.quote, imageUrl: null, imageKind: null } } : null;
    };
    const { previous, current, upcoming } = showRef.current;
    const next = { previous: wordsOnly(previous), current: wordsOnly(current), upcoming: wordsOnly(upcoming) };
    if (current && !next.current) {
      shownAt.current = performance.now();
      commit({ previous: null, current: next.upcoming, upcoming: null });
      return;
    }
    commit(next);
  }, [commit]);

  if (!chum.length && !hasQuotes) {
    return <Panel className="flex-1"><EmptyNote>{emptyCarouselNote(deck.status)}</EmptyNote></Panel>;
  }

  const quotes = quotesOnShow(show);
  return (
    <Panel className="flex flex-1 flex-col">
      <div ref={frame} className="relative min-h-0 flex-1 bg-surface-sunk">
        {chum.map((photo) => (
          <ChumImage key={failed.has(chumKey(photo.id)) ? `${photo.id}:${retry}` : photo.id} photo={photo} active={chumKey(photo.id) === currentKey} onLoad={mark} />
        ))}
        {quotes.map((slide) => (
          <Layer key={slide.key} slideKey={slide.key} active={slide.key === currentKey}>
            <QuoteFrame quote={slide.quote} onImageError={quoteImageFailed} />
          </Layer>
        ))}
      </div>
      <div className="grid min-h-34 pt-4 [&>*]:col-start-1 [&>*]:row-start-1">
        {liveChum.map((photo) => (
          <CaptionLayer key={photo.id} active={chumKey(photo.id) === currentKey}><ChumCaption photo={photo} now={now} /></CaptionLayer>
        ))}
        {quotes.map((slide) => (
          <CaptionLayer key={slide.key} active={slide.key === currentKey}><QuoteCaption quote={slide.quote} now={now} /></CaptionLayer>
        ))}
      </div>
    </Panel>
  );
}

const FADE = "transition-opacity duration-700 ease-out-soft";

function ChumImage({ photo, active, onLoad }: { photo: ChumPhoto; active: boolean; onLoad: (key: string, bad: boolean) => void }) {
  const key = chumKey(photo.id);
  return (
    <img
      data-slide={key}
      src={photo.imageUrl}
      alt={chumAlt(photo)}
      aria-hidden={!active}
      className={cx("absolute inset-0 size-full object-cover", FADE, active ? "opacity-100" : "opacity-0")}
      onLoad={() => onLoad(key, false)}
      onError={() => onLoad(key, true)}
    />
  );
}

function Layer({ slideKey, active, children }: { slideKey: string; active: boolean; children: React.ReactNode }) {
  return <div data-slide={slideKey} aria-hidden={!active} className={cx("absolute inset-0", FADE, active ? "opacity-100" : "opacity-0")}>{children}</div>;
}

function CaptionLayer({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div aria-hidden={!active} className={cx("self-end", FADE, active ? "opacity-100" : "invisible opacity-0")}>{children}</div>;
}
