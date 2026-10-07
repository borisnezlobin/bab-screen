"use client";

import { useSyncExternalStore } from "react";
import { watchEthereumBlocks, type ChainBlock } from "@/lib/chain-blocks";

export type { ChainBlock } from "@/lib/chain-blocks";

/** How many recent blocks are kept: the chain strip draws this many. */
export const RECENT_BLOCK_COUNT = 8;

type Listener = () => void;

const listeners = new Set<Listener>();
let recent: readonly ChainBlock[] = [];
let stopWatching: (() => void) | null = null;

function receive(block: ChainBlock) {
  recent = [block, ...recent].slice(0, RECENT_BLOCK_COUNT);
  listeners.forEach((listener) => listener());
}

export function subscribeToBlocks(listener: Listener) {
  listeners.add(listener);
  stopWatching ??= watchEthereumBlocks(receive, RECENT_BLOCK_COUNT - 1);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !stopWatching) return;
    stopWatching();
    stopWatching = null;
  };
}

/** Newest first. The same array until a new block arrives. */
export function recentBlocks(): readonly ChainBlock[] {
  return recent;
}

const NO_BLOCKS: readonly ChainBlock[] = [];

export function useRecentBlocks(): readonly ChainBlock[] {
  return useSyncExternalStore(subscribeToBlocks, recentBlocks, () => NO_BLOCKS);
}
