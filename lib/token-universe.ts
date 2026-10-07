// The fixed list of tokens that may appear as "newsworthy" (lib/newsworthy.ts). A model names a
// token by its ticker, and a ticker is only accepted if it is in this list, so nothing a model
// writes can put an arbitrary symbol, name or market on the screen.
//
// A token is in the list when all of this holds:
//   - it is among the TOP_COINS largest by market cap on CoinGecko (which also supplies its name;
//     where several coins share a ticker, the largest owns it);
//   - it trades on Hyperliquid's own perpetual exchange, or else on Gate's spot market against
//     USDT with at least GATE_MIN_VOLUME_USD traded in the last day;
//   - that market's price is within PRICE_TOLERANCE of CoinGecko's, which is what shows the
//     ticker at the venue is the same coin and not a namesake;
//   - it is not a stablecoin, a wrapped or staked copy of another coin, or a tokenised stock or
//     commodity.
//
// Three keyless requests (CoinGecko twice, Hyperliquid, Gate), made on the server at most once
// every REFRESH_HOURS and kept in .data/token-universe.json. If the sources cannot be reached the
// last list is used; with no list at all there are no newsworthy tokens.

import { FETCH_TIMEOUT_MS, USER_AGENT } from "./feed-sources";
import { tidy } from "./feed-parse";
import { GATE_TICKERS_URL, HL_INFO_URL, type Venue } from "./markets";
import { readJson, writeJson } from "./songs-store";

export type UniverseToken = {
  symbol: string;
  name: string;
  venue: Venue;
  /** Hyperliquid coin id or Gate currency pair. */
  market: string;
  lot: number;
  /** Market-cap rank on CoinGecko when the list was built. */
  rank: number;
};

const STATE_FILE = "token-universe.json";
const STATE_VERSION = 1;
const REFRESH_HOURS = 6;
/** After a failed build, wait this long before asking the sources again. */
const RETRY_MINUTES = 30;
/** CoinGecko's keyless API allows roughly 5 to 15 requests a minute per address; this needs two per build. */
const COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=";
const COINGECKO_PAGES = 2;
const COINGECKO_PAUSE_MS = 2_500;
export const TOP_COINS = 250 * COINGECKO_PAGES;
const GATE_MIN_VOLUME_USD = 500_000;
const PRICE_TOLERANCE = 0.1;
/** The list goes into a JSON-schema enum and into the prompt, so it has a ceiling. */
const MAX_TOKENS = 400;
const NAME_MAX = 40;

// Dollar and euro stablecoins, wrapped and staked copies, tokenised gold: a "price" for these is
// either flat or somebody else's.
const EXCLUDED = new Set(
  ("USDT USDC DAI USDS USDE SUSDE SUSDS FDUSD PYUSD USD1 TUSD USDD USDG RLUSD BUSD FRAX FRXUSD GHO CRVUSD USDY USDTB USD0 USDF USDX USDP USDB EURC EURS EURT BUIDL " +
    "PAXG XAUT WBTC WETH WBNB STETH WSTETH WEETH RETH CBBTC CBETH WBETH TBTC LBTC FBTC SOLVBTC BTCB BNSOL JITOSOL MSOL JUPSOL RSETH EZETH METH LSETH OSETH SFRXETH ETHX").split(" "),
);
const NOT_A_TOKEN = /\b(tokeni[sz]ed|xstock|stock|shares?|etf|treasury|wrapped|staked|bridged|restaked|usd|dollar|euro)\b/i;

type CoinGeckoCoin = { symbol?: unknown; name?: unknown; current_price?: unknown; market_cap_rank?: unknown };
type Stored = { version: number; builtAt: string; tokens: UniverseToken[] };
type Runtime = { tokens: UniverseToken[]; builtAt: number; triedAt: number; loaded: Promise<void> | null; building: Promise<void> | null };

const globalStore = globalThis as typeof globalThis & { __babTokenUniverse?: Runtime };
const runtime: Runtime = (globalStore.__babTokenUniverse ??= { tokens: [], builtAt: 0, triedAt: 0, loaded: null, building: null });

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...init?.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  return (await response.json()) as T;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A coin's name as it may be shown: plain Latin text, or null if it is not that. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // "POL (ex-MATIC)" is shown as "POL".
  const name = tidy(tidy(value).replace(/\([^)]*\)/g, " "));
  if (!name || name.length > NAME_MAX || !/^[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N} .'&+-]*$/u.test(name)) return null;
  return name;
}

const isToken = (value: unknown): value is UniverseToken => {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.symbol === "string" && /^[A-Z0-9]{1,10}$/.test(token.symbol) &&
    typeof token.name === "string" && cleanName(token.name) === token.name &&
    (token.venue === "hyperliquid" || token.venue === "gate") &&
    typeof token.market === "string" && /^[A-Za-z0-9_]{1,20}$/.test(token.market) &&
    (token.lot === 1 || token.lot === 1000) &&
    typeof token.rank === "number"
  );
};

function nearPrice(price: number, reference: number): boolean {
  return Number.isFinite(price) && price > 0 && Math.abs(price - reference) / reference <= PRICE_TOLERANCE;
}

function isEligibleCoin(symbol: string, name: string | null, coinName: unknown, reference: number): boolean {
  return Boolean(name) && !EXCLUDED.has(symbol) && !NOT_A_TOKEN.test(String(coinName)) && Number.isFinite(reference) && reference > 0;
}

function resolveVenueToken(
  symbol: string,
  name: string,
  rank: number,
  reference: number,
  perp: { market: string; lot: number; price: number } | undefined,
  spot: { market: string; price: number; volumeUsd: number } | undefined,
): UniverseToken | null {
  if (perp && nearPrice(perp.price / perp.lot, reference)) return { symbol, name, venue: "hyperliquid", market: perp.market, lot: perp.lot, rank };
  if (spot && spot.volumeUsd >= GATE_MIN_VOLUME_USD && nearPrice(spot.price, reference)) return { symbol, name, venue: "gate", market: spot.market, lot: 1, rank };
  return null;
}

/** Pure: matches CoinGecko's ranking against what the two venues list. Exported for the checks. */
export function matchUniverse(
  coins: CoinGeckoCoin[],
  hyperliquid: Map<string, { market: string; lot: number; price: number }>,
  gate: Map<string, { market: string; price: number; volumeUsd: number }>,
): UniverseToken[] {
  const tokens: UniverseToken[] = [];
  const taken = new Set<string>();
  const ranked = coins
    .filter((coin) => typeof coin.market_cap_rank === "number")
    .sort((a, b) => (a.market_cap_rank as number) - (b.market_cap_rank as number));
  for (const coin of ranked) {
    const symbol = typeof coin.symbol === "string" ? coin.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{1,10}$/.test(symbol) || taken.has(symbol)) continue;
    taken.add(symbol);
    const name = cleanName(coin.name);
    const reference = Number(coin.current_price);
    if (!isEligibleCoin(symbol, name, coin.name, reference)) continue;
    const token = resolveVenueToken(symbol, name!, coin.market_cap_rank as number, reference, hyperliquid.get(symbol), gate.get(symbol));
    if (token) tokens.push(token);
    if (tokens.length === MAX_TOKENS) break;
  }
  return tokens;
}

type HlPerps = [{ universe?: { name?: string; isDelisted?: boolean }[] }, { markPx?: string | null }[]];

function addHyperliquidEntry(hyperliquid: Map<string, { market: string; lot: number; price: number }>, entry: { name?: string; isDelisted?: boolean }, markPx: string | null | undefined): void {
  const market = entry?.name;
  if (!market || entry.isDelisted || !/^[A-Za-z0-9]{1,12}$/.test(market)) return;
  const thousand = /^k[A-Z0-9]+$/.test(market);
  hyperliquid.set(thousand ? market.slice(1) : market.toUpperCase(), { market, lot: thousand ? 1000 : 1, price: Number(markPx) });
}

function buildHyperliquidMap(perps: HlPerps): Map<string, { market: string; lot: number; price: number }> {
  const hyperliquid = new Map<string, { market: string; lot: number; price: number }>();
  perps[0].universe?.forEach((entry, i) => addHyperliquidEntry(hyperliquid, entry, perps[1]?.[i]?.markPx));
  return hyperliquid;
}

function buildGateMap(tickers: { currency_pair?: string; last?: string; quote_volume?: string }[]): Map<string, { market: string; price: number; volumeUsd: number }> {
  const gate = new Map<string, { market: string; price: number; volumeUsd: number }>();
  for (const ticker of tickers) {
    const pair = /^([A-Z0-9]{1,12})_USDT$/.exec(ticker?.currency_pair ?? "");
    if (pair) gate.set(pair[1], { market: pair[0], price: Number(ticker.last), volumeUsd: Number(ticker.quote_volume) });
  }
  return gate;
}

async function fetchCoinGeckoCoins(): Promise<CoinGeckoCoin[]> {
  const coins: CoinGeckoCoin[] = [];
  for (let page = 1; page <= COINGECKO_PAGES; page += 1) {
    if (page > 1) await pause(COINGECKO_PAUSE_MS);
    const batch = await getJson<CoinGeckoCoin[]>(`${COINGECKO_MARKETS_URL}${page}`);
    if (!Array.isArray(batch)) throw new Error("CoinGecko sent an unexpected reply");
    coins.push(...batch);
  }
  return coins;
}

async function build(): Promise<UniverseToken[]> {
  const coins = await fetchCoinGeckoCoins();

  const [perps, tickers] = await Promise.all([
    getJson<HlPerps>(HL_INFO_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) }),
    getJson<{ currency_pair?: string; last?: string; quote_volume?: string }[]>(GATE_TICKERS_URL),
  ]);
  if (!Array.isArray(perps) || !Array.isArray(perps[0]?.universe) || !Array.isArray(tickers)) throw new Error("a venue sent an unexpected reply");

  const tokens = matchUniverse(coins, buildHyperliquidMap(perps), buildGateMap(tickers));
  if (tokens.length < 50) throw new Error(`only ${tokens.length} tokens matched`);
  return tokens;
}

function load(): Promise<void> {
  return (runtime.loaded ??= (async () => {
    const stored = await readJson<Partial<Stored>>(STATE_FILE);
    if (!stored || stored.version !== STATE_VERSION || !Array.isArray(stored.tokens)) return;
    const builtAt = Date.parse(String(stored.builtAt));
    if (!Number.isFinite(builtAt)) return;
    runtime.tokens = stored.tokens.filter(isToken).slice(0, MAX_TOKENS);
    runtime.builtAt = builtAt;
  })());
}

/**
 * The list, by ticker, rebuilt first if it is due. Never rejects: when the sources cannot be
 * reached the last list is returned, and null when there has never been one.
 */
export async function getUniverse(now = Date.now()): Promise<Map<string, UniverseToken> | null> {
  await load();
  const due = now - runtime.builtAt > REFRESH_HOURS * 3_600_000 && now - runtime.triedAt > RETRY_MINUTES * 60_000;
  if (due) {
    runtime.building ??= (async () => {
      runtime.triedAt = Date.now();
      try {
        runtime.tokens = await build();
        runtime.builtAt = Date.now();
        await writeJson(STATE_FILE, { version: STATE_VERSION, builtAt: new Date(runtime.builtAt).toISOString(), tokens: runtime.tokens } satisfies Stored);
      } catch (error) {
        console.warn("[newsworthy] could not rebuild the token list:", error instanceof Error ? error.message : error);
      } finally {
        runtime.building = null;
      }
    })();
    await runtime.building;
  }
  return runtime.tokens.length ? new Map(runtime.tokens.map((token) => [token.symbol, token])) : null;
}
