"use client";

import { CheckCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const MAP: Record<string, { label: string; className: string; dot: string }> = {
  queued: { label: "Queued", className: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900", dot: "bg-amber-500" },
  running: { label: "Running", className: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/60 dark:text-orange-300 dark:border-orange-900", dot: "bg-orange-500" },
  success: { label: "Success", className: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900", dot: "bg-emerald-500" },
  failed: { label: "Failed", className: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900", dot: "bg-rose-500" },
  canceled: { label: "Canceled", className: "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700", dot: "bg-zinc-400" },
  timeout: { label: "Timeout", className: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/60 dark:text-orange-300 dark:border-orange-900", dot: "bg-orange-500" },
  pending: { label: "Pending", className: "bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-400 dark:border-zinc-700", dot: "bg-zinc-300" },
  skipped: { label: "Skipped", className: "bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-400 dark:border-zinc-700", dot: "bg-zinc-300" },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const m = MAP[status] || MAP.pending;
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-medium transition-transform duration-150 hover:scale-105",
        m.className,
        status === "running" && "animate-status-pulse",
        status === "success" && "animate-flash-green",
        status === "failed" && "animate-shake-subtle",
        className
      )}
    >
      {status === "running" ? (
        // Three bouncing dots indicator (uses ::before/::after pseudo-elements).
        <span className="dot-loading align-middle" aria-hidden="true" />
      ) : status === "success" ? (
        <CheckCircle className="h-3 w-3 animate-scale-in" aria-hidden="true" />
      ) : status === "failed" ? (
        <XCircle className="h-3 w-3 animate-shake-subtle" aria-hidden="true" />
      ) : (
        <span className={cn("h-2 w-2 rounded-full animate-scale-in", m.dot)} />
      )}
      {m.label}
    </Badge>
  );
}
