import type { Asset } from "./markets";

export type Candle = { at: number; open: number; high: number; low: number; close: number; volume: number };

/** The featured chart's window: 48 half-hour candles, the last 24 hours. */
export const CANDLE_MINUTES = 30;
export const CANDLE_COUNT = 48;
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const GATE_CANDLES_URL = "https://api.gateio.ws/api/v4/spot/candlesticks";

const finite = (values: number[]) => values.every(Number.isFinite);

function perToken(candle: Candle, lot: number): Candle {
  return { ...candle, open: candle.open / lot, high: candle.high / lot, low: candle.low / lot, close: candle.close / lot };
}

type HyperliquidCandle = { t: number; o: string; h: string; l: string; c: string; v: string };

async function hyperliquidCandles(asset: Asset, signal: AbortSignal): Promise<Candle[]> {
  const endTime = Date.now();
  const startTime = endTime - CANDLE_COUNT * CANDLE_MINUTES * 60_000;
  const response = await fetch(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: asset.market, interval: `${CANDLE_MINUTES}m`, startTime, endTime } }),
    signal,
  });
  if (!response.ok) throw new Error(`Hyperliquid candles: HTTP ${response.status}`);
  const rows = (await response.json()) as HyperliquidCandle[];
  return rows.map((row) => ({ at: row.t, open: Number(row.o), high: Number(row.h), low: Number(row.l), close: Number(row.c), volume: Number(row.v) }));
}

async function gateCandles(asset: Asset, signal: AbortSignal): Promise<Candle[]> {
  const url = `${GATE_CANDLES_URL}?currency_pair=${encodeURIComponent(asset.market)}&interval=${CANDLE_MINUTES}m&limit=${CANDLE_COUNT}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Gate candles: HTTP ${response.status}`);
  const rows = (await response.json()) as string[][];
  return rows.map(([seconds, , close, high, low, open, baseVolume]) => ({
    at: Number(seconds) * 1000, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(baseVolume),
  }));
}

/** The last 24 hours of half-hour candles, oldest first, priced per token. */
export async function fetchCandles(asset: Asset, signal: AbortSignal): Promise<Candle[]> {
  const raw = asset.venue === "gate" ? await gateCandles(asset, signal) : await hyperliquidCandles(asset, signal);
  return raw
    .filter((candle) => finite([candle.at, candle.open, candle.high, candle.low, candle.close, candle.volume]))
    .sort((a, b) => a.at - b.at)
    .slice(-CANDLE_COUNT)
    .map((candle) => perToken(candle, asset.lot));
}
