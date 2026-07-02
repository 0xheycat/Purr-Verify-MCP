"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Grid3x3, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Job } from "@/lib/verify/types";

// ── Constants ─────────────────────────────────────────────────

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
// Every-2-hour column labels (rendered with col-span-2 over the 24 hour
// columns so each label visually centers over its 2-hour block).
const HOUR_LABELS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22] as const;

// 5 intensity buckets → 5 legend swatches. Buckets: 0, 1-2, 3-5, 6-9, 10+.
const LEGEND_TINTS = [
  "bg-amber-500/10",
  "bg-amber-500/30",
  "bg-amber-500/50",
  "bg-amber-500/70",
  "bg-amber-500/90",
] as const;

// Human-readable bucket range for each legend swatch tooltip.
const LEGEND_RANGES = [
  "0 jobs",
  "1–2 jobs",
  "3–5 jobs",
  "6–9 jobs",
  "10+ jobs",
] as const;

// Minimum count for a cell to be considered a clear "peak". Below this
// threshold we don't render the pulse ring (avoids noise on sparse data).
const PEAK_MIN_COUNT = 3;

// ── Helpers ───────────────────────────────────────────────────

function cellColor(count: number): string {
  if (count <= 0) return LEGEND_TINTS[0];
  if (count <= 2) return LEGEND_TINTS[1];
  if (count <= 5) return LEGEND_TINTS[2];
  if (count <= 9) return LEGEND_TINTS[3];
  return LEGEND_TINTS[4];
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Initialize the collapsible's open state from the job count, but only
 * after jobs have been loaded (the parent receives `jobs = []` initially
 * and loads the real list asynchronously). The setState is deferred via
 * requestAnimationFrame to satisfy the `react-hooks/set-state-in-effect`
 * lint rule (same pattern used by useCountUp in JobStats).
 */
function useInitialOpen(jobs: Job[], threshold: number): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    if (jobs.length >= threshold) {
      initRef.current = true;
      const raf = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(raf);
    }
  }, [jobs.length, threshold]);
  return [open, setOpen];
}

// ── Component ─────────────────────────────────────────────────

export function DurationHeatmap({ jobs }: { jobs: Job[] }) {
  const [open, setOpen] = useInitialOpen(jobs, 2);

  const { grid, total, peak } = useMemo(() => {
    // 7 days × 24 hours, all zero.
    const g: number[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => 0)
    );
    let t = 0;
    for (const job of jobs) {
      if (!job.startedAt) continue;
      const d = new Date(job.startedAt);
      if (Number.isNaN(d.getTime())) continue;
      // ISO weekday: JS getDay() returns 0=Sun..6=Sat. Convert to 0=Mon..6=Sun.
      const dow = (d.getDay() + 6) % 7;
      // Hour-of-day in UTC (per spec — keep simple, ignore tz).
      const hour = d.getUTCHours();
      if (hour < 0 || hour > 23) continue;
      g[dow][hour]++;
      t++;
    }
    // Find the peak cell (the one with the most jobs). Only returned when
    // it has at least PEAK_MIN_COUNT so we don't pulse on a single job.
    let maxCount = 0;
    let peakCell: { dayIdx: number; hour: number } | null = null;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (g[d][h] > maxCount) {
          maxCount = g[d][h];
          peakCell = { dayIdx: d, hour: h };
        }
      }
    }
    return {
      grid: g,
      total: t,
      peak: maxCount >= PEAK_MIN_COUNT ? peakCell : null,
    };
  }, [jobs]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl p-[1px] bg-gradient-to-r from-amber-500/30 via-orange-500/20 to-amber-500/30 animate-gradient-shift shadow-sm">
        <Card className="border-0 shadow-none">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between gap-2 p-4 pb-0 text-left hover:opacity-80 transition-opacity">
              <div className="flex items-center gap-2">
                <Grid3x3 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-semibold">Activity Heatmap</span>
                {total > 0 && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    {total} job{total !== 1 ? "s" : ""}
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
                    {total === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                        <Grid3x3 className="animate-float-y mb-2 h-8 w-8 opacity-30" />
                        <p className="text-sm font-medium">Not enough data yet</p>
                        <p className="text-xs mt-1">
                          Run a few jobs to see when you&apos;re most active.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3 rounded-lg bg-gradient-to-br from-amber-50/30 to-transparent p-2 dark:from-amber-950/10">
                        {/* Heatmap grid — horizontal scroll on small screens,
                            row labels stay sticky on the left. */}
                        <div
                          className="overflow-x-auto [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-amber-500/30 [&::-webkit-scrollbar-thumb:hover]:bg-amber-500/50 [&::-webkit-scrollbar-track]:bg-transparent"
                        >
                          <div
                            className="inline-grid min-w-full gap-0.5"
                            style={{
                              gridTemplateColumns:
                                "32px repeat(24, minmax(14px, 1fr))",
                            }}
                          >
                            {/* Header row: empty corner + 12 hour labels (each col-span-2) */}
                            <div />
                            {HOUR_LABELS.map((h) => (
                              <div
                                key={h}
                                className="col-span-2 border-b border-amber-200/40 pb-1.5 text-center font-mono text-[10px] font-semibold text-muted-foreground dark:border-amber-900/40"
                              >
                                {h}
                              </div>
                            ))}
                            {/* 7 day rows */}
                            {DAY_LABELS.map((day, dayIdx) => (
                              <DayRow
                                key={day}
                                day={day}
                                dayIdx={dayIdx}
                                counts={grid[dayIdx]}
                                peak={peak}
                              />
                            ))}
                          </div>
                        </div>

                        {/* Legend — each swatch has a `title` tooltip showing its bucket range */}
                        <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground">
                          <span>Less</span>
                          {LEGEND_TINTS.map((c, i) => (
                            <span
                              key={c}
                              title={LEGEND_RANGES[i]}
                              className={cn(
                                "h-3 w-3 rounded-sm border border-border/40 shadow-sm transition-transform duration-150 hover:scale-125",
                                c
                              )}
                            />
                          ))}
                          <span>More</span>
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
  );
}

// ── Sub-components ────────────────────────────────────────────

function DayRow({
  day,
  dayIdx,
  counts,
  peak,
}: {
  day: string;
  dayIdx: number;
  counts: number[];
  peak: { dayIdx: number; hour: number } | null;
}) {
  // Track row hover so we can tint the entire row when the day label
  // (or any cell in it) is hovered — a small but delightful cue that
  // the row is a coherent unit of data.
  const [hovered, setHovered] = useState(false);
  return (
    <>
      {/* Sticky left label — stays visible while the grid scrolls
          horizontally on mobile. bg-card ensures hour cells don't
          show through underneath the label. Hovering highlights the
          entire row via the `hovered` state. */}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "sticky left-0 z-10 flex items-center bg-card pr-1 text-[10px] font-bold transition-colors duration-150",
          hovered
            ? "text-amber-900 dark:text-amber-200"
            : "text-amber-700/80 dark:text-amber-400/80"
        )}
      >
        {day}
      </div>
      {counts.map((count, hour) => {
        const isPeak =
          peak != null && peak.dayIdx === dayIdx && peak.hour === hour;
        return (
          <div
            key={hour}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className={cn(
              "relative h-5 rounded-sm transition-all duration-200 hover:scale-110 hover:ring-2 hover:ring-amber-400/50 hover:z-10",
              cellColor(count),
              hovered && !isPeak && "ring-1 ring-amber-300/30",
              isPeak && "animate-peak-ring ring-1 ring-amber-500/60"
            )}
            title={
              isPeak
                ? `Peak: ${day} ${pad(hour)}:00 — ${count} job${count !== 1 ? "s" : ""}`
                : `${day} ${pad(hour)}:00 — ${count} job${count !== 1 ? "s" : ""}`
            }
          />
        );
      })}
    </>
  );
}
