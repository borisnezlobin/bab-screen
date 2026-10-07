"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EMPTY_GLYPH, GLYPH_HEIGHT, GLYPH_WIDTH, glyphPaths } from "@/lib/block-glyph";
import { useRecentBlocks, type ChainBlock } from "./chain";
import { cx } from "./ui";

/** Blocks shown, newest on the right, and the room each one takes (glyph plus the link to the next). */
const SHOWN_BLOCKS = 4;
const LINK_WIDTH = 44;
const SLOT_WIDTH = GLYPH_WIDTH + LINK_WIDTH;
/** Ethereum proposes a block every 12 seconds; the next slot fills over that time. */
const SLOT_MS = 12_000;
const SLIDE_MS = 900;
const TICK_MS = 200;

const count = new Intl.NumberFormat("en-US");

/** Newest first: the hot orange of a block that has just landed, cooling to grey as later blocks arrive. */
const BIT_TONES = ["fill-accent animate-heat", "fill-accent-text", "fill-text-secondary", "fill-text-muted"] as const;

function BlockGlyph({ block, age }: { block: ChainBlock; age: number }) {
  const { ones, zeros } = useMemo(() => glyphPaths(block.hash), [block.hash]);
  const newest = age === 0;
  return (
    <div className="flex shrink-0 flex-col gap-2" style={{ width: GLYPH_WIDTH }}>
      <svg width={GLYPH_WIDTH} height={GLYPH_HEIGHT} viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`} className={cx("overflow-visible", newest && "drop-shadow-glow")} role="img" aria-label={`Ethereum block ${count.format(block.number)}, hash ${block.hash}`}>
        <path d={zeros} className="fill-surface-sunk" />
        <path d={ones} className={cx("transition-[fill] duration-1000", BIT_TONES[Math.min(age, BIT_TONES.length - 1)], newest && "animate-cell-in")} />
      </svg>
      <p className="flex items-baseline justify-between gap-3 whitespace-nowrap">
        <span className={cx("font-narrow text-label font-semibold figures", newest ? "text-text" : "text-text-secondary")}>{count.format(block.number)}</span>
        <span className="text-meta text-text-muted">{count.format(block.transactionCount)} transactions</span>
      </p>
    </div>
  );
}

function Link() {
  return <span aria-hidden="true" className="mb-8 h-px shrink-0 self-center bg-rule-strong" style={{ width: LINK_WIDTH - 16, marginInline: 8 }} />;
}

/** How far the next slot has filled, from the newest block's timestamp; held just short of full while it is late. */
function useSlotProgress(newest: ChainBlock | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  if (!newest) return 0;
  return Math.min(0.97, Math.max(0, (now - newest.timestamp) / SLOT_MS));
}

function NextSlot({ newest }: { newest: ChainBlock | undefined }) {
  const progress = useSlotProgress(newest);
  return (
    <div className="flex shrink-0 flex-col gap-2" style={{ width: GLYPH_WIDTH }}>
      <svg width={GLYPH_WIDTH} height={GLYPH_HEIGHT} viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`} aria-hidden="true">
        <defs>
          <clipPath id="next-slot-progress">
            <rect x={0} y={0} height={GLYPH_HEIGHT} width={GLYPH_WIDTH * progress} className="transition-[width] duration-200 ease-linear" />
          </clipPath>
        </defs>
        <path d={EMPTY_GLYPH} className="fill-surface-sunk" />
        <path d={EMPTY_GLYPH} clipPath="url(#next-slot-progress)" className="fill-rule" />
      </svg>
      <p className="flex items-baseline justify-between gap-3 whitespace-nowrap text-text-muted">
        <span className="font-narrow text-label font-semibold figures">{newest ? count.format(newest.number + 1) : ""}</span>
        <span className="text-meta">Next block</span>
      </p>
    </div>
  );
}

/** Slides the row left by one slot whenever a new block lands on the right. */
function useSlideOnArrival(newestNumber: number | null) {
  const track = useRef<HTMLDivElement>(null);
  const previous = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = track.current;
    const arrived = previous.current !== null && newestNumber !== null && newestNumber > previous.current;
    previous.current = newestNumber;
    if (!element || !arrived) return;
    element.animate([{ transform: `translateX(${SLOT_WIDTH}px)` }, { transform: "translateX(0)" }], { duration: SLIDE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  }, [newestNumber]);
  return track;
}

/**
 * Ethereum mainnet as a chain along the bottom of the board: the last few blocks, each drawn from its hash, the
 * newest glowing orange and cooling to grey as later ones push it left, and the next block filling in on the right.
 */
export function ChainStrip() {
  const blocks = useRecentBlocks();
  const shown = blocks.slice(0, SHOWN_BLOCKS).reverse();
  const newest = blocks[0];
  const track = useSlideOnArrival(newest?.number ?? null);
  return (
    <section aria-label="Ethereum blocks" className="col-span-3 flex items-end gap-10 border-t border-rule-strong pt-5">
      <div className="flex w-60 shrink-0 flex-col gap-1 self-center">
        <p className="font-narrow text-title font-semibold">Ethereum</p>
        <p className="text-meta text-text-muted">A new block every 12 seconds</p>
      </div>
      <div className="fade-l flex min-w-0 flex-1 justify-end overflow-hidden">
        <div ref={track} className="flex items-end">
          {shown.map((block, index) => (
            <div key={block.number} className="flex items-end">
              <BlockGlyph block={block} age={shown.length - 1 - index} />
              <Link />
            </div>
          ))}
          <NextSlot newest={newest} />
        </div>
      </div>
    </section>
  );
}
