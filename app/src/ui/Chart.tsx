//price over time with the volume below it, on one time scale (two charts, never two y axes on one). Plain SVG drawn in
//pixels of the real width (so lines stay 2px), a crosshair with a tooltip on hover or touch, a legend only when there
//is more than one series. Colors come from --chart-* tokens (checked with the dataviz validator, light and dark).
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { clock } from '../lib/format';
import { T, useT } from '../lib/i18n';
import { shownPrice } from './offers';

export interface Pt {
  t: number; //unix seconds
  v: number;
}

export interface Series {
  label: string;
  kind: 'line' | 'dots';
  color: string; //a CSS color, normally var(--chart-...)
  pts: Pt[];
}

interface Props {
  series: Series[];
  bars?: { label: string; color: string; pts: Pt[]; unit: string }; //volume per bucket
  from: number;
  to: number;
  unit: string; //price unit, e.g. "USDT" or "$"
  height?: number;
  empty?: string; //shown when no series has a point
}

const gutter = 52; //left: price labels
const padTop = 10;
const padBottom = 22; //time labels
const barH = 46;

const money = (v: number, unit: string) => (unit === '$' ? `$${shownPrice(v)}` : `${shownPrice(v)} ${unit}`);
const compact = (v: number) => v.toLocaleString('en-US', { notation: v >= 10000 ? 'compact' : 'standard', maximumFractionDigits: v >= 100 ? 0 : 2 });

export function PriceChart({ series, bars, from, to, unit, height = 150, empty }: Props) {
  const { t: tx, f } = useT();
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null); //unix seconds under the pointer
  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const all = series.flatMap((s) => s.pts.filter((p) => p.t >= from && p.t <= to));
  const scale = useMemo(() => {
    let lo = Math.min(...all.map((p) => p.v));
    let hi = Math.max(...all.map((p) => p.v));
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    const pad = hi - lo > 0 ? (hi - lo) * 0.12 : Math.abs(hi) * 0.05 || 1;
    return { lo: lo - pad, hi: hi + pad };
  }, [all.map((p) => p.v).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const plotW = w - gutter;
  const x = (t: number) => gutter + ((t - from) / (to - from)) * plotW;
  const y = (v: number) => padTop + (1 - (v - scale.lo) / (scale.hi - scale.lo)) * (height - padTop - padBottom);
  const ticks = niceTicks(scale.lo, scale.hi, height < 120 ? 3 : 4);
  const timeLabel = (t: number) => (to - from > 2 * 24 * 3600 ? new Date(t * 1000).toLocaleDateString(T().lang, { day: 'numeric', month: 'short' }) : clock(t));

  const barMax = Math.max(1e-12, ...(bars?.pts.map((p) => p.v) ?? [0]));
  const bucket = bars && bars.pts.length > 1 ? bars.pts[1]!.t - bars.pts[0]!.t : 3600;
  const bw = Math.max(2, (bucket / (to - from)) * plotW - 2); //2px surface gap between bars

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < gutter) {
      setHover(null);
      return;
    }
    setHover(from + ((px - gutter) / plotW) * (to - from));
  }

  //what the tooltip says at the hovered time: the line's value at or before it, the nearest dot within 12px, the bar
  const tip = hover === null ? null : tipAt(hover, series, bars, (12 / plotW) * (to - from), bucket);

  if (all.length === 0) {
    return (
      <div className="chart chart-empty" ref={box}>
        <p>{empty ?? tx.trChartEmpty}</p>
      </div>
    );
  }

  return (
    <div className="chart" ref={box}>
      {new Set(series.map((s) => s.label)).size > 1 && (
        <ul className="chart-legend">
          {series.filter((s, i) => series.findIndex((o) => o.label === s.label) === i).map((s) => (
            <li key={s.label}>
              <span className={`swatch ${s.kind}`} style={{ background: s.color }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="chart-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)} onPointerDown={onMove}>
        <svg width={w} height={height} role="img" aria-label={f(tx.trPriceFromTo, { from: timeLabel(from), to: timeLabel(to) })}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={gutter} x2={w} y1={y(v)} y2={y(v)} className="grid" />
              <text x={gutter - 8} y={y(v) + 4} className="tick" textAnchor="end">
                {shownPrice(v)}
              </text>
            </g>
          ))}
          {series.map((s, si) =>
            s.kind === 'line' ? (
              <path key={`${si}-${s.label}`}d={linePath(s.pts.filter((p) => p.t >= from && p.t <= to), x, y)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ) : (
              <g key={`${si}-${s.label}`}>
                {s.pts
                  .filter((p) => p.t >= from && p.t <= to)
                  .map((p, i, shown) => (
                    <circle key={i} cx={x(p.t)} cy={y(p.v)} r={shown.length > 30 ? 3 : 4.5} fill={s.color} className="dot" />
                  ))}
              </g>
            ),
          )}
          {[from, (from + to) / 2, to].map((t, i) => (
            <text key={t} x={i === 0 ? gutter : i === 2 ? w : x(t)} y={height - 5} className="tick" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
              {timeLabel(t)}
            </text>
          ))}
          {tip && <line x1={x(hover!)} x2={x(hover!)} y1={padTop} y2={height - padBottom} className="crosshair" />}
          {tip?.vals.map((v) => v.y !== undefined && <circle key={v.label} cx={x(v.t)} cy={y(v.y)} r={5} fill={v.color} className="dot hot" />)}
        </svg>
        {bars && (
          <svg width={w} height={barH} role="img" aria-label={bars.label}>
            <text x={gutter - 8} y={14} className="tick" textAnchor="end">
              {bars.unit === 'USD' ? `$${compact(barMax)}` : compact(barMax)}
            </text>
            <line x1={gutter} x2={w} y1={barH - 1} y2={barH - 1} className="grid" />
            {bars.pts
              .filter((p) => p.v > 0 && p.t >= from && p.t < to)
              .map((p) => {
                const h = Math.max(2, (p.v / barMax) * (barH - 6));
                return <path key={p.t} d={topRounded(x(p.t) + 1, barH - 1 - h, bw, h)} fill={bars.color} />;
              })}
            {tip && <line x1={x(hover!)} x2={x(hover!)} y1={0} y2={barH} className="crosshair" />}
          </svg>
        )}
        {tip && (
          <div className="chart-tip" style={{ left: Math.min(Math.max(x(hover!), gutter + 70), w - 70) }}>
            <time>{to - from > 2 * 24 * 3600 ? `${timeLabel(hover!)} ${clock(hover!)}` : clock(hover!)}</time>
            {tip.vals.map((v) => (
              <span key={v.label}>
                <i style={{ background: v.color }} aria-hidden />
                {f(tx.trTipLabel, { label: v.label })} <b>{money(v.v, unit)}</b>
              </span>
            ))}
            {tip.bar !== undefined && bars && (
              <span>
                {f(tx.trTipLabel, { label: bars.label })} <b>{compact(tip.bar)} {bars.unit}</b>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function tipAt(t: number, series: Series[], bars: Props['bars'], near: number, bucket: number) {
  const vals: { label: string; color: string; v: number; t: number; y?: number }[] = [];
  for (const s of series) {
    if (s.kind === 'line') {
      const before = [...s.pts].reverse().find((p) => p.t <= t) ?? s.pts[0];
      if (before) {
        vals.push({ label: s.label, color: s.color, v: before.v, t: before.t, y: before.v });
      }
    } else {
      const hit = s.pts.reduce<Pt | null>((best, p) => (Math.abs(p.t - t) <= near && (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) ? p : best), null);
      if (hit) {
        vals.push({ label: s.label, color: s.color, v: hit.v, t: hit.t, y: hit.v });
      }
    }
  }
  const b = bars?.pts.find((p) => t >= p.t && t < p.t + bucket);
  //one row per label: a dot hit (an actual trade) wins over the line under it
  const byLabel = new Map(vals.map((v) => [v.label, v]));
  return { vals: [...byLabel.values()], bar: b?.v };
}

//round values (steps of 1, 2, 2.5 or 5 times a power of ten) inside lo..hi, about `n` of them
function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) {
    return [lo];
  }
  const mag = 10 ** Math.floor(Math.log10(span / n));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

//the last price in each time slot: a line through every trade zigzags when many trade within minutes, this one
//follows the price, and the dots still show each trade
export function lastPerSlot(pts: Pt[], size: number): Pt[] {
  const out = new Map<number, Pt>();
  for (const p of pts) {
    const slot = Math.floor(p.t / size);
    const prev = out.get(slot);
    if (!prev || p.t >= prev.t) {
      out.set(slot, p);
    }
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

function linePath(pts: Pt[], x: (t: number) => number, y: (v: number) => number): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
}

//a bar with 4px rounded top corners, square at the baseline
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

//sums values into fixed buckets from `from` (volume per hour, per day)
export function buckets(pts: Pt[], from: number, to: number, size: number): Pt[] {
  const out: Pt[] = [];
  for (let t = from; t < to; t += size) {
    out.push({ t, v: 0 });
  }
  for (const p of pts) {
    const i = Math.floor((p.t - from) / size);
    if (i >= 0 && i < out.length) {
      out[i]!.v += p.v;
    }
  }
  return out;
}
