"use client";

// Quotes from the club's Slack channel (/api/quotes, lib/quotes.ts) as slides for the photo carousel.
// Nothing here rotates or fades on its own: the carousel (app/Carousel.tsx) owns the clock and
// the crossfade, asks useQuoteDeck() for the next quote, and puts <QuoteFrame> where a photo goes
// and <QuoteCaption> where a photo's caption goes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Quote, QuotesResponse } from "../lib/quotes";
import { cx, relativeAge } from "./ui";

export type { Quote, QuotesResponse } from "../lib/quotes";

// --- The deck: which quote comes next ----------------------------------------------------------

export type QuoteDeck = {
  /** Replaces the batch. Quotes shown most recently go to the back of the new order. */
  load(quotes: Quote[]): void;
  /** The next quote, or null when there are none. Goes through the whole batch before any repeats. */
  next(): Quote | null;
  /** What next() will return, without taking it: for loading its picture ahead of time. */
  peek(): Quote | null;
  /** How many quotes are in the batch. */
  size(): number;
  /** How many are left before the batch starts again. */
  remaining(): number;
};

const RECENT_LIMIT = 200;

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

/** Random order, every quote once before any comes back, and never the same one twice in a row. */
export function createQuoteDeck(random: () => number = Math.random): QuoteDeck {
  let batch: Quote[] = [];
  let queue: Quote[] = [];
  /** Ids already shown, oldest first. */
  let recent: string[] = [];

  const refill = () => {
    queue = shuffled(batch, random);
    const last = recent[recent.length - 1];
    if (queue.length > 1 && queue[0].id === last) {
      const swap = 1 + Math.floor(random() * (queue.length - 1));
      [queue[0], queue[swap]] = [queue[swap], queue[0]];
    }
  };

  return {
    load(quotes) {
      const seen = new Set<string>();
      batch = quotes.filter((quote) => !seen.has(quote.id) && Boolean(seen.add(quote.id)));
      // Unseen quotes first; then the seen ones, the longest-ago first. The last one shown ends up last.
      const fresh = shuffled(batch.filter((quote) => !recent.includes(quote.id)), random);
      const again = batch.filter((quote) => recent.includes(quote.id)).sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));
      queue = [...fresh, ...again];
    },
    next() {
      if (queue.length === 0) refill();
      const quote = queue.shift() ?? null;
      if (quote) recent = [...recent.filter((id) => id !== quote.id), quote.id].slice(-RECENT_LIMIT);
      return quote;
    },
    peek() {
      if (queue.length === 0) refill();
      return queue[0] ?? null;
    },
    size: () => batch.length,
    remaining: () => queue.length,
  };
}

export type QuoteDeckOptions = {
  /** Quotes per request, 1 to 100. */
  batch?: number;
  /** A new sample is fetched this often, and whenever the batch has been shown through. */
  refreshMs?: number;
  /** While there is nothing to show (Slack not connected, still loading), ask again this often. */
  retryMs?: number;
  endpoint?: string;
};

export type QuoteDeckState = {
  /** "loading" until the first answer; then the API's status. */
  status: QuotesResponse["status"];
  /** How many quotes the current batch holds. 0 means next() returns null: leave quotes out. */
  count: number;
  /** Takes the next quote. Not for calling while rendering: call it from an effect, a timer or an event. */
  next: () => Quote | null;
  /** The quote next() will return, without taking it. */
  peek: () => Quote | null;
};

const MIN_REFETCH_GAP_MS = 60_000;

/**
 * Fetches quotes from /api/quotes and hands them out one at a time, in random order, with no repeat
 * until the whole batch has been shown. `next` and `peek` keep the same identity for the life of
 * the component.
 */
export function useQuoteDeck({ batch = 40, refreshMs = 30 * 60_000, retryMs = 60_000, endpoint = "/api/quotes" }: QuoteDeckOptions = {}): QuoteDeckState {
  const deck = useRef<QuoteDeck | null>(null);
  if (deck.current === null) deck.current = createQuoteDeck();
  const [status, setStatus] = useState<QuotesResponse["status"]>("loading");
  const [count, setCount] = useState(0);
  const load = useRef<() => void>(() => {});
  const lastFetchAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let timer: number | undefined;

    const run = async () => {
      if (busy) return;
      busy = true;
      window.clearTimeout(timer);
      lastFetchAt.current = Date.now();
      let wait = retryMs;
      try {
        const response = await fetch(`${endpoint}?count=${batch}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Quotes request failed");
        const data = (await response.json()) as QuotesResponse;
        if (cancelled) return;
        const quotes = Array.isArray(data.quotes) ? data.quotes : [];
        // An answer without quotes is the server saying there are none to show (the bot lost the
        // channel, say), so whatever was on screen goes too.
        deck.current?.load(quotes);
        setCount(quotes.length);
        setStatus(data.status);
        if (quotes.length > 0) wait = refreshMs;
      } catch {
        // The server could not be reached: keep showing the last batch and ask again soon.
      } finally {
        busy = false;
        if (!cancelled) timer = window.setTimeout(run, wait);
      }
    };

    load.current = () => void run();
    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      load.current = () => {};
    };
  }, [batch, endpoint, refreshMs, retryMs]);

  const next = useCallback(() => {
    const quote = deck.current?.next() ?? null;
    // The batch has been shown through: ask for a fresh sample. Until it arrives, the same batch is reshuffled.
    if (quote && deck.current?.remaining() === 0 && Date.now() - lastFetchAt.current > MIN_REFETCH_GAP_MS) load.current();
    return quote;
  }, []);
  const peek = useCallback(() => deck.current?.peek() ?? null, []);

  return { status, count, next, peek };
}

// --- The slide ---------------------------------------------------------------------------------

/** "photo": the picture fills the frame and the words go in the caption. "text": the words are the frame. */
export function quoteSlideKind(quote: Quote): "photo" | "text" {
  return quote.imageUrl ? "photo" : "text";
}

/** "3d ago" like a spot; a quote from another year shows its month and year. */
export const quoteAge = relativeAge;

/** The words in the frame are set as large as fits, between these sizes (px on the 1920x1080 stage). */
const FRAME_TEXT_MIN_PX = 32;
const FRAME_TEXT_MAX_PX = 112;

/**
 * Sets the element's font size to the largest at which the text fits its box without breaking a
 * word, and again whenever the box changes size (the frame shrinks while the Jam QR is up). Text
 * that does not fit even at the smallest size is cut with an ellipsis at the last line that fits.
 */
function useFitText(text: string, min: number, max: number) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const element = textRef.current;
    if (!box || !element) return;
    let alive = true;

    const fit = () => {
      if (!alive) return;
      const padding = getComputedStyle(box);
      const height = box.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
      if (height <= 0 || element.clientWidth <= 0) return;
      // Measured unclamped and with words kept whole, so a size at which a long word would be split counts as too big.
      element.style.setProperty("-webkit-line-clamp", "unset");
      element.style.overflowWrap = "normal";
      const fits = (px: number) => {
        element.style.fontSize = `${px}px`;
        return element.scrollHeight <= height && element.scrollWidth <= element.clientWidth;
      };
      let size = min;
      if (fits(min)) {
        let low = min;
        let high = max;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(middle)) low = middle;
          else high = middle - 1;
        }
        size = low;
        element.style.fontSize = `${size}px`;
        element.style.removeProperty("-webkit-line-clamp");
      } else {
        element.style.fontSize = `${min}px`;
        const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || min * 1.1;
        element.style.setProperty("-webkit-line-clamp", String(Math.max(1, Math.floor(height / lineHeight))));
      }
      element.style.removeProperty("overflow-wrap");
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    // The first fit may have been measured in the fallback face.
    void document.fonts?.ready.then(fit);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [text, min, max]);

  return { boxRef, textRef };
}

/** Browsers even out the lines of short text only (Chrome: six lines); past that, a short last line is what to avoid. */
const BALANCE_MAX_CHARS = 110;

/** A conversation comes as one line per speaker; each is its own block, so a turn that wraps hangs under itself. */
function Words({ text }: { text: string }) {
  if (!text.includes("\n")) return <>{text}</>;
  return (
    <>
      {text.split("\n").map((line, index) => (
        <span key={index} className="block pl-[0.7em] -indent-[0.7em]">{line}</span>
      ))}
    </>
  );
}

function FrameText({ text }: { text: string }) {
  const { boxRef, textRef } = useFitText(text, FRAME_TEXT_MIN_PX, FRAME_TEXT_MAX_PX);
  return (
    <div ref={boxRef} className="flex size-full flex-col justify-end p-8">
      <p ref={textRef} className={cx("line-clamp-6 w-full shrink-0 pb-1 font-narrow text-subhead leading-fit font-semibold wrap-anywhere", text.length > BALANCE_MAX_CHARS ? "text-pretty" : "text-balance")}><Words text={text} /></p>
    </div>
  );
}

export type QuoteFrameProps = {
  quote: Quote;
  /** Added to the root, e.g. the carousel's layer class and its "is-active". */
  className?: string;
  style?: CSSProperties;
  /** The picture could not be loaded. A quote with words falls back to them; one without has nothing to show. */
  onImageError?: (quote: Quote) => void;
};

/**
 * What goes in the carousel's image frame for one quote. It covers its positioned parent
 * (position: absolute; inset: 0), exactly like a chumming photo.
 *
 * With a picture: the picture, shown whole (contain) on the frame's dark ground, never cropped.
 * Without one: the words, as large as fits.
 */
export function QuoteFrame({ quote, className, style, onImageError }: QuoteFrameProps) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const imageUrl = quote.imageUrl && quote.imageUrl !== brokenUrl ? quote.imageUrl : null;

  return (
    <div className={cx("absolute inset-0 overflow-hidden bg-surface-sunk", className)} style={style}>
      {imageUrl ? (
        <img
          className="block size-full object-contain"
          src={imageUrl}
          alt={quote.text ?? (quote.who ? `Quote from ${quote.who}` : "Quote posted in Slack")}
          draggable={false}
          onError={() => {
            setBrokenUrl(imageUrl);
            onImageError?.(quote);
          }}
        />
      ) : quote.text ? (
        <FrameText text={quote.text} />
      ) : null}
    </div>
  );
}

/** The quote under its picture, largest first: one line at 48px, two at 36px, three at 28px. */
const CAPTION_STEPS = [
  "line-clamp-1 text-headline",
  "line-clamp-2 text-subhead",
  "line-clamp-3 text-title",
] as const;
const CAPTION_QUOTE = "font-narrow font-semibold text-balance wrap-anywhere";

export type QuoteCaptionProps = {
  quote: Quote;
  /** Epoch ms the age is counted from; the carousel's ticking clock. Defaults to the time of rendering. */
  now?: number;
};

/** A first guess from the length, so the first paint is close; the layout effect settles it by measuring. */
function firstCaptionStep(words: string | null) {
  if (!words) return 0;
  if (words.includes("\n") || words.length > 60) return 2;
  return words.length > 22 ? 1 : 0;
}

/** Sets the quote at the largest caption step at which it fits whole. */
function useCaptionFit(words: string | null) {
  const quoteRef = useRef<HTMLParagraphElement>(null);
  const firstStep = words?.includes("\n") ? 2 : 0;
  useLayoutEffect(() => {
    const element = quoteRef.current;
    if (!element) return;
    let alive = true;
    const fit = () => {
      if (!alive) return;
      for (let step = firstStep; step < CAPTION_STEPS.length; step += 1) {
        element.className = cx(CAPTION_QUOTE, CAPTION_STEPS[step], "line-clamp-none");
        const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
        if (element.offsetHeight <= (step + 1) * lineHeight + 1 || step === CAPTION_STEPS.length - 1) {
          element.className = cx(CAPTION_QUOTE, CAPTION_STEPS[step]);
          break;
        }
      }
    };
    fit();
    void document.fonts?.ready.then(fit);
    return () => {
      alive = false;
    };
  }, [words, firstStep]);
  return quoteRef;
}

function QuoteCredit({ quote, words }: { quote: Quote; words: string | null }) {
  const saidBy = words ? quote.who : null;
  if (saidBy && quote.poster) return <><span className="font-semibold text-text">{saidBy}</span>, quoted by {quote.poster}</>;
  if (saidBy) return <span className="font-semibold text-text">{saidBy}</span>;
  return quote.poster ? <>Quoted by {quote.poster}</> : null;
}

/**
 * What goes under the frame for one quote. Under a picture the headline is the quote itself, at the largest of
 * three sizes at which it fits whole, and who said it leads the last line. Under a frame of words the headline is
 * who said it. When the message names nobody, nobody is credited with saying it: only "Quoted by", the poster.
 */
export function QuoteCaption({ quote, now }: QuoteCaptionProps) {
  const words = quoteSlideKind(quote) === "photo" ? quote.text : null;
  const whoAsHeadline = !words && quote.who;
  const age = quoteAge(quote.postedAt, now);
  const quoteRef = useCaptionFit(words);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {words && <p ref={quoteRef} className={cx(CAPTION_QUOTE, CAPTION_STEPS[firstCaptionStep(words)])}><Words text={words} /></p>}
      {whoAsHeadline && <p className="line-clamp-1 font-narrow text-headline font-semibold">{quote.who}</p>}
      <CaptionMeta age={age}><QuoteCredit quote={quote} words={words} /></CaptionMeta>
    </div>
  );
}

/** The last line of every carousel caption: who to credit on the left, how long ago on the right. */
export function CaptionMeta({ age, children }: { age: string | null; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-body whitespace-nowrap text-text-secondary">
      <span className="min-w-0 truncate">{children}</span>
      {age && <span className="shrink-0 text-label text-text-muted">{age}</span>}
    </div>
  );
}
