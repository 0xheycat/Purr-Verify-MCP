"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, CheckCircle2, Clock, Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { Job, JobStatus } from "@/lib/verify/types";

/**
 * Sparkline — a tiny 7-point SVG trend line, positioned as a decorative
 * element in the bottom-right of a stat card. The points are deterministic
 * (seeded from the stat value) so they stay consistent across re-renders
 * while looking random. Low opacity (0.15) keeps them unobtrusive.
 */
function Sparkline({ value, color }: { value: number; color: string }) {
  // Deterministic pseudo-random points seeded from value
  const points = useMemo(() => {
    const seed = value * 2654435761; // Knuth multiplicative hash
    const pts: number[] = [];
    for (let i = 0; i < 7; i++) {
      const x = ((seed * (i + 1) * 13 + 37) >>> 0) % 80 + 10; // 10–90 range
      pts.push(x);
    }
    return pts;
  }, [value]);

  const w = 60;
  const h = 28;
  const step = w / (points.length - 1);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  const pathD = points
    .map((p, i) => {
      const x = i * step;
      const y = h - ((p - min) / range) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="pointer-events-none absolute bottom-2 right-2 h-7 w-14"
      style={{ opacity: 0.15 }}
      aria-hidden="true"
    >
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

const STATUS_COLORS: Record<JobStatus, string> = {
  success: "bg-emerald-500",
  failed: "bg-rose-500",
  running: "bg-amber-500",
  queued: "bg-orange-400",
  canceled: "bg-zinc-400",
  timeout: "bg-orange-500",
};

const STATUS_ORDER: JobStatus[] = ["success", "failed", "timeout", "canceled", "running", "queued"];

/**
 * useCountUp — animates a number from 0 → target over 600ms using
 * requestAnimationFrame with an ease-out cubic curve. The animation is
 * triggered the first time `target` becomes non-zero (so it works even
 * when the underlying data loads asynchronously after mount). Subsequent
 * changes to `target` snap to the new value without re-animating.
 *
 * Implementation note: the snap is scheduled via requestAnimationFrame
 * (rather than called synchronously in the effect body) to satisfy the
 * `react-hooks/set-state-in-effect` lint rule.
 */
function useCountUp(target: number, duration = 600): number {
  const [value, setValue] = useState(0);
  const animatingRef = useRef(false);

  useEffect(() => {
    if (animatingRef.current) {
      // Subsequent target change: snap to the new value. Schedule via
      // rAF to avoid calling setState synchronously inside the effect.
      const raf = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(raf);
    }
    if (target === 0) return; // wait for real data
    animatingRef.current = true;

    const to = target;
    let raf = 0;
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const elapsed = ts - start;
      const t = Math.min(1, elapsed / duration);
      // Ease-out cubic: 1 - (1 - t)^3
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(to * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

function AnimatedNumber({ value, suffix = "" }: { value: number; suffix?: string }) {
  const animated = useCountUp(value);
  return (
    <span className="animate-count-up text-2xl font-bold tabular-nums">
      {animated}
      {suffix}
    </span>
  );
}

export function JobStats({ jobs }: { jobs: Job[] }) {
  const stats = useMemo(() => {
    const total = jobs.length;
    const finished = jobs.filter(
      (j) => j.status === "success" || j.status === "failed" || j.status === "canceled" || j.status === "timeout"
    );
    const successes = jobs.filter((j) => j.status === "success").length;
    const successRate = finished.length > 0 ? Math.round((successes / finished.length) * 100) : 0;
    const durationsWithMs = jobs.filter((j) => j.durationMs != null) as { durationMs: number }[];
    const avgDuration =
      durationsWithMs.length > 0
        ? durationsWithMs.reduce((sum, j) => sum + j.durationMs, 0) / durationsWithMs.length
        : null;
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

    const byStatus: Record<JobStatus, number> = {
      success: 0,
      failed: 0,
      running: 0,
      queued: 0,
      canceled: 0,
      timeout: 0,
    };
    for (const j of jobs) {
      byStatus[j.status]++;
    }

    return { total, successRate, avgDuration, active, byStatus };
  }, [jobs]);

  const maxBarCount = Math.max(1, ...Object.values(stats.byStatus));

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {/* Total Jobs */}
      <Card className="border-0 shadow-none overflow-hidden group">
        <div className="card-hover-lift relative h-full rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 p-4 dark:from-amber-950/30 dark:to-orange-950/20 border border-amber-200/50 dark:border-amber-900/40">
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-amber-500/0 to-orange-500/0 group-hover:from-amber-500/5 group-hover:to-orange-500/5 transition-all duration-300" />
          <Sparkline value={stats.total} color="#f59e0b" />
          <div className="relative flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <BarChart3 className="h-4 w-4" />
            <span className="text-[11px] font-medium uppercase tracking-wide">Total Jobs</span>
          </div>
          <div className="relative mt-1.5">
            <AnimatedNumber value={stats.total} />
          </div>
        </div>
      </Card>

      {/* Success Rate */}
      <Card className="border-0 shadow-none overflow-hidden group">
        <div className="card-hover-lift relative h-full rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 p-4 dark:from-emerald-950/30 dark:to-teal-950/20 border border-emerald-200/50 dark:border-emerald-900/40">
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-emerald-500/0 to-teal-500/0 group-hover:from-emerald-500/5 group-hover:to-teal-500/5 transition-all duration-300" />
          <Sparkline value={stats.successRate} color="#10b981" />
          <div className="relative flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-[11px] font-medium uppercase tracking-wide">Success Rate</span>
          </div>
          <div className="relative mt-1.5 flex items-end gap-2">
            <AnimatedNumber value={stats.successRate} suffix="%" />
          </div>
          {/* Mini progress bar */}
          <div className="relative mt-2 h-1.5 w-full rounded-full bg-emerald-100 dark:bg-emerald-900/40">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-400 transition-all duration-500"
              style={{ width: `${stats.successRate}%` }}
            />
          </div>
        </div>
      </Card>

      {/* Average Duration — non-numeric when null, so render as-is */}
      <Card className="border-0 shadow-none overflow-hidden group">
        <div className="card-hover-lift relative h-full rounded-xl bg-gradient-to-br from-teal-50 to-emerald-50 p-4 dark:from-teal-950/30 dark:to-emerald-950/20 border border-teal-200/50 dark:border-teal-900/40">
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-teal-500/0 to-emerald-500/0 group-hover:from-teal-500/5 group-hover:to-emerald-500/5 transition-all duration-300" />
          <Sparkline value={stats.avgDuration ? Math.round(stats.avgDuration / 1000) : 0} color="#14b8a6" />
          <div className="relative flex items-center gap-2 text-teal-600 dark:text-teal-400">
            <Clock className="h-4 w-4" />
            <span className="text-[11px] font-medium uppercase tracking-wide">Avg Duration</span>
          </div>
          <div className="relative mt-1.5 animate-count-up text-2xl font-bold tabular-nums">
            {fmtDuration(stats.avgDuration)}
          </div>
        </div>
      </Card>

      {/* Active Jobs */}
      <Card className={`border-0 shadow-none overflow-hidden group${stats.active > 0 ? " animate-glow-pulse" : ""}`}>
        <div className="card-hover-lift relative h-full rounded-xl bg-gradient-to-br from-orange-50 to-amber-50 p-4 dark:from-orange-950/30 dark:to-amber-950/20 border border-orange-200/50 dark:border-orange-900/40">
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-orange-500/0 to-amber-500/0 group-hover:from-orange-500/5 group-hover:to-amber-500/5 transition-all duration-300" />
          <Sparkline value={stats.active} color="#f97316" />
          <div className="relative flex items-center gap-2 text-orange-600 dark:text-orange-400">
            <Activity className="h-4 w-4" />
            <span className="text-[11px] font-medium uppercase tracking-wide">Active</span>
          </div>
          <div className="relative mt-1.5 flex items-end gap-2">
            <AnimatedNumber value={stats.active} />
            {stats.active > 0 && (
              <span className="relative mb-1.5 flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-orange-500" />
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* Mini bar chart by status */}
      <Card className="border-0 shadow-none overflow-hidden col-span-2 sm:col-span-1 group">
        <div className="card-hover-lift relative h-full rounded-xl bg-gradient-to-br from-rose-50 to-orange-50 p-4 dark:from-rose-950/30 dark:to-orange-950/20 border border-rose-200/50 dark:border-rose-900/40">
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-rose-500/0 to-orange-500/0 group-hover:from-rose-500/5 group-hover:to-orange-500/5 transition-all duration-300" />
          <Sparkline value={stats.byStatus.failed} color="#f43f5e" />
          <div className="relative flex items-center gap-2 text-rose-600 dark:text-rose-400">
            <BarChart3 className="h-4 w-4" />
            <span className="text-[11px] font-medium uppercase tracking-wide">By Status</span>
          </div>
          <div className="relative mt-2 flex items-end gap-1 h-8">
            {STATUS_ORDER.map((status) => {
              const count = stats.byStatus[status];
              const pct = maxBarCount > 0 ? (count / maxBarCount) * 100 : 0;
              return (
                <div key={status} className="group/bar relative flex flex-1 flex-col items-center">
                  <div
                    className={`w-full rounded-t-sm transition-all duration-300 ${STATUS_COLORS[status]} opacity-80 group-hover/bar:opacity-100 animate-grow-up`}
                    style={{ height: `${Math.max(pct, 4)}%`, minHeight: count > 0 ? 4 : 2 }}
                  />
                  {/* Tooltip */}
                  <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 scale-0 group-hover/bar:scale-100 transition-transform rounded bg-popover px-1.5 py-0.5 text-[10px] font-medium text-popover-foreground shadow-md border whitespace-nowrap z-20">
                    {status}: {count}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="relative mt-1.5 flex gap-1">
            {STATUS_ORDER.map((status) => (
              <div key={status} className="flex-1 text-center">
                <div className={`mx-auto h-1.5 w-1.5 rounded-full ${STATUS_COLORS[status]}`} />
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}
