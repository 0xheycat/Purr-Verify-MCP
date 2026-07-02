"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Github, ChevronDown, Clock, CheckCircle2, Activity, Layers } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Job } from "@/lib/verify/types";

interface RepoStat {
  repo: string;
  total: number;
  finished: number;
  successes: number;
  successRate: number; // 0-100, rounded; 0 if no finished jobs
  avgDurationMs: number | null;
  lastRunAt: string | null; // most recent startedAt or queuedAt
}

// Internal accumulator used while aggregating jobs by repo. After we finish
// iterating, we compute successRate / avgDurationMs and drop the running
// sums so the externally visible type stays clean.
interface RepoAccumulator extends RepoStat {
  sumMs: number;
  countMs: number;
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

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Stroke + text color for the circular ring based on success rate.
function rateRing(rate: number): { stroke: string; text: string; bg: string; bar: string } {
  if (rate >= 80) {
    return {
      stroke: "#10b981", // emerald-500
      text: "text-emerald-600 dark:text-emerald-400",
      bg: "from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20",
      bar: "bg-gradient-to-r from-emerald-400 to-teal-400",
    };
  }
  if (rate >= 50) {
    return {
      stroke: "#f59e0b", // amber-500
      text: "text-amber-600 dark:text-amber-400",
      bg: "from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/20",
      bar: "bg-gradient-to-r from-amber-400 to-orange-400",
    };
  }
  return {
    stroke: "#f43f5e", // rose-500
    text: "text-rose-600 dark:text-rose-400",
    bg: "from-rose-50 to-pink-50 dark:from-rose-950/30 dark:to-pink-950/20",
    bar: "bg-gradient-to-r from-rose-400 to-pink-400",
  };
}

// Count-up hook (mirrors the one in JobStats — small enough to duplicate
// inline per the spec rather than extracting to a shared module).
// The snap is scheduled via requestAnimationFrame rather than called
// synchronously in the effect body, to satisfy the
// `react-hooks/set-state-in-effect` lint rule.
function useCountUp(target: number, duration = 600): number {
  const [value, setValue] = useState(0);
  const animatingRef = useRef(false);
  useEffect(() => {
    if (animatingRef.current) {
      const raf = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(raf);
    }
    if (target === 0) return;
    animatingRef.current = true;
    const to = target;
    let raf = 0;
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const elapsed = ts - start;
      const t = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(to * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

// Circular progress ring with an animated stroke-dashoffset transition.
// Size 60x60, stroke-width 6, viewport-flipped Y so the ring fills from
// the top (12 o'clock) clockwise.
function SuccessRing({ rate, color }: { rate: number; color: string }) {
  const size = 60;
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Offset that leaves `rate` percent of the circle visible.
  const offset = circumference - (rate / 100) * circumference;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      aria-label={`${rate}% success`}
      role="img"
    >
      {/* Background track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-muted/40 dark:text-muted/30"
      />
      {/* Foreground arc — animates via CSS transition on stroke-dashoffset. */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        // Start fully empty, transition to the target offset on mount.
        style={{
          strokeDashoffset: offset,
          transform: "rotate(-90deg)",
          transformOrigin: "center",
          transition: "stroke-dashoffset 1s ease-out 0.2s",
        }}
      />
    </svg>
  );
}

export function RepoStats({ jobs }: { jobs: Job[] }) {
  const [open, setOpen] = useState(true);

  const stats = useMemo<RepoStat[]>(() => {
    const byRepo = new Map<string, RepoAccumulator>();
    for (const j of jobs) {
      const existing =
        byRepo.get(j.repo) ?? {
          repo: j.repo,
          total: 0,
          finished: 0,
          successes: 0,
          successRate: 0,
          avgDurationMs: null,
          lastRunAt: null,
          sumMs: 0,
          countMs: 0,
        };
      existing.total++;
      const isFinished =
        j.status === "success" ||
        j.status === "failed" ||
        j.status === "canceled" ||
        j.status === "timeout";
      if (isFinished) existing.finished++;
      if (j.status === "success") existing.successes++;

      // Running sum of durations across finished jobs (for average).
      if (isFinished && typeof j.durationMs === "number") {
        existing.sumMs += j.durationMs;
        existing.countMs++;
      }

      // Track last run time (most recent startedAt or queuedAt).
      const ts = j.startedAt || j.queuedAt;
      if (ts && (!existing.lastRunAt || ts > existing.lastRunAt)) {
        existing.lastRunAt = ts;
      }

      byRepo.set(j.repo, existing);
    }
    // Finalize derived values and strip the accumulator fields.
    const out: RepoStat[] = [];
    for (const s of byRepo.values()) {
      out.push({
        repo: s.repo,
        total: s.total,
        finished: s.finished,
        successes: s.successes,
        successRate:
          s.finished > 0 ? Math.round((s.successes / s.finished) * 100) : 0,
        avgDurationMs:
          s.countMs > 0 ? Math.round(s.sumMs / s.countMs) : null,
        lastRunAt: s.lastRunAt,
      });
    }
    // Sort by total jobs descending; tie-break by repo name asc.
    out.sort((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));
    return out;
  }, [jobs]);

  const totalRepos = stats.length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl p-[1px] bg-gradient-to-r from-amber-500/30 via-orange-500/20 to-amber-500/30 animate-gradient-shift shadow-sm">
        <Card className="border-0 shadow-none">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between gap-2 p-4 pb-0 text-left hover:opacity-80 transition-opacity">
              <div className="flex items-center gap-2">
                <Github className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-semibold">Per-Repo Stats</span>
                {totalRepos > 0 && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    {totalRepos} repo{totalRepos !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform duration-200",
                  open && "rotate-180"
                )}
              />
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                >
                  <CardContent className="pt-3 pb-4">
                    {totalRepos === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                        <div className="mb-3 rounded-full bg-amber-500/5 p-4">
                          <Layers className="animate-float-y h-10 w-10 text-amber-500/60 dark:text-amber-400/50" />
                        </div>
                        <p className="text-sm font-medium text-foreground/80">No repos yet</p>
                        <p className="mt-1 max-w-[16rem] text-center text-xs">
                          Run a verification to see per-repo statistics.
                        </p>
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {stats.map((s, i) => (
                          <RepoCard key={s.repo} stat={s} delay={Math.min(i * 0.04, 0.3)} />
                        ))}
                      </div>
                    )}
                  </CardContent>
                </motion.div>
              )}
            </AnimatePresence>
          </CollapsibleContent>
        </Card>
      </div>
    </Collapsible>
  );
}

function RepoCard({ stat, delay }: { stat: RepoStat; delay: number }) {
  const colors = rateRing(stat.successRate);
  const animatedRate = useCountUp(stat.successRate);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay }}
    >
      <Card className="border-0 shadow-none overflow-hidden h-full group">
        <div className={cn(
          "card-hover-lift relative h-full rounded-xl border bg-gradient-to-br p-4 transition-colors duration-200",
          colors.bg,
          "border-amber-200/50 dark:border-amber-900/40 group-hover:border-amber-400/80 dark:group-hover:border-amber-600/60"
        )}>
          {/* Hover gradient overlay */}
          <div className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-br from-amber-500/0 to-orange-500/0 group-hover:from-amber-500/10 group-hover:to-orange-500/10 transition-all duration-300" />

          {/* Header */}
          <div className="relative flex items-center gap-2">
            <Github className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
            <span className="truncate text-xs font-semibold" title={stat.repo}>
              {stat.repo}
            </span>
          </div>

          {/* Ring + center number on left, label + bar on right */}
          <div className="relative mt-3 flex items-center gap-3">
            <div className="relative shrink-0" style={{ width: 60, height: 60 }}>
              <SuccessRing rate={stat.successRate} color={colors.stroke} />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className={cn("animate-count-up text-sm font-bold tabular-nums", colors.text)}>
                  {animatedRate}
                  <span className="text-[10px]">%</span>
                </span>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                success rate
              </div>
              {/* Mini progress bar (kept for visual rhythm) */}
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted/50 dark:bg-muted/30">
                <div
                  className={cn("h-full rounded-full transition-all duration-500", colors.bar)}
                  style={{ width: `${stat.successRate}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <CheckCircle2 className={cn("h-2.5 w-2.5", colors.text)} />
                <span>
                  {stat.successes}/{stat.finished} finished succeeded
                </span>
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className="relative mt-3 grid grid-cols-3 gap-2 text-[11px]">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Layers className="h-2.5 w-2.5" />
                Total
              </span>
              <span className="font-semibold">{stat.total}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-2.5 w-2.5" />
                Avg
              </span>
              <span className="font-semibold">{fmtDuration(stat.avgDurationMs)}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Activity className="h-2.5 w-2.5" />
                Last
              </span>
              {/* Last-run timestamp is intentionally more subtle than the
                  main success-rate number so it doesn’t compete for attention. */}
              <span className="font-semibold opacity-70" title={stat.lastRunAt ?? ""}>
                {fmtRelative(stat.lastRunAt)}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </motion.div>
  );
}
