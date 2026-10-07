export const ETHEREUM_RPC_URL = "https://ethereum-rpc.publicnode.com";
const POLL_MS = 4_000;
const REQUEST_TIMEOUT_MS = 6_000;

export type ChainBlock = {
  number: number;
  hash: string;
  transactionCount: number;
  timestamp: number;
};

type RpcBlock = { number?: unknown; hash?: unknown; timestamp?: unknown; transactions?: unknown };

function parseBlock(raw: RpcBlock | null | undefined): ChainBlock | null {
  if (!raw || typeof raw.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(raw.hash)) return null;
  if (typeof raw.number !== "string" || typeof raw.timestamp !== "string") return null;
  return {
    number: Number.parseInt(raw.number, 16),
    hash: raw.hash.toLowerCase(),
    transactionCount: Array.isArray(raw.transactions) ? raw.transactions.length : 0,
    timestamp: Number.parseInt(raw.timestamp, 16) * 1000,
  };
}

async function fetchBlock(tag: string, signal: AbortSignal): Promise<ChainBlock | null> {
  const response = await fetch(ETHEREUM_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [tag, false] }),
    signal,
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: RpcBlock };
  return parseBlock(body.result);
}

/** The blocks just before `newest`, oldest first, so a screen that has just loaded starts with a full chain. */
async function fetchPrevious(newest: ChainBlock, count: number, signal: AbortSignal): Promise<ChainBlock[]> {
  const numbers = Array.from({ length: count }, (_, index) => newest.number - count + index).filter((number) => number >= 0);
  const blocks = await Promise.all(numbers.map((number) => fetchBlock(`0x${number.toString(16)}`, signal).catch(() => null)));
  return blocks.filter((block): block is ChainBlock => block !== null);
}

/** The 256 bits of a block hash as 8 unsigned 32-bit words, most significant first. */
export function hashWords(hash: string): number[] {
  const hex = hash.replace(/^0x/, "").padStart(64, "0");
  return Array.from({ length: 8 }, (_, index) => Number.parseInt(hex.slice(index * 8, index * 8 + 8), 16) >>> 0);
}

/**
 * Calls `onBlock` once for every new Ethereum block seen, polling a public RPC node; on the first poll it first
 * hands over the `backfill` blocks before the newest, oldest first. Returns a stop function.
 */
export function watchEthereumBlocks(onBlock: (block: ChainBlock) => void, backfill = 0): () => void {
  let stopped = false;
  let timer: number | undefined;
  let request: AbortController | null = null;
  let lastNumber = -1;

  const poll = async () => {
    request = new AbortController();
    const giveUp = window.setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
    try {
      const block = await fetchBlock("latest", request.signal);
      const earlier = block && lastNumber < 0 && backfill > 0 ? await fetchPrevious(block, backfill, request.signal) : [];
      for (const next of [...earlier, ...(block ? [block] : [])]) {
        if (stopped || next.number <= lastNumber) continue;
        lastNumber = next.number;
        onBlock(next);
      }
    } catch {
      // The node is unreachable for now; the next poll tries again.
    } finally {
      window.clearTimeout(giveUp);
    }
    if (!stopped) timer = window.setTimeout(poll, POLL_MS);
  };
  timer = window.setTimeout(poll, 0);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    request?.abort();
  };
}
