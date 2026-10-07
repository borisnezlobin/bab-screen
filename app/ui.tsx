import type { ComponentPropsWithoutRef, ReactNode } from "react";

export const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

type PanelProps = ComponentPropsWithoutRef<"section">;

/** One region of the board. Flat on the grey: regions are told apart by the rules between them, not by boxes. */
export function Panel({ className, ...props }: PanelProps) {
  return <section {...props} className={cx("relative min-h-0 min-w-0 overflow-hidden", className)} />;
}

type ShardProps = { tone?: "accent" | "muted" | "up" | "down"; size?: "sm" | "md" | "lg"; mirrored?: boolean; className?: string };

const SHARD_TONES = { accent: "bg-accent", muted: "bg-rule-strong", up: "bg-up", down: "bg-down" } as const;
const SHARD_SIZES = { sm: "h-2.5 w-5", md: "h-3.5 w-7", lg: "h-6 w-12" } as const;

/** One parallelogram from the B@B mark: the wall's recurring marker for "live", "now" and "new". */
export function Shard({ tone = "accent", size = "md", mirrored = false, className }: ShardProps) {
  return <span aria-hidden="true" className={cx("inline-block shrink-0", mirrored ? "shard-mirror" : "shard", SHARD_TONES[tone], SHARD_SIZES[size], className)} />;
}

/** What a panel shows when it has nothing: one short line, centred. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="grid h-full place-items-center px-8 text-center text-body text-balance text-text-muted">{children}</p>;
}

export function relativeAge(postedAt: string | null | undefined, now: number = Date.now()): string | null {
  const posted = postedAt ? Date.parse(postedAt) : NaN;
  if (!Number.isFinite(posted)) return null;
  const minutes = Math.floor((now - posted) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d ago`;
  const date = new Date(posted);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
}

export const nameList = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });
