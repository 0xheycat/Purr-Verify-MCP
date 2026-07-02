"use client";

import { useMemo, useState } from "react";
import { BarChart3, Clock, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Bar, BarChart, Line, LineChart, XAxis, YAxis, CartesianGrid } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Job } from "@/lib/verify/types";

// ── Chart config ──────────────────────────────────────────────

const activityChartConfig = {
  success: { label: "Success", color: "hsl(160, 84%, 39%)" },
  failed: { label: "Failed", color: "hsl(350, 89%, 60%)" },
  other: { label: "Other", color: "hsl(215, 20%, 65%)" },
} satisfies ChartConfig;

const durationChartConfig = {
  avgDuration: { label: "Avg Duration (s)", color: "hsl(38, 92%, 50%)" },
} satisfies ChartConfig;

// ── Helpers ───────────────────────────────────────────────────

function dayKey(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shortDayLabel(dayStr: string): string {
  if (dayStr === "unknown") return "?";
  const parts = dayStr.split("-");
  return `${parts[1]}/${parts[2]}`;
}

// ── Component ─────────────────────────────────────────────────

export function JobTimeline({ jobs }: { jobs: Job[] }) {
  const [open, setOpen] = useState(true);

  // Build activity data: last 7 days, success/failed/other stacked bars
  const { activityData, durationData } = useMemo(() => {
    // Get last 7 days as keys
    const days: string[] = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      );
    }

    // Group jobs by day (using startedAt or queuedAt as fallback)
    const byDay: Record<string, { success: number; failed: number; other: number; durations: number[] }> = {};
    for (const day of days) {
      byDay[day] = { success: 0, failed: 0, other: 0, durations: [] };
    }

    for (const job of jobs) {
      const key = dayKey(job.startedAt || job.queuedAt);
      if (!byDay[key]) continue; // outside the 7-day window
      if (job.status === "success") {
        byDay[key].success++;
      } else if (job.status === "failed" || job.status === "timeout") {
        byDay[key].failed++;
      } else if (job.status === "canceled") {
        byDay[key].other++;
      }
      // running/queued jobs don't have duration yet
      if (job.durationMs != null && job.durationMs > 0) {
        byDay[key].durations.push(job.durationMs);
      }
    }

    const activityData = days.map((day) => ({
      day,
      label: shortDayLabel(day),
      success: byDay[day]?.success ?? 0,
      failed: byDay[day]?.failed ?? 0,
      other: byDay[day]?.other ?? 0,
    }));

    const durationData = days
      .map((day) => {
        const entry = byDay[day];
        const avg =
          entry && entry.durations.length > 0
            ? Math.round(entry.durations.reduce((a, b) => a + b, 0) / entry.durations.length / 100) / 10
            : 0;
        return {
          day,
          label: shortDayLabel(day),
          avgDuration: avg,
        };
      })
      .filter((d) => d.avgDuration > 0);

    return { activityData, durationData };
  }, [jobs]);

  const hasEnoughData = jobs.length >= 2;
  const totalInWindow = activityData.reduce((sum, d) => sum + d.success + d.failed + d.other, 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-xl p-[1px] bg-gradient-to-r from-amber-500/20 to-orange-500/20">
        <Card className="border-0 shadow-none">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between gap-2 p-4 pb-0 text-left hover:opacity-80 transition-opacity">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-semibold">Job Activity Timeline</span>
                {totalInWindow > 0 && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    {totalInWindow} in 7 days
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
                    {!hasEnoughData ? (
                      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                        <BarChart3 className="animate-float-y mb-2 h-8 w-8 opacity-30" />
                        <p className="text-sm font-medium">Not enough data yet</p>
                        <p className="text-xs mt-1">
                          Run at least 2 jobs to see activity trends.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {/* Activity bar chart */}
                        <div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <BarChart3 className="h-3.5 w-3.5 text-amber-500" />
                            <span className="text-xs font-medium text-muted-foreground">
                              Jobs per day
                            </span>
                          </div>
                          <ChartContainer
                            config={activityChartConfig}
                            className="h-[180px] w-full"
                          >
                            <BarChart data={activityData} barCategoryGap="20%">
                              <CartesianGrid vertical={false} strokeDasharray="3 3" />
                              <XAxis
                                dataKey="label"
                                tickLine={false}
                                axisLine={false}
                                tickMargin={8}
                                className="text-[11px]"
                              />
                              <YAxis
                                tickLine={false}
                                axisLine={false}
                                allowDecimals={false}
                                width={28}
                                className="text-[11px]"
                              />
                              <ChartTooltip
                                content={<ChartTooltipContent />}
                              />
                              <ChartLegend
                                content={<ChartLegendContent />}
                              />
                              <Bar
                                dataKey="success"
                                stackId="activity"
                                fill="var(--color-success)"
                                radius={[0, 0, 0, 0]}
                              />
                              <Bar
                                dataKey="failed"
                                stackId="activity"
                                fill="var(--color-failed)"
                                radius={[0, 0, 0, 0]}
                              />
                              <Bar
                                dataKey="other"
                                stackId="activity"
                                fill="var(--color-other)"
                                radius={[4, 4, 0, 0]}
                              />
                            </BarChart>
                          </ChartContainer>
                        </div>

                        {/* Duration trend line chart */}
                        {durationData.length >= 2 && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <Clock className="h-3.5 w-3.5 text-amber-500" />
                              <span className="text-xs font-medium text-muted-foreground">
                                Average duration trend (seconds)
                              </span>
                            </div>
                            <ChartContainer
                              config={durationChartConfig}
                              className="h-[140px] w-full"
                            >
                              <LineChart data={durationData}>
                                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                                <XAxis
                                  dataKey="label"
                                  tickLine={false}
                                  axisLine={false}
                                  tickMargin={8}
                                  className="text-[11px]"
                                />
                                <YAxis
                                  tickLine={false}
                                  axisLine={false}
                                  width={36}
                                  className="text-[11px]"
                                />
                                <ChartTooltip
                                  content={<ChartTooltipContent />}
                                />
                                <Line
                                  type="monotone"
                                  dataKey="avgDuration"
                                  stroke="var(--color-avgDuration)"
                                  strokeWidth={2}
                                  dot={{ r: 3, fill: "var(--color-avgDuration)" }}
                                  activeDot={{ r: 5 }}
                                />
                              </LineChart>
                            </ChartContainer>
                          </div>
                        )}
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
