// Labels for the feed ("Breaking", "Release", ...) and a second check for adverts, from Cloudflare's Clef-flash
// decision model running on this Mac (scripts/clef/server.py). Clef answers typed questions about a text with a
// probability for every allowed answer, so a label is shown only when the model is sure of it. The request and
// response are the Jev / SystemOne shapes, so CLEF_URL could equally point at another SystemOne server.
// If the server is not running, items go out unlabelled and nothing else changes.

import { FEED_LABELS, type FeedItem, type FeedLabel } from "./feed-types";

const CLEF_URL = (process.env.CLEF_URL?.trim() || "http://127.0.0.1:7710").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 30_000;
/** The most likely label is shown only at this probability or above. */
const MIN_LABEL_CONFIDENCE = 0.55;
/** An item the model is this sure is a publisher promoting itself is taken off the screen. */
const MIN_PROMOTION = 0.85;
const CACHE_LIMIT = 500;

type Labeling = { label: FeedLabel | null; promotion: number };
type ChoiceAnswer = { type: "choice"; choice: string; confidence: number };
type NoulAnswer = { type: "noul"; noul: number };

const KIND_CRITERIA: Record<FeedLabel | "other", string> = {
  breaking: "A fast-moving event from the last few hours that is still developing: a hack or exploit, an outage, an arrest, a court ruling, an emergency.",
  release: "Something new that people can use now: a model, a product, a feature, an upgrade or a version that has shipped.",
  announcement: "An organization announcing a plan, a partnership, funding, a hire, a policy or a decision, with nothing to use yet.",
  research: "A paper, a study, a benchmark, a dataset or a technical deep dive.",
  event: "A conference, talk, hackathon, meetup or application deadline that people can attend or join.",
  other: "Anything else: analysis, opinion, commentary, market moves, interviews, profiles.",
};

const QUESTIONS = {
  kind: { type: "choice", instructions: "What kind of news item is this?", criteria: KIND_CRITERIA },
  promotion: {
    type: "noul",
    instructions: "Is this the publisher advertising itself: selling tickets, passes, subscriptions or sponsorships, or promoting its own event, rather than reporting news?",
  },
} as const;

const cache = new Map<string, Labeling>();

function remember(id: string, labeling: Labeling) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(id, labeling);
}

function stateFor(item: FeedItem) {
  return [`${item.source}: ${item.title}`, item.summary].filter(Boolean).join("\n");
}

function readLabeling(answers: Record<string, unknown>): Labeling {
  const kind = answers.kind as ChoiceAnswer | undefined;
  const promotion = answers.promotion as NoulAnswer | undefined;
  const choice = kind?.choice as FeedLabel | "other" | undefined;
  const confident = typeof kind?.confidence === "number" && kind.confidence >= MIN_LABEL_CONFIDENCE;
  const label = confident && choice && (FEED_LABELS as readonly string[]).includes(choice) ? (choice as FeedLabel) : null;
  return { label, promotion: typeof promotion?.noul === "number" ? promotion.noul : 0 };
}

async function classify(item: FeedItem): Promise<Labeling> {
  const response = await fetch(`${CLEF_URL}/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "clef-flash", state: stateFor(item), questions: QUESTIONS }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Clef: HTTP ${response.status}`);
  const body = (await response.json()) as { answers?: Record<string, unknown> };
  return readLabeling(body.answers ?? {});
}

/** Labels from the cache, or from Clef for the ones not seen yet. Stops asking at the first failure. */
async function labelingsFor(items: FeedItem[]): Promise<Map<string, Labeling>> {
  const found = new Map<string, Labeling>();
  for (const item of items) {
    const known = cache.get(item.id);
    if (known) { found.set(item.id, known); continue; }
    try {
      const labeling = await classify(item);
      remember(item.id, labeling);
      found.set(item.id, labeling);
    } catch {
      break;
    }
  }
  return found;
}

/**
 * The items with their labels set, and without any the model is confident are adverts. Unchanged when
 * FEED_LABELS=off or the Clef server cannot be reached.
 */
export async function labelItems(items: FeedItem[]): Promise<FeedItem[]> {
  if (process.env.FEED_LABELS?.trim().toLowerCase() === "off") return items;
  const labelings = await labelingsFor(items);
  return items
    .filter((item) => (labelings.get(item.id)?.promotion ?? 0) < MIN_PROMOTION)
    .map((item) => {
      const label = labelings.get(item.id)?.label;
      return label ? { ...item, label } : item;
    });
}
