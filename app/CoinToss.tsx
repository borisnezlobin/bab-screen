"use client";

import { useEffect, useRef } from "react";

// The coin toss, drawn as flat vector art on a canvas. The coin is a rigid disc with a real orientation, and the
// toss is drawn out for suspense: it trembles and sinks back, is thrown up and hangs in slow motion at the top,
// comes down standing on its edge and spins there showing neither face, leans towards the losing side, and only
// then falls flat on the winner. Projection is orthographic, so each face is an affine map of its artwork.

type Side = "heads" | "tails";
type M3 = number[];

const SIZE = 780;
const RADIUS = 150;
const THICKNESS = .15;
// Seconds: at rest, the trembling dip before the throw, in the air, two hops (duration, height) as it lands, the
// spin on its edge, and the fall flat.
const HOLD = 1;
const WINDUP = 1.6;
const FLIGHT = 4.6;
const HOPS = [[.3, .1], [.16, .03]];
const SPIN = 3.6;
const FALL = 2.6;
/** The result is called this long after the coin comes down, once the face is plain to see. */
const LANDED_AFTER = SPIN + 2.1;
const SPARKLE = 2.6;
const TURNS = 12;
const LIFT = 1.1;
/** How much of its speed the toss loses at the top: 0 is none, 1 would stop it dead. */
const HANG = .75;
const LIGHT = [-.6, -.8];
const STARS = [[-1.3, -.9, .2], [1.32, -.78, .16], [1.12, 1.08, .13], [-1.08, 1.02, .18], [.25, -1.5, .11]];

const { PI, sin, cos, min, max, hypot } = Math;
const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const rotX = (a: number): M3 => [1, 0, 0, 0, cos(a), -sin(a), 0, sin(a), cos(a)];
const rotY = (a: number): M3 => [cos(a), 0, sin(a), 0, 1, 0, -sin(a), 0, cos(a)];
const rotZ = (a: number): M3 => [cos(a), -sin(a), 0, sin(a), cos(a), 0, 0, 0, 1];
const mul = (a: M3, b: M3): M3 => a.map((_, i) => a[i - i % 3] * b[i % 3] + a[i - i % 3 + 1] * b[i % 3 + 3] + a[i - i % 3 + 2] * b[i % 3 + 6]);
const mix = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join()})`;

/** A copper coin, in the poster's burnt-orange family rather than the logo's gold. */
const COPPER = {
  face: "#F27B4A",
  rim: "#FFCCB7",
  recess: "#AE4104",
  wellLight: "#F58A5A",
  wellDark: "#D9581B",
  shadow: "#7A300F",
  relief: "#FFD9C9",
  reliefMinor: "#FFF1EA",
  edgeDark: [122, 48, 15],
  edgeLight: [242, 123, 74],
  tilt: [82, 30, 6],
};

type Logo = { path: Path2D; minor: boolean }[];
let logo: Promise<Logo> | null = null;
const loadLogo = () => (logo ??= fetch("/bab-logo.svg").then((r) => r.text()).then((svg) => [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"/g)].map((m) => ({ path: new Path2D(m[1]), minor: m[2] !== "#FECB33" }))));

/** Orientation, height (in radii the coin is lifted towards the viewer) and tremble (px) at t seconds. */
function pose(t: number, tails: boolean) {
  const rest = tails ? rotX(PI) : IDENTITY;
  const launch = HOLD + WINDUP;
  if (t < launch) {
    // Slowly down and back with a growing tremble, then quickly up into the throw.
    const wind = max(0, t - HOLD) / WINDUP;
    const dip = sin(PI * wind ** 3);
    return { R: rotX(-.34 * dip), h: -.18 * dip, x: 5 * wind * wind * sin(140 * t), y: 5 * wind * wind * sin(117 * t + 1) };
  }
  const thrown = (t - launch) / FLIGHT;
  if (thrown < 1) {
    // Time itself slows at the top, so the coin hangs there turning slowly.
    const flight = thrown + HANG * sin(2 * PI * thrown) / (2 * PI);
    const R = mul(mul(rotZ(2 * PI * flight), rotY(.4 * sin(PI * flight))), rotX((2 * PI * TURNS + (tails ? PI : 0) + PI / 2) * flight));
    return { R, h: 4 * LIFT * flight * (1 - flight), x: 0, y: 0 };
  }
  let u = t - launch - FLIGHT;
  // On its edge the coin rocks either side of upright, a sliver of each face in turn. Past 90 degrees is the
  // losing face: the fall begins with a lean that way before it swings back and drops on the winner.
  const fall = min(1, max(0, (u - SPIN) / FALL));
  const tilt = u < SPIN
    ? PI / 2 + .16 * sin(2 * PI * 1.1 * u) * sin(PI * u / SPIN)
    : PI / 2 * cos(PI / 2 * fall) ** 1.6 + (fall < .35 ? .4 * sin(PI * fall / .35) : 0);
  // The spin slows while it stands, then the lean circles faster and faster as it dies away.
  const round = 2 * PI * (u < SPIN ? 3 * u - .95 / SPIN * u * u : 2.05 * SPIN + 1.1 * (u - SPIN) + 1.2 * (u - SPIN) ** 2);
  const R = mul(mul(mul(rotZ(round), rotX(tilt)), rotZ(-round)), rest);
  for (const [length, height] of HOPS) {
    if (u < length) return { R, h: 4 * height * (u / length) * (1 - u / length), x: 0, y: 0 };
    u -= length;
  }
  return { R, h: 0, x: 0, y: 0 };
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * PI);
  ctx.fillStyle = fill;
  ctx.fill();
}

function face(ctx: CanvasRenderingContext2D, tails: boolean, mark: Logo | null) {
  disc(ctx, 0, 0, 1, COPPER.face);
  ctx.beginPath();
  ctx.arc(0, 0, .89, 0, 2 * PI);
  ctx.lineWidth = .018;
  ctx.strokeStyle = COPPER.rim;
  ctx.stroke();
  disc(ctx, 0, 0, .78, COPPER.recess);
  const well = ctx.createLinearGradient(-.6, -.6, .6, .6);
  well.addColorStop(0, COPPER.wellLight);
  well.addColorStop(1, COPPER.wellDark);
  ctx.save();
  ctx.clip();
  disc(ctx, .025, .035, .78, well);
  ctx.restore();
  for (const [dx, dy, main, minor] of [[.03, .04, COPPER.shadow, COPPER.shadow], [0, 0, COPPER.relief, COPPER.reliefMinor]] as const) {
    ctx.save();
    ctx.translate(dx, dy);
    if (tails) {
      ctx.scale(.0105, .0105);
      ctx.font = `700 100px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = main;
      ctx.fillText("$", 0, 4);
    } else if (mark) {
      ctx.scale(.0031, .0031);
      ctx.translate(-172, -155.5);
      for (const piece of mark) {
        ctx.fillStyle = piece.minor ? minor : main;
        ctx.fill(piece.path);
      }
    }
    ctx.restore();
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, turn: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turn);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  for (let i = 1; i <= 4; i += 1) ctx.quadraticCurveTo(0, 0, size * sin(i * PI / 2), -size * cos(i * PI / 2));
  ctx.fill();
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, t: number, tails: boolean, mark: Logo | null) {
  const { R, h, x: shakeX, y: shakeY } = pose(t, tails);
  const e1 = [R[0], R[3]];
  const e2 = [R[1], R[4]];
  const facing = R[8] >= 0 ? 1 : -1;
  const centre = SIZE / 2;

  // The outline of a thick disc: both faces, and the wall between the points where each is widest across the offset.
  const solid = (x: number, y: number, r: number, fill: string) => {
    const dx = R[2] * THICKNESS * r / 2 * facing;
    const dy = R[5] * THICKNESS * r / 2 * facing;
    ctx.fillStyle = ctx.strokeStyle = fill;
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.transform(r * e1[0], r * e1[1], r * e2[0], r * e2[1], x + side * dx, y + side * dy);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, 2 * PI);
      ctx.restore();
      ctx.fill();
    }
    if (hypot(dx, dy) < .05) return [dx, dy];
    const widest = Math.atan2(e2[0] * -dy + e2[1] * dx, e1[0] * -dy + e1[1] * dx);
    const px = r * (e1[0] * cos(widest) + e2[0] * sin(widest));
    const py = r * (e1[1] * cos(widest) + e2[1] * sin(widest));
    ctx.beginPath();
    ctx.moveTo(x - dx + px, y - dy + py);
    ctx.lineTo(x + dx + px, y + dy + py);
    ctx.lineTo(x + dx - px, y + dy - py);
    ctx.lineTo(x - dx - px, y - dy - py);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return [dx, dy];
  };

  ctx.clearRect(0, 0, SIZE, SIZE);
  const lift = max(0, h);
  solid(centre + 10 + 95 * lift, centre + 14 + 125 * lift, RADIUS * (1 + .12 * lift), "#000");

  const r = RADIUS * (1 + h);
  const x = centre + shakeX;
  const y = centre - 30 * lift + shakeY;
  const lean = hypot(R[2], R[5]);
  const lit = lean ? .5 - facing * (R[2] * LIGHT[0] + R[5] * LIGHT[1]) / lean / 2 : .5;
  const [dx, dy] = solid(x, y, r, mix(COPPER.edgeDark, COPPER.edgeLight, lit));

  ctx.save();
  ctx.transform(r * e1[0], r * e1[1], r * e2[0], r * e2[1], x + dx, y + dy);
  if (facing < 0) ctx.scale(1, -1);
  face(ctx, facing < 0, mark);
  disc(ctx, 0, 0, 1, `rgba(${COPPER.tilt.join(", ")}, ${(1 - Math.abs(R[8])) * .3})`);
  ctx.restore();

  const since = t - (HOLD + WINDUP + FLIGHT + LANDED_AFTER);
  if (since < 0 || since > SPARKLE) return;
  STARS.forEach(([sx, sy, size], i) => {
    const life = ((since - i * .17 + 9) % 1.2) / .6;
    if (life >= 1 || since < i * .17) return;
    ctx.fillStyle = i % 2 ? COPPER.rim : COPPER.face;
    star(ctx, centre + sx * RADIUS, centre + sy * RADIUS, size * RADIUS * sin(PI * life), life);
  });
}

/** onToss is called as the coin leaves for the air, onLand once it has fallen flat. */
export function CoinToss({ winner, onToss, onLand }: { winner: Side; onToss: () => void; onLand: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const told = useRef({ onToss, onLand });
  told.current = { onToss, onLand };

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    // Backing pixels match what is on screen: the stage's --fit scale times the display's pixel ratio.
    const fit = Number(getComputedStyle(document.documentElement).getPropertyValue("--fit")) || 1;
    const ratio = min(3, max(1, fit * window.devicePixelRatio));
    element.width = element.height = Math.round(SIZE * ratio);
    let mark: Logo | null = null;
    loadLogo().then((loaded) => { mark = loaded; }, () => {});
    const start = performance.now();
    const pending = [[HOLD + WINDUP, "onToss"], [HOLD + WINDUP + FLIGHT + LANDED_AFTER, "onLand"]] as [number, "onToss" | "onLand"][];
    let frame = 0;
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(ctx, t, winner === "tails", mark);
      while (pending.length && t >= pending[0][0]) told.current[pending.shift()![1]]();
      if (t < HOLD + WINDUP + FLIGHT + LANDED_AFTER + SPARKLE + .1) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [winner]);

  return <canvas ref={canvas} style={{ position: "absolute", left: "50%", top: "50%", width: SIZE, height: SIZE, transform: "translate(-50%, -50%)" }} role="img" aria-label="Coin toss" />;
}
