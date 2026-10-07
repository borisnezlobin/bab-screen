"use client";

import { useEffect, useState } from "react";
import { Carousel } from "./Carousel";
import { ChainStrip } from "./ChainStrip";
import { Clock } from "./Clock";
import { CoinFlip } from "./CoinFlip";
import { Events } from "./Events";
import { Feed } from "./Feed";
import { FeaturedMarket, MarketsProvider, TickerTape } from "./Markets";
import { NowPlaying } from "./NowPlaying";
import { RecentSpots, SpotTakeover, useSpotAlerts } from "./SpotAlert";
import { cx } from "./ui";

/** The stage is laid out at 1920x1080 and scaled to whatever screen it is on. */
function useStageFit() {
  useEffect(() => {
    const fit = () => document.documentElement.style.setProperty("--fit", String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
}

function TopBar() {
  return (
    <header className="col-span-3 flex items-center gap-8 border-b border-rule-strong pb-4">
      <span role="img" aria-label="Blockchain at Berkeley" className="bab-mark h-11 w-12 shrink-0 bg-text" />
      <div className="h-full min-w-0 flex-1">
        <TickerTape />
      </div>
      <Clock />
    </header>
  );
}

function SideColumn() {
  // The calendar takes room only while it has events to list.
  const [hasEvents, setHasEvents] = useState(false);
  return (
    <div className="flex min-h-0 flex-col gap-6 border-l border-rule pl-10">
      <NowPlaying />
      <Carousel />
      <div aria-hidden={!hasEvents} className={cx("shrink-0 overflow-hidden border-rule transition-[height,opacity] duration-500 ease-out-soft", hasEvents ? "h-48 border-t pt-4 opacity-100" : "-mt-6 h-0 opacity-0")}>
        <Events label={null} quietWhenEmpty onState={({ count }) => setHasEvents(count > 0)} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  useStageFit();
  const spots = useSpotAlerts();
  return (
    <MarketsProvider>
      <main className="fixed top-1/2 left-1/2 grid h-[1080px] w-[1920px] -translate-1/2 scale-(--fit) grid-cols-[440px_minmax(0,1fr)_460px] grid-rows-[72px_minmax(0,1fr)_auto] gap-y-6 bg-canvas px-12 pt-7 pb-6">
        <TopBar />
        <div className="flex min-h-0 flex-col gap-6 border-r border-rule pr-10">
          <Feed />
          <RecentSpots spots={spots.recent} now={spots.now} />
          <CoinFlip />
        </div>
        <div className="min-h-0 px-10">
          <FeaturedMarket />
        </div>
        <SideColumn />
        <ChainStrip />
        <SpotTakeover spot={spots.takeover} now={spots.now} />
      </main>
    </MarketsProvider>
  );
}
