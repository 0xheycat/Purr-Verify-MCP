"use client";

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { getHealth } from "@/lib/verify/client";
import type { HealthResponse } from "@/lib/verify/types";
import { cn } from "@/lib/utils";

export function HealthBadge() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await getHealth();
        if (alive) {
          setHealth(h);
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const ok = health?.status === "ok" && !err;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium shadow-sm",
        ok
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
          : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300"
      )}
      title={health ? `active=${health.activeJobs} queued=${health.queuedJobs} total=${health.totalJobs}` : "unreachable"}
    >
      <span className="relative flex h-2.5 w-2.5">
        {ok && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2.5 w-2.5 rounded-full",
            ok ? "bg-emerald-500" : "bg-rose-500"
          )}
        />
      </span>
      <Activity className="h-3.5 w-3.5" />
      <span className="font-semibold">{ok ? "Operational" : "Unreachable"}</span>
      {health && (
        <span className="opacity-70">
          · {health.activeJobs} active · {health.queuedJobs} queued
        </span>
      )}
    </div>
  );
}
