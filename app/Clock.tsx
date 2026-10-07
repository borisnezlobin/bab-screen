"use client";

import { useEffect, useState } from "react";

const ZONE = "America/Los_Angeles";
const time = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit" });
const date = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "long", month: "long", day: "numeric" });

/** Berkeley time, whatever the computer's zone, ticking on the minute. */
export function Clock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(tick, 60_000 - (current.getTime() % 60_000) + 50);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);

  if (!now) return null;
  return (
    <time dateTime={now.toISOString()} className="flex shrink-0 flex-col items-end">
      <span className="font-narrow text-title font-semibold figures">{time.format(now)}</span>
      <span className="text-meta text-text-muted">{date.format(now)}</span>
    </time>
  );
}
