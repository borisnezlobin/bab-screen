// Market definitions and price-source helpers shared by app/Markets.tsx.
//
// Two lists share the tape and the featured slot: the set tokens below, which are always on, and the newsworthy
// tokens that /api/newsworthy hands the page at runtime (lib/newsworthy.ts). Prices are read in the browser, no
// key needed, from one of two venues: Hyperliquid's perpetual market for the token (WebSocket, with REST as
// the backstop), or, for a token Hyperliquid does not list, Gate's spot market against USDT (REST, polled).
// The featured chart draws the same market's candles (lib/candles.ts).

export type Venue = "hyperliquid" | "gate";

export type Asset = {
  /** Symbol shown on screen. */
  symbol: string;
  name: string;
  venue: Venue;
  /** The market's id at its venue: a Hyperliquid coin ("BTC", "kPEPE") or a Gate currency pair ("RAIN_USDT"). */
  market: string;
  /** Unique key on this page for quotes, charts and the rotation. A Hyperliquid coin id is its own key. */
  coin: string;
  /**
   * Tokens per contract. Hyperliquid quotes its "k" markets (kSHIB, kPEPE, kBONK) per 1,000 tokens;
   * prices and candles are divided by this as they are read, so everything on screen is per token.
   */
  lot: number;
};

const HL_COIN = /^[A-Za-z0-9]{1,12}$/;
const GATE_PAIR = /^[A-Z0-9]{1,12}_USDT$/;

/** A market as the page tracks it, or null if the venue's id is not one this page knows how to read. */
export function makeAsset(venue: Venue, market: string, symbol: string, name: string, lot = 1): Asset | null {
  if (!Number.isFinite(lot) || lot < 1) return null;
  if (venue === "hyperliquid") {
    if (!HL_COIN.test(market)) return null;
    return { symbol, name, venue, market, coin: market, lot };
  }
  if (venue !== "gate" || !GATE_PAIR.test(market)) return null;
  return { symbol, name, venue, market, coin: `gate:${market}`, lot };
}

const hyperliquid = (symbol: string, name: string): Asset => makeAsset("hyperliquid", symbol, symbol, name) as Asset;
const gate = (symbol: string, name: string): Asset => makeAsset("gate", `${symbol}_USDT`, symbol, name) as Asset;

/**
 * The set tokens: always on the tape and in the featured rotation, in this order.
 * RAIN (Rain protocol, rain.one) has no Hyperliquid perpetual, and its Hyperliquid spot listing does not trade
 * (no asks, no volume, a mark 6% off the market; checked 2026-10-01), so its price and chart are Gate's
 * RAIN/USDT spot market.
 */
export const SET_ASSETS: readonly Asset[] = [
  hyperliquid("HYPE", "Hyperliquid"),
  hyperliquid("SOL", "Solana"),
  hyperliquid("ETH", "Ethereum"),
  hyperliquid("BTC", "Bitcoin"),
  hyperliquid("XMR", "Monero"),
  hyperliquid("ZEC", "Zcash"),
  hyperliquid("NEAR", "NEAR Protocol"),
  hyperliquid("XRP", "XRP"),
  gate("RAIN", "Rain"),
  hyperliquid("XLM", "Stellar"),
];

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
/** Gate's public spot API: no key, any origin, 200 requests per 10 seconds per address. */
export const GATE_TICKERS_URL = "https://api.gateio.ws/api/v4/spot/tickers";

const REQUEST_TIMEOUT_MS = 8_000;

export type Quote = { price: number; changePct: number; at: number };
export type Quotes = { quotes: Map<string, Quote>; delisted: Set<string> };

type RawCtx = { markPx?: string | null; prevDayPx?: string | null };
type RawMeta = { universe?: { name?: string; isDelisted?: boolean }[] };
type RawGateTicker = { currency_pair?: string; last?: string; change_percentage?: string };

/** Mark price and change against the price 24 hours ago, from a Hyperliquid asset context. */
export function quoteFromCtx(asset: Pick<Asset, "lot">, ctx: unknown, at: number): Quote | null {
  if (!ctx || typeof ctx !== "object") return null;
  const { markPx, prevDayPx } = ctx as RawCtx;
  const price = Number(markPx) / asset.lot;
  const prev = Number(prevDayPx) / asset.lot;
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, changePct: Number.isFinite(prev) && prev > 0 ? ((price - prev) / prev) * 100 : 0, at };
}

/** Quotes for the Hyperliquid markets among `assets`, and those the exchange has delisted or does not list. One request. */
export async function fetchHyperliquidQuotes(assets: readonly Asset[]): Promise<Quotes> {
  const wanted = new Map(assets.filter((a) => a.venue === "hyperliquid").map((a) => [a.market, a]));
  const quotes = new Map<string, Quote>();
  const delisted = new Set<string>();
  if (!wanted.size) return { quotes, delisted };
  const response = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Hyperliquid returned ${response.status}`);
  const body = (await response.json()) as [RawMeta, unknown[]];
  if (!Array.isArray(body) || !Array.isArray(body[0]?.universe)) throw new Error("Hyperliquid sent an unexpected reply");
  const [meta, ctxs] = body;
  const at = Date.now();
  const listed = new Set<string>();
  (meta.universe ?? []).forEach((entry, i) => {
    const asset = entry?.name ? wanted.get(entry.name) : undefined;
    if (!asset) return;
    listed.add(asset.market);
    const quote = entry.isDelisted ? null : quoteFromCtx(asset, ctxs?.[i], at);
    if (quote) quotes.set(asset.coin, quote); else delisted.add(asset.coin);
  });
  for (const asset of wanted.values()) if (!listed.has(asset.market)) delisted.add(asset.coin);
  return { quotes, delisted };
}

/**
 * Quotes for the Gate markets among `assets`: last trade and Gate's own 24-hour change. One small request per
 * market, since the alternative is the 500 kB list of every pair. Rejects only when none could be read.
 */
export async function fetchGateQuotes(assets: readonly Asset[]): Promise<Quotes> {
  const wanted = assets.filter((a) => a.venue === "gate");
  const quotes = new Map<string, Quote>();
  const delisted = new Set<string>();
  let failures = 0;
  await Promise.all(wanted.map(async (asset) => {
    try {
      const response = await fetch(`${GATE_TICKERS_URL}?currency_pair=${encodeURIComponent(asset.market)}`, { cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // 400 is Gate's answer for a pair it does not have (any more).
      if (response.status === 400) { delisted.add(asset.coin); return; }
      if (!response.ok) throw new Error(`Gate returned ${response.status}`);
      const body = (await response.json()) as RawGateTicker[];
      const ticker = Array.isArray(body) ? body.find((entry) => entry?.currency_pair === asset.market) : undefined;
      const price = Number(ticker?.last) / asset.lot;
      const changePct = Number(ticker?.change_percentage);
      if (!ticker || !Number.isFinite(price) || price <= 0) { delisted.add(asset.coin); return; }
      quotes.set(asset.coin, { price, changePct: Number.isFinite(changePct) ? changePct : 0, at: Date.now() });
    } catch {
      failures += 1;
    }
  }));
  if (wanted.length && failures === wanted.length) throw new Error("Gate is unreachable");
  return { quotes, delisted };
}

/** Decimals that keep a price readable at any magnitude: $83,852 / $2,696.60 / $1.5024 / $0.25175 / $0.000005835. */
export function priceDecimals(value: number) {
  const v = Math.abs(value);
  if (v >= 10_000) return 0;
  if (v >= 10) return 2;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  // Four significant digits, which is as fine as Hyperliquid quotes such prices.
  return v > 0 ? Math.min(12, Math.ceil(-Math.log10(v)) + 3) : 2;
}

export function formatPrice(value: number, decimals?: number) {
  if (!Number.isFinite(value)) return "--";
  const digits = decimals ?? priceDecimals(value);
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatChange(pct: number) {
  if (!Number.isFinite(pct)) return "";
  // U+2212 is a true minus sign, the same width as "+" in a monospace face.
  return `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(2)}%`;
}
