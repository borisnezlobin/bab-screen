"use client";

// Photos from the club's "chumming" Slack channel (/api/chum, lib/chum.ts) as slides for the photo
// carousel. Like app/Quotes.tsx, nothing here rotates on its own: the carousel in app/Carousel.tsx owns
// the clock, asks the deck which photo comes next, and puts <ChumCaption> under the photo.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChumPhoto, ChumResult } from "../lib/chum";
import { CaptionMeta, quoteAge } from "./Quotes";
import { cx, nameList } from "./ui";

export type { ChumPhoto, ChumResult } from "../lib/chum";

const CHUM_POLL_MS = 30_000;

/**
 * The newest chumming photos, asked for every 30 seconds (the server reads Slack at most once a
 * minute). Empty until the first answer, and whenever the channel is not configured or has no
 * photos. An answer that says Slack could not be read, or no answer at all, keeps the last list.
 */
export function useChumPhotos(endpoint = "/api/chum"): ChumPhoto[] {
  const [photos, setPhotos] = useState<ChumPhoto[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(endpoint, { cache: "no-store" });
        if (!response.ok) throw new Error("Chum request failed");
        const data = (await response.json()) as ChumResult;
        if (cancelled || data.status === "error" || !Array.isArray(data.photos)) return;
        setPhotos(data.photos);
      } catch {
        // Keep showing the last good list; the next poll tries again.
      }
    };
    void load();
    const timer = window.setInterval(load, CHUM_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [endpoint]);

  return photos;
}

// --- The deck: which photo comes next ----------------------------------------------------------

export type ChumDeck = {
  /** The photos there are now. Ones that were not in the last list go to the front of the order. */
  sync(ids: readonly string[]): void;
  /**
   * Takes the next photo: random order, every usable photo once before any comes back, and never
   * the one drawn last while there is another. `avoid` (the photo on screen) is never returned.
   * Null when there is nothing to return.
   */
  next(usable: (id: string) => boolean, avoid?: string | null): string | null;
  /** Hands back a photo that was taken but never shown, so it is the next one drawn. */
  putBack(id: string): void;
};

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1));
    [copy[index], copy[pick]] = [copy[pick], copy[index]];
  }
  return copy;
}

export function createChumDeck(random: () => number = Math.random): ChumDeck {
  let ids: string[] = [];
  /** What is left of the current pass, in the order it will be drawn. */
  let queue: string[] = [];
  let last: string | null = null;
  let beforeLast: string | null = null;

  const take = (usable: (id: string) => boolean, avoid: string | null, allowLast: boolean) => {
    const at = queue.findIndex((id) => usable(id) && id !== avoid && (allowLast || id !== last));
    if (at === -1) return null;
    const [id] = queue.splice(at, 1);
    beforeLast = last;
    last = id;
    return id;
  };

  return {
    sync(next) {
      const fresh = next.filter((id) => !ids.includes(id));
      ids = [...new Set(next)];
      queue = [...shuffled(fresh, random), ...queue.filter((id) => ids.includes(id))];
    },
    next(usable, avoid = null) {
      const id = take(usable, avoid, false);
      if (id) return id;
      // The pass is over (what is left of it cannot be shown): start another.
      queue = shuffled(ids, random);
      return take(usable, avoid, false) ?? take(usable, avoid, true);
    },
    putBack(id) {
      if (!ids.includes(id) || queue.includes(id)) return;
      queue.unshift(id);
      if (last === id) last = beforeLast;
    },
  };
}

// --- The caption -------------------------------------------------------------------------------

/**
 * The message is worth a line of its own only when it says more than who was there: "tane w/ @Name"
 * does, "@Name @Name", "chum @Name" and "chumming with @Name" do not.
 */
export function chumNote(photo: ChumPhoto): string | null {
  if (!photo.text) return null;
  let rest = photo.text;
  for (const name of [...photo.chums].sort((a, b) => b.length - a.length)) rest = rest.split(`@${name}`).join(" ");
  rest = rest.replace(/w\/|\b(chum(s|my|med|ming)?|with|and|ft|feat)\b/gi, " ");
  return /[\p{L}\p{N}]/u.test(rest) ? photo.text : null;
}

/** Whose photo it is, for the alt text. */
export function chumAlt(photo: ChumPhoto): string {
  const people = [photo.poster, ...photo.chums].filter((name): name is string => Boolean(name));
  return people.length ? `${nameList.format(people)} chumming` : photo.text ?? "Chumming photo";
}

/** One way of setting the headline: at 48px or 36px, on so many lines, with or without the note under it. */
type Headline = { text: string; small: boolean; lines: 1 | 2; note: boolean };

/**
 * What goes under a chumming photo, in the same block as a spot's caption and never taller than a
 * spot's (name, one line of text, credit line: 127px).
 *
 * In the channel a post is "me, hanging out with these people": the poster names their chums
 * ("chum @A", "donuts w/ @A @B", "chumming with @A") and is never among the names. So the headline
 * is the chums the poster named and the last line says "Chumming with" the poster. When nobody is
 * named, the headline is what the poster wrote ("b@by group hang") over the same last line; with
 * no words either, the poster is the only chum known and is the headline, over a plain "Chumming".
 *
 * The headline keeps to one line at 48px. If it does not fit, it is set at 36px, on one line over
 * the note or else on two lines without it: the names matter more than the note. Names that still
 * do not fit are shortened to "A, B, and 2 others", and words are cut with an ellipsis.
 */
export function ChumCaption({ photo, now }: { photo: ChumPhoto; now?: number }) {
  const note = chumNote(photo);
  const named = photo.chums.length > 0;
  // With nobody named, the note is the headline; with no note either, the poster is.
  const posterIsHeadline = !named && !note && Boolean(photo.poster);
  const names = named ? photo.chums : posterIsHeadline && photo.poster ? [photo.poster] : [];
  const namesKey = names.join("\n");
  const noteLine = named ? note : null;
  const credit = photo.poster && !posterIsHeadline ? `Chumming with ${photo.poster}` : "Chumming";
  const age = quoteAge(photo.postedAt, now);
  const hasNoteLine = Boolean(noteLine);

  // Largest and most complete first; the first that fits is used.
  const candidates = useMemo<Headline[]>(() => {
    const people = namesKey ? namesKey.split("\n") : [];
    if (people.length === 0) {
      const text = note ?? "Chums";
      return [{ text, small: false, lines: 1, note: false }, { text, small: true, lines: 2, note: false }];
    }
    const full = nameList.format(people);
    const list: Headline[] = [{ text: full, small: false, lines: 1, note: hasNoteLine }];
    if (hasNoteLine) list.push({ text: full, small: true, lines: 1, note: true });
    list.push({ text: full, small: true, lines: 2, note: false });
    for (let kept = people.length - 1; kept >= 1; kept -= 1) {
      const others = people.length - kept;
      list.push({ text: nameList.format([...people.slice(0, kept), others === 1 ? "1 other" : `${others} others`]), small: true, lines: 2, note: false });
    }
    return list;
  }, [namesKey, note, hasNoteLine]);

  const [choice, setChoice] = useState(0);
  const headlineRef = useRef<HTMLParagraphElement>(null);
  const className = (headline: Headline) => cx("font-narrow font-semibold wrap-anywhere", headline.small ? "text-subhead" : "text-headline", headline.lines === 2 ? "line-clamp-2" : "line-clamp-1");
  const shown = candidates[Math.min(choice, candidates.length - 1)];

  useLayoutEffect(() => {
    const element = headlineRef.current;
    if (!element) return;
    let alive = true;
    const fit = () => {
      if (!alive) return;
      // Measured unclamped: the height is then a whole number of lines.
      element.style.setProperty("-webkit-line-clamp", "unset");
      element.style.display = "block";
      let chosen = candidates.length - 1;
      for (let index = 0; index < candidates.length; index += 1) {
        const headline = candidates[index];
        element.className = className(headline);
        element.textContent = headline.text;
        const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
        if (element.offsetHeight <= headline.lines * lineHeight + 1) {
          chosen = index;
          break;
        }
      }
      element.style.removeProperty("-webkit-line-clamp");
      element.style.removeProperty("display");
      // The element is left showing the chosen headline, which is what the next render asks for too.
      element.className = className(candidates[chosen]);
      element.textContent = candidates[chosen].text;
      setChoice(chosen);
    };
    fit();
    // The first fit may have been measured in the fallback face.
    void document.fonts?.ready.then(fit);
    return () => {
      alive = false;
    };
  }, [candidates]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p ref={headlineRef} className={className(shown)}>{shown.text}</p>
      {noteLine && shown.note && <p className="truncate text-body text-text-secondary">{noteLine}</p>}
      <CaptionMeta age={age}>{credit}</CaptionMeta>
    </div>
  );
}
