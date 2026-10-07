import type { Candle } from "./candles";

export type Box = { width: number; height: number };
export type CandleMark = { key: number; x: number; width: number; bodyTop: number; bodyHeight: number; wickTop: number; wickBottom: number; rising: boolean; volumeHeight: number };
export type PriceLevel = { price: number; y: number };
export type TimeTick = { at: number; x: number };
export type ChartGeometry = { candles: CandleMark[]; levels: PriceLevel[]; ticks: TimeTick[]; priceY: (price: number) => number; plot: Box };

export const PRICE_GUTTER_PX = 128;
export const TIME_GUTTER_PX = 40;
const VOLUME_SHARE = 0.16;
const CANDLE_FILL_SHARE = 0.62;
const LEVEL_COUNT = 5;
const TICK_EVERY_MS = 6 * 3_600_000;

function niceStep(rough: number) {
  const power = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return nice * power;
}

function priceRange(candles: readonly Candle[], live: number | null) {
  let low = Math.min(...candles.map((c) => c.low));
  let high = Math.max(...candles.map((c) => c.high));
  if (live !== null && Number.isFinite(live)) { low = Math.min(low, live); high = Math.max(high, live); }
  const pad = (high - low || high * 0.01 || 1) * 0.08;
  return { low: low - pad, high: high + pad };
}

function levelsFor(low: number, high: number, priceY: (price: number) => number): PriceLevel[] {
  const step = niceStep((high - low) / LEVEL_COUNT);
  const levels: PriceLevel[] = [];
  for (let price = Math.ceil(low / step) * step; price <= high; price += step) levels.push({ price, y: priceY(price) });
  return levels;
}

function ticksFor(candles: readonly Candle[], slot: number): TimeTick[] {
  return candles.flatMap((candle, index) => (candle.at % TICK_EVERY_MS === 0 ? [{ at: candle.at, x: (index + 0.5) * slot }] : []));
}

export function chartGeometry(candles: readonly Candle[], box: Box, live: number | null, slots: number): ChartGeometry {
  const plot = { width: Math.max(0, box.width - PRICE_GUTTER_PX), height: Math.max(0, box.height - TIME_GUTTER_PX) };
  const priceHeight = plot.height * (1 - VOLUME_SHARE);
  const { low, high } = priceRange(candles, live);
  const priceY = (price: number) => ((high - price) / (high - low)) * priceHeight;
  const slot = plot.width / Math.max(slots, candles.length, 1);
  const maxVolume = Math.max(...candles.map((c) => c.volume), 1);
  const marks = candles.map((candle, index): CandleMark => {
    const top = priceY(Math.max(candle.open, candle.close));
    const bottom = priceY(Math.min(candle.open, candle.close));
    return {
      key: candle.at,
      x: index * slot + (slot * (1 - CANDLE_FILL_SHARE)) / 2,
      width: slot * CANDLE_FILL_SHARE,
      bodyTop: top,
      bodyHeight: Math.max(1.5, bottom - top),
      wickTop: priceY(candle.high),
      wickBottom: priceY(candle.low),
      rising: candle.close >= candle.open,
      volumeHeight: (candle.volume / maxVolume) * plot.height * VOLUME_SHARE * 0.9,
    };
  });
  return { candles: marks, levels: levelsFor(low, high, priceY), ticks: ticksFor(candles, slot), priceY, plot };
}
