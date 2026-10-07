"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CANDLE_COUNT, fetchCandles, type Candle } from "@/lib/candles";
import { PRICE_GUTTER_PX, chartGeometry, type Box, type ChartGeometry } from "@/lib/chart-geometry";
import { formatPrice, type Asset } from "@/lib/markets";
import { EmptyNote, cx } from "./ui";

const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const timeLabel = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true });

type CandleStore = Record<string, Candle[]>;

async function loadCandles(asset: Asset): Promise<Candle[] | null> {
  const request = new AbortController();
  const giveUp = window.setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
  try {
    const candles = await fetchCandles(asset, request.signal);
    return candles.length > 1 ? candles : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(giveUp);
  }
}

/** Candles for the featured market, kept fresh, and for the next one, fetched ahead so the swap shows a finished chart. */
function useCandles(featured: Asset, next: Asset | null, onLoaded: (coin: string, ok: boolean) => void) {
  const [store, setStore] = useState<CandleStore>({});
  const wanted = [featured, ...(next && next.coin !== featured.coin ? [next] : [])];
  const wantedKey = wanted.map((asset) => asset.coin).join(",");
  const assets = useRef(wanted);
  assets.current = wanted;

  useEffect(() => {
    let alive = true;
    const refresh = () => assets.current.forEach(async (asset) => {
      const candles = await loadCandles(asset);
      if (!alive) return;
      if (candles) setStore((current) => ({ ...current, [asset.coin]: candles }));
      onLoaded(asset.coin, candles !== null);
    });
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [wantedKey, onLoaded]);

  return store[featured.coin] ?? null;
}

function useBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, box };
}

const LABEL_CLEARANCE_PX = 40;

function Grid({ geometry, liveY }: { geometry: ChartGeometry; liveY: number | null }) {
  return (
    <g>
      {geometry.levels.map((level) => (
        <g key={level.price}>
          <line x1={0} x2={geometry.plot.width} y1={level.y} y2={level.y} className="stroke-rule" strokeWidth={1} />
          {(liveY === null || Math.abs(level.y - liveY) > LABEL_CLEARANCE_PX) && (
            <text x={geometry.plot.width + 16} y={level.y} dominantBaseline="middle" className="fill-text-muted text-meta figures">{formatPrice(level.price)}</text>
          )}
        </g>
      ))}
      {geometry.ticks.map((tick) => (
        <text key={tick.at} x={tick.x} y={geometry.plot.height + 30} textAnchor="middle" className="fill-text-muted text-meta figures">{timeLabel.format(tick.at)}</text>
      ))}
    </g>
  );
}

function Candles({ geometry }: { geometry: ChartGeometry }) {
  return (
    <g>
      {geometry.candles.map((mark, index) => {
        const tone = mark.rising ? "fill-up stroke-up" : "fill-down stroke-down";
        const stagger = { animationDelay: `${index * 14}ms` } as CSSProperties;
        return (
          <g key={mark.key} className={cx("animate-candle-in [transform-box:fill-box] origin-bottom", tone)} style={stagger}>
            <rect x={mark.x} y={geometry.plot.height - mark.volumeHeight} width={mark.width} height={mark.volumeHeight} className="opacity-20" strokeWidth={0} />
            <line x1={mark.x + mark.width / 2} x2={mark.x + mark.width / 2} y1={mark.wickTop} y2={mark.wickBottom} strokeWidth={2} />
            <rect x={mark.x} y={mark.bodyTop} width={mark.width} height={mark.bodyHeight} rx={1.5} strokeWidth={0} />
          </g>
        );
      })}
    </g>
  );
}

function LivePrice({ geometry, price }: { geometry: ChartGeometry; price: number }) {
  const y = geometry.priceY(price);
  return (
    <g className="transition-transform duration-700 ease-out-soft" style={{ transform: `translateY(${y}px)` }}>
      <line x1={0} x2={geometry.plot.width} y1={0} y2={0} className="stroke-accent" strokeWidth={1.5} strokeDasharray="2 7" strokeLinecap="round" />
      <rect x={geometry.plot.width + 4} y={-19} width={PRICE_GUTTER_PX - 4} height={38} rx={8} className="fill-text" />
      <text x={geometry.plot.width + 16} y={1} dominantBaseline="middle" className="fill-paper text-meta font-semibold figures">{formatPrice(price)}</text>
    </g>
  );
}

/** The featured market's last 24 hours in half-hour candles, drawn on the wall's own palette. */
export function CandleChart({ featured, next, price, onLoaded }: { featured: Asset; next: Asset | null; price: number | null; onLoaded: (coin: string, ok: boolean) => void }) {
  const candles = useCandles(featured, next, onLoaded);
  const { ref, box } = useBox();
  const ready = candles && box.width > 0;
  const geometry = ready ? chartGeometry(candles, box, price, CANDLE_COUNT) : null;
  return (
    <div ref={ref} className="relative size-full">
      {!candles && <EmptyNote>Loading chart…</EmptyNote>}
      {geometry && (
        <svg key={featured.coin} width={box.width} height={box.height} className="absolute inset-0 overflow-visible" role="img" aria-label={`${featured.name} price over the last 24 hours, in half-hour candles`}>
          <Grid geometry={geometry} liveY={price === null ? null : geometry.priceY(price)} />
          <Candles geometry={geometry} />
          {price !== null && <LivePrice geometry={geometry} price={price} />}
        </svg>
      )}
    </div>
  );
}
