"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  ChevronDown,
  Gauge,
  Zap,
  Hourglass,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Job, JobStatus } from "@/lib/verify/types";

// ── Constants ─────────────────────────────────────────────────

const MAX_POINTS = 20;
const FINISHED_STATUSES: JobStatus[] = ["success", "failed", "canceled", "timeout"];

// Dot colors keyed by status. Only the four finished statuses will
// actually appear on the chart (we filter to those upstream), but the
// full record is kept for type-safety against the JobStatus union.
const STATUS_DOT_COLOR: Record<JobStatus, string> = {
  success: "#10b981", // emerald-500
  failed: "#f43f5e", // rose-500
  canceled: "#71717a", // zinc-500
  timeout: "#f97316", // orange-500
  running: "#f97316", // orange-500
  queued: "#f59e0b", // amber-500 (defensive — never appears here)
};

// ── Helpers ───────────────────────────────────────────────────

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Count-up hook (mirrors the one in JobStats / RepoStats — duplicated
 * inline per the project convention rather than extracting to a shared
 * module). The snap-on-change is scheduled via requestAnimationFrame to
 * satisfy the `react-hooks/set-state-in-effect` lint rule.
 */
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
      // Ease-out cubic: 1 - (1 - t)^3
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(to * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

/**
 * Initialize the collapsible's open state once the finished-job count
 * crosses `threshold`. The setState is deferred via requestAnimationFrame
 * to satisfy the `react-hooks/set-state-in-effect` lint rule (same
 * pattern used by DurationHeatmap / PerCommandStats, but keyed on the
 * finished-job count rather than the raw jobs.length).
 */
function useInitialOpen(
  finishedCount: number,
  threshold: number
): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    if (finishedCount >= threshold) {
      initRef.current = true;
      const raf = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [finishedCount, threshold]);
  return [open, setOpen];
}

// ── Types ─────────────────────────────────────────────────────

interface TrendPoint {
  label: string; // "Job 1", "Job 2", … (x-axis label, oldest→newest)
  index: number; // 1..N
  duration: number; // seconds, 1 decimal (Y-axis value)
  durationMs: number; // raw ms (for tooltip + mini-stats)
  jobId: string;
  shortId: string; // first 8 chars
  repo: string;
  ref: string;
  status: JobStatus;
  finishedAt: string;
}

// Shape injected by recharts into the custom Tooltip content element.
interface TrendTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: TrendPoint }>;
  label?: string | number;
}

// Shape injected by recharts into the Area `dot` render function.
interface DotRenderProps {
  cx?: number;
  cy?: number;
  payload?: TrendPoint;
  index?: number;
}

// ── Component ─────────────────────────────────────────────────

export function DurationTrends({ jobs }: { jobs: Job[] }) {
  // Filter to finished jobs with a positive durationMs and a finishedAt
  // timestamp. Sort newest-first, take the last MAX_POINTS, then reverse
  // so the chart reads oldest → newest left-to-right.
  const { points, finishedCount } = useMemo<{
    points: TrendPoint[];
    finishedCount: number;
  }>(() => {
    const finished = jobs.filter(
      (j) =>
        FINISHED_STATUSES.includes(j.status) &&
        typeof j.durationMs === "number" &&
        j.durationMs > 0 &&
        j.finishedAt
    );
    const sorted = [...finished].sort(
      (a, b) =>
        new Date(b.finishedAt as string).getTime() -
        new Date(a.finishedAt as string).getTime()
    );
    const lastN = sorted.slice(0, MAX_POINTS);
    // Reverse so the chart reads oldest → newest left-to-right.
    const reversed = [...lastN].reverse();
    const pts: TrendPoint[] = reversed.map((j, idx) => {
      const durationMs = j.durationMs as number;
      return {
        label: `Job ${idx + 1}`,
        index: idx + 1,
        duration: Math.round(durationMs / 100) / 10, // seconds, 1 decimal
        durationMs,
        jobId: j.jobId,
        shortId: j.jobId.slice(0, 8),
        repo: j.repo,
        ref: j.ref,
        status: j.status,
        finishedAt: j.finishedAt as string,
      };
    });
    return { points: pts, finishedCount: finished.length };
  }, [jobs]);

  const [open, setOpen] = useInitialOpen(finishedCount, 2);
  const hasEnough = points.length >= 2;

  // Mini-stats: average / fastest / slowest across the visible window.
  const { avgMs, minMs, maxMs } = useMemo(() => {
    if (points.length === 0) return { avgMs: 0, minMs: 0, maxMs: 0 };
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      sum += p.durationMs;
      if (p.durationMs < min) min = p.durationMs;
      if (p.durationMs > max) max = p.durationMs;
    }
    return { avgMs: sum / points.length, minMs: min, maxMs: max };
  }, [points]);

  // Trend direction: compare the average of the first few points (oldest)
  // against the average of the last few points (newest). We need at least
  // 4 points to make the comparison meaningful.
  const trend = useMemo<{ direction: "up" | "down" | "flat" }>(() => {
    if (points.length < 4) return { direction: "flat" };
    const half = Math.floor(points.length / 2);
    const firstSlice = points.slice(0, Math.min(5, half));
    const lastSlice = points.slice(-Math.min(5, half));
    const avg = (arr: TrendPoint[]) =>
      arr.reduce((s, p) => s + p.durationMs, 0) / arr.length;
    const a = avg(firstSlice);
    const b = avg(lastSlice);
    if (a === 0) return { direction: "flat" };
    const pctChange = (b - a) / a;
    if (pctChange > 0.2) return { direction: "up" };
    if (pctChange < -0.2) return { direction: "down" };
    return { direction: "flat" };
  }, [points]);

  const avgAnimated = useCountUp(Math.round(avgMs));
  const minAnimated = useCountUp(Math.round(minMs));
  const maxAnimated = useCountUp(Math.round(maxMs));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.082 }}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="rounded-xl p-[1px] bg-gradient-to-r from-amber-500/20 to-orange-500/20">
          <Card className="border-0 shadow-none">
            <CollapsibleTrigger asChild>
              <button
                className="flex w-full items-center justify-between gap-2 p-4 pb-0 text-left hover:opacity-80 transition-opacity"
                aria-expanded={open}
              >
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <span className="text-sm font-semibold text-gradient-amber">Duration Trends</span>
                  {hasEnough && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      last {points.length} finished job{points.length !== 1 ? "s" : ""}
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
                      {!hasEnough ? (
                        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                          <div className="mb-3 rounded-full bg-amber-500/5 p-4">
                            <TrendingUp className="animate-float-y h-10 w-10 text-amber-500/60 dark:text-amber-400/50" />
                          </div>
                          <p className="text-sm font-medium text-foreground/80">Not enough data yet</p>
                          <p className="mt-1 max-w-[16rem] text-center text-xs">
                            Run at least 2 verification jobs to unlock the duration trend chart.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {/* Trend direction badge — only shown when not flat. Gradient
                              bg + shadow makes it visually distinct from the header pill. */}
                          {trend.direction !== "flat" && (
                            <div className="flex justify-end">
                              {trend.direction === "up" ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-gradient-to-r from-amber-100 to-orange-100 px-2.5 py-0.5 text-[10px] font-semibold text-amber-800 shadow-sm dark:border-amber-700/60 dark:from-amber-900/50 dark:to-orange-900/50 dark:text-amber-200">
                                  <AlertTriangle className="h-3 w-3" />
                                  Trending up ↗
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300/60 bg-gradient-to-r from-emerald-100 to-teal-100 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-800 shadow-sm dark:border-emerald-700/60 dark:from-emerald-900/50 dark:to-teal-900/50 dark:text-emerald-200">
                                  <TrendingDown className="h-3 w-3" />
                                  Improving ↘
                                </span>
                              )}
                            </div>
                          )}

                          {/* Area chart — amber gradient fill, status-colored dots.
                              Wrapped in a subtle gradient-tinted container so the chart
                              reads as a distinct surface within the card. */}
                          <div className="w-full h-[200px] rounded-xl border border-amber-200/40 bg-gradient-to-br from-amber-50/30 via-orange-50/20 to-transparent p-2 dark:border-amber-900/30 dark:from-amber-950/10 dark:via-orange-950/5 animate-fade-in-up">
                            <ResponsiveContainer width="100%" height="100%">
                              <AreaChart
                                data={points}
                                margin={{ top: 6, right: 8, bottom: 0, left: -8 }}
                              >
                                <defs>
                                  <linearGradient
                                    id="durationTrendFill"
                                    x1="0"
                                    y1="0"
                                    x2="0"
                                    y2="1"
                                  >
                                    <stop
                                      offset="0%"
                                      stopColor="#f59e0b"
                                      stopOpacity={0.35}
                                    />
                                    <stop
                                      offset="100%"
                                      stopColor="#f59e0b"
                                      stopOpacity={0}
                                    />
                                  </linearGradient>
                                </defs>
                                <CartesianGrid
                                  vertical={false}
                                  strokeDasharray="3 3"
                                  className="stroke-muted-foreground/20"
                                />
                                <XAxis
                                  dataKey="label"
                                  tickLine={false}
                                  axisLine={false}
                                  tickMargin={8}
                                  className="text-[11px]"
                                  interval="preserveStartEnd"
                                  minTickGap={16}
                                />
                                <YAxis
                                  tickLine={false}
                                  axisLine={false}
                                  width={36}
                                  className="text-[11px]"
                                  tickFormatter={(v: number) => `${v}s`}
                                />
                                <Tooltip
                                  content={<TrendTooltip />}
                                  cursor={{
                                    stroke: "#f59e0b",
                                    strokeWidth: 1,
                                    strokeDasharray: "3 3",
                                  }}
                                />
                                <Area
                                  type="monotone"
                                  dataKey="duration"
                                  stroke="#f59e0b"
                                  strokeWidth={2}
                                  fill="url(#durationTrendFill)"
                                  activeDot={{ r: 5, fill: "#f59e0b", stroke: "white", strokeWidth: 1.5 }}
                                  dot={renderDot}
                                />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>

                          {/* Mini stats row — stacks vertically on < 640px */}
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <MiniStat
                              icon={<Gauge className="h-3.5 w-3.5" />}
                              label={`Avg (last ${points.length})`}
                              value={fmtDuration(avgAnimated)}
                            />
                            <MiniStat
                              icon={<Zap className="h-3.5 w-3.5" />}
                              label="Fastest"
                              value={fmtDuration(minAnimated)}
                            />
                            <MiniStat
                              icon={<Hourglass className="h-3.5 w-3.5" />}
                              label="Slowest"
                              value={fmtDuration(maxAnimated)}
                            />
                          </div>
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
    </motion.div>
  );
}

// ── Sub-components ────────────────────────────────────────────

/**
 * Custom recharts Tooltip content. Receives `active` + `payload` via
 * cloneElement from recharts at runtime. Renders the job short ID,
 * repo, status, duration, and finished timestamp.
 */
function TrendTooltip({ active, payload }: TrendTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-amber-200/60 bg-popover/95 px-3 py-2 text-xs shadow-md backdrop-blur">
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: STATUS_DOT_COLOR[p.status] }}
          aria-hidden="true"
        />
        <code className="font-mono text-[10px] text-muted-foreground">{p.shortId}</code>
      </div>
      <div className="font-medium text-foreground">{p.repo}</div>
      <div className="mt-0.5 text-muted-foreground">
        <span className="capitalize">{p.status}</span> · {fmtDuration(p.durationMs)}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        Finished {fmtDateTime(p.finishedAt)}
      </div>
    </div>
  );
}

/**
 * Per-point dot renderer — colors the dot by job status. emerald for
 * success, rose for failed, orange for timeout, zinc for canceled.
 * Returns an empty <g> when recharts can't compute a position (shouldn't
 * happen for our filtered dataset, but defensive).
 */
function renderDot(dotProps: DotRenderProps) {
  const { cx, cy, payload, index } = dotProps;
  if (cx == null || cy == null || payload == null || index == null) {
    return <g key={`dot-empty-${index ?? "x"}`} />;
  }
  return (
    <circle
      key={`dot-${index}`}
      cx={cx}
      cy={cy}
      r={3.5}
      fill={STATUS_DOT_COLOR[payload.status]}
      stroke="white"
      strokeWidth={1.5}
    />
  );
}

function MiniStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="card-hover-lift flex items-center gap-2 rounded-lg border border-amber-200/40 bg-gradient-to-br from-amber-50/50 to-transparent px-3 py-2 dark:border-amber-900/30 dark:from-amber-950/10">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="animate-count-up font-mono text-sm font-bold tabular-nums text-foreground">
          {value}
        </div>
      </div>
    </div>
  );
}
