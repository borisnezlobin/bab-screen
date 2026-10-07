"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoinFlipView } from "../lib/coin-flip";
import type { JamQr } from "../lib/jam";
import { CoinToss } from "./CoinToss";
import { Panel, Shard, cx } from "./ui";

const POLL_MS = 2_000;
const QR_BOX_PX = 220;
const RECEIPT_BOX_PX = 250;
/** How long the receipt QR stays up once the payout has landed, and the longest the stage is held waiting for it. */
const RECEIPT_MS = 20_000;
const MAX_SHOW_MS = 60_000;
const LEAVE_MS = 600;
/** A game older than this when the page first sees it (a reload, a late poll) is not replayed. */
const FRESH_MS = 30_000;
const DEMO_EVERY_MS = 42_000;

type Ok = Extract<CoinFlipView, { status: "ok" }>;
type Game = NonNullable<Ok["game"]>;
type Phase = "flip" | "landed" | "leaving";

const cue = (name: "start" | "toss" | "land") => void fetch(`/api/coin-flip/sound?cue=${name}`, { method: "POST" }).catch(() => {});
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const money = (usd: number) => `$${usd.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(usd) ? 0 : 2, maximumFractionDigits: 2 })}`;
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

function Qr({ qr, box, label }: { qr: JamQr; box: number; label: string }) {
  const side = Math.max(1, Math.floor(box / qr.modules)) * qr.modules;
  return (
    <svg viewBox={`0 0 ${qr.modules} ${qr.modules}`} width={side} height={side} className="block fill-ink" shapeRendering="crispEdges" role="img" aria-label={label}>
      <path d={qr.path} />
    </svg>
  );
}

function SideBadge({ side }: { side: "heads" | "tails" }) {
  if (side === "tails") return <span className="grid size-11 place-items-center rounded-full bg-accent-glow text-title font-bold text-ink">$</span>;
  return <span className="grid size-11 place-items-center rounded-full bg-accent-glow"><span className="bab-mark size-7 bg-ink" /></span>;
}

function Player({ game, side, landed }: { game: Game; side: "heads" | "tails"; landed: boolean }) {
  const won = landed && game.winner === side;
  return (
    <div className={cx("flex flex-col items-center gap-3 text-center transition-opacity duration-500", landed && !won && "opacity-30")}>
      <p className="flex items-center gap-3.5 text-title font-medium text-text-secondary"><SideBadge side={side} />{side === "heads" ? "Heads" : "Tails"}</p>
      <p className="text-feature font-semibold">{short(game[side])}</p>
      <p className="flex h-10 items-center gap-3 text-title font-semibold text-accent-text">{won && <><Shard className="animate-ember-pulse" />Winner</>}</p>
    </div>
  );
}

function payoutLine(game: Game, pot: string, landed: boolean, paid: boolean) {
  if (!landed) return "";
  return paid ? `${pot} sent to ${short(game[game.winner])}` : `Sending ${pot} to ${short(game[game.winner])}`;
}

function receiptFor(game: Game | null, view: Ok | null, landed: boolean) {
  if (!game || !landed) return null;
  if (game.id.startsWith("demo")) return view?.qr ?? null;
  return view?.game?.id === game.id ? view.game.payout?.qr ?? null : null;
}

function WalletTile({ view }: { view: Ok }) {
  return (
    <Panel aria-label="Coin flip" className="flex shrink-0 gap-5 border-t border-rule pt-5">
      <div className="grid size-55 shrink-0 place-items-center rounded-inner bg-paper"><Qr qr={view.qr} box={QR_BOX_PX} label="QR code of the coin flip wallet address" /></div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="font-narrow text-title font-semibold">Flip a coin for USDC</p>
        {!view.waiting && <p className="text-body text-text-secondary">Send {money(view.minUsd)} or more on {view.network}. The next person to match it plays you.</p>}
        {view.waiting ? (
          <div className="mt-auto">
            <p className="text-headline font-semibold text-accent-text">{money(view.waiting.usd)}</p>
            <p className="text-body text-text-secondary">Match it to play</p>
            <p className="text-meta text-text-muted">From {short(view.waiting.from)}, {clock(view.waiting.remainingMs)} left</p>
          </div>
        ) : (
          <p className="mt-auto text-meta text-text-muted">{view.problem ? "Not watching for deposits right now" : "Waiting for the first stake"}</p>
        )}
      </div>
    </Panel>
  );
}

export function CoinFlip() {
  const [view, setView] = useState<Ok | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [phase, setPhase] = useState<Phase>("flip");
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const next = (await (await fetch("/api/coin-flip", { cache: "no-store" })).json()) as CoinFlipView;
        if (!alive) return;
        setView(next.status === "ok" ? next : null);
        if (next.status === "ok" && next.game && next.game.ageMs < FRESH_MS && next.game.id !== lastId.current) {
          lastId.current = next.game.id;
          setGame(next.game);
        }
      } catch {
        // The next poll tries again.
      }
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  // ?coinflip=demo plays the animation with made-up players; the wallet's QR stands in for the receipt.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("coinflip") !== "demo") return;
    let n = 0;
    const play = () => setGame({ id: `demo-${n += 1}`, heads: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", tails: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30", stakeUsd: 5, winner: Math.random() < .5 ? "heads" : "tails", ageMs: 0, payout: null });
    play();
    const timer = window.setInterval(play, DEMO_EVERY_MS);
    return () => window.clearInterval(timer);
  }, []);

  const gameId = game?.id;
  const landed = phase !== "flip";
  const receipt = receiptFor(game, view, landed);
  const paid = !!receipt;

  useEffect(() => {
    if (!gameId) return;
    setPhase("flip");
    cue("start");
    const leave = window.setTimeout(() => setPhase("leaving"), MAX_SHOW_MS);
    return () => window.clearTimeout(leave);
  }, [gameId]);
  const toss = useCallback(() => cue("toss"), []);
  const land = useCallback(() => {
    cue("land");
    setPhase((now) => (now === "flip" ? "landed" : now));
  }, []);

  useEffect(() => {
    if (!paid) return;
    const leave = window.setTimeout(() => setPhase("leaving"), RECEIPT_MS);
    return () => window.clearTimeout(leave);
  }, [paid, gameId]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const done = window.setTimeout(() => setGame(null), LEAVE_MS);
    return () => window.clearTimeout(done);
  }, [phase]);

  const pot = game ? money(game.stakeUsd * 2) : "";

  return (
    <>
      {view && <WalletTile view={view} />}
      {game && (
        <div key={game.id} role="status" className={cx("fixed inset-0 z-50 grid animate-fade-in grid-rows-[auto_minmax(0,1fr)_auto_auto] items-center justify-items-center overflow-hidden bg-canvas p-24 transition-opacity duration-500", phase === "leaving" && "opacity-0")}>
          <p className="text-subhead font-medium text-text-secondary">Coin flip for {pot}</p>
          <div className="grid w-full grid-cols-[minmax(0,1fr)_700px_minmax(0,1fr)] items-center">
            <Player game={game} side="heads" landed={landed} />
            <div className="relative z-10 size-75 justify-self-center"><CoinToss winner={game.winner} onToss={toss} onLand={land} /></div>
            <Player game={game} side="tails" landed={landed} />
          </div>
          <p className="min-h-26 font-narrow text-display font-bold">{landed ? <span className="inline-block animate-rise-in">{game.winner === "heads" ? "Heads" : "Tails"} wins {pot}</span> : ""}</p>
          <p className="mt-4 h-10 text-title text-text-secondary">{payoutLine(game, pot, landed, paid)}</p>
          {receipt && (
            <div className="absolute right-24 bottom-24 z-20 grid animate-fade-in justify-items-center gap-3 text-body text-text-secondary">
              <p>Scan for the transaction</p>
              <div className="grid size-62.5 place-items-center rounded-inner bg-paper"><Qr qr={receipt} box={RECEIPT_BOX_PX} label="QR code of the payout transaction on the block explorer" /></div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
