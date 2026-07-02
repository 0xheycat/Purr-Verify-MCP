"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalSquare, Terminal, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Job } from "@/lib/verify/types";

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

function rateClasses(rate: number): { text: string; bar: string } {
  if (rate >= 80) {
    return {
      text: "text-emerald-600 dark:text-emerald-400",
      bar: "bg-gradient-to-r from-emerald-400 to-teal-400",
    };
  }
  if (rate >= 50) {
    return {
      text: "text-amber-600 dark:text-amber-400",
      bar: "bg-gradient-to-r from-amber-400 to-orange-400",
    };
  }
  return {
    text: "text-rose-600 dark:text-rose-400",
    bar: "bg-gradient-to-r from-rose-400 to-pink-400",
  };
}

// Internal accumulator used while aggregating commands. Finalized into
// CommandStat (with derived successRate / avgDurationMs) after iteration.
interface CommandAgg {
  command: string;
  total: number;
  success: number;
  failed: number;
  timeout: number;
  skipped: number;
  ranCount: number; // commands with a non-null, positive durationMs
  durationSum: number;
}

interface CommandStat extends CommandAgg {
  successRate: number; // 0-100, rounded; 0 if no terminal runs
  avgDurationMs: number | null;
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

export function PerCommandStats({ jobs }: { jobs: Job[] }) {
  const [open, setOpen] = useInitialOpen(jobs, 1);

  const stats = useMemo<CommandStat[]>(() => {
    const map = new Map<string, CommandAgg>();
    for (const job of jobs) {
      for (const c of job.commands) {
        const existing = map.get(c.command) ?? {
          command: c.command,
          total: 0,
          success: 0,
          failed: 0,
          timeout: 0,
          skipped: 0,
          ranCount: 0,
          durationSum: 0,
        };
        existing.total++;
        if (c.status === "success") existing.success++;
        else if (c.status === "failed") existing.failed++;
        else if (c.status === "timeout") existing.timeout++;
        else if (c.status === "skipped") existing.skipped++;
        if (typeof c.durationMs === "number" && c.durationMs > 0) {
          existing.ranCount++;
          existing.durationSum += c.durationMs;
        }
        map.set(c.command, existing);
      }
    }
    const out: CommandStat[] = [];
    for (const s of map.values()) {
      // Success rate denominator: only commands that reached a terminal
      // state (success / failed / timeout). Pending / running / skipped
      // commands don't count toward the rate.
      const runTotal = s.success + s.failed + s.timeout;
      out.push({
        ...s,
        successRate: runTotal > 0 ? Math.round((s.success / runTotal) * 100) : 0,
        avgDurationMs: s.ranCount > 0 ? Math.round(s.durationSum / s.ranCount) : null,
      });
    }
    // Sort by total occurrences descending; tie-break by command string asc.
    out.sort((a, b) => b.total - a.total || a.command.localeCompare(b.command));
    return out;
  }, [jobs]);

  const uniqueCount = stats.length;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl p-[1px] bg-gradient-to-r from-amber-500/30 via-orange-500/20 to-amber-500/30 animate-gradient-shift shadow-sm">
        <Card className="border-0 shadow-none">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between gap-2 p-4 pb-0 text-left hover:opacity-80 transition-opacity">
              <div className="flex items-center gap-2">
                <TerminalSquare className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-semibold">Per-Command Stats</span>
                {uniqueCount > 0 && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    {uniqueCount} unique command{uniqueCount !== 1 ? "s" : ""}
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
                    {uniqueCount === 0 ? (
                      <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                        <div className="mb-3 rounded-full bg-amber-500/5 p-4">
                          <Terminal className="animate-float-y h-10 w-10 text-amber-500/60 dark:text-amber-400/50" />
                        </div>
                        <p className="text-sm font-medium text-foreground/80">No commands run yet</p>
                        <p className="mt-1 max-w-[18rem] text-center text-xs">
                          Run a verification to see which commands succeed and fail most often.
                        </p>
                      </div>
                    ) : (
                      <div className="max-h-96 overflow-auto rounded-md border border-border/40 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-amber-500/30 [&::-webkit-scrollbar-thumb:hover]:bg-amber-500/50 [&::-webkit-scrollbar-track]:bg-transparent">
                        <table className="w-full caption-bottom text-sm">
                          <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:border-b [&_th]:border-border/60 [&_th]:bg-card/85 [&_th]:backdrop-blur-sm [&_th]:sticky-shadow">
                            <TableRow className="hover:bg-transparent">
                              <TableHead className="h-9 pl-3 text-[11px] uppercase tracking-wide text-muted-foreground">
                                Command
                              </TableHead>
                              <TableHead className="h-9 text-[11px] uppercase tracking-wide text-muted-foreground text-right">
                                Total
                              </TableHead>
                              <TableHead className="h-9 text-[11px] uppercase tracking-wide text-muted-foreground">
                                Success Rate
                              </TableHead>
                              <TableHead className="h-9 text-[11px] uppercase tracking-wide text-muted-foreground text-right">
                                Avg Duration
                              </TableHead>
                              <TableHead className="h-9 text-[11px] uppercase tracking-wide text-muted-foreground text-right">
                                Failed
                              </TableHead>
                              <TableHead className="h-9 pr-3 text-[11px] uppercase tracking-wide text-muted-foreground text-right">
                                Timeout
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {stats.map((s, idx) => {
                              const colors = rateClasses(s.successRate);
                              return (
                                <TableRow
                                  key={s.command}
                                  className="transition-colors duration-150 hover:bg-amber-50/40 dark:hover:bg-amber-950/10"
                                >
                                  <TableCell className="py-2 pl-3 max-w-[180px] sm:max-w-[260px]">
                                    <div className="flex items-center gap-1.5">
                                      {idx < 3 && (
                                        <span
                                          title={`#${idx + 1} most-used command`}
                                          className={cn(
                                            "h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/10",
                                            idx === 0 && "bg-amber-500 animate-glow-pulse",
                                            idx === 1 && "bg-amber-700",
                                            idx === 2 && "bg-orange-700"
                                          )}
                                        />
                                      )}
                                      <Terminal className="h-3 w-3 shrink-0 text-amber-500/70 dark:text-amber-400/70" />
                                      <code
                                        className="block truncate font-mono text-[11px] font-medium text-foreground"
                                        title={s.command}
                                      >
                                        {s.command}
                                      </code>
                                    </div>
                                  </TableCell>
                                  <TableCell className="py-2 text-right text-xs font-medium tabular-nums">
                                    {s.total}
                                  </TableCell>
                                  <TableCell className="py-2">
                                    <div className="flex items-center gap-2">
                                      <div className="relative h-1.5 w-12 min-w-[36px] rounded-full bg-muted/60 dark:bg-muted/30">
                                        <div
                                          className={cn(
                                            "relative h-full overflow-hidden rounded-full transition-all duration-500",
                                          colors.bar
                                          )}
                                          style={{ width: `${s.successRate}%` }}
                                        >
                                          {s.successRate === 100 && (
                                            <span
                                              className="shimmer-success-overlay"
                                              aria-hidden="true"
                                            />
                                          )}
                                        </div>
                                      </div>
                                      <span
                                        className={cn(
                                          "text-xs font-mono font-bold tabular-nums",
                                          colors.text
                                        )}
                                      >
                                        {s.successRate}%
                                      </span>
                                    </div>
                                  </TableCell>
                                  <TableCell className="py-2 text-right text-xs tabular-nums text-muted-foreground">
                                    {fmtDuration(s.avgDurationMs)}
                                  </TableCell>
                                  <TableCell className="py-2 text-right text-xs tabular-nums">
                                    {s.failed > 0 ? (
                                      <span className="text-rose-600 dark:text-rose-400">
                                        {s.failed}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground/60">0</span>
                                    )}
                                  </TableCell>
                                  <TableCell className="py-2 pr-3 text-right text-xs tabular-nums">
                                    {s.timeout > 0 ? (
                                      <span className="text-orange-600 dark:text-orange-400">
                                        {s.timeout}
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground/60">0</span>
                                    )}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </table>
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
