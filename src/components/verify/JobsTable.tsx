"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Eye, Loader2, RefreshCw, Inbox, Search, Star, X, Trash2, Trash, Download, FileJson, FileSpreadsheet, GitCompare, Tag as TagIcon, ChevronRight, Calendar, Minus } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { StatusBadge } from "./StatusBadge";
import { JobsTableSkeleton } from "./Skeleton";
import { CompareJobs } from "./CompareJobs";
import { cancelJob, getJobMarkdown, getQueuePosition, deleteJob, deleteAllJobs } from "@/lib/verify/client";
import type { Job, CommandResult } from "@/lib/verify/types";
import { toggleFavorite, useFavorites } from "@/lib/verify/favorites";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

function fmtElapsed(startedAt: string | null): string {
  if (!startedAt) return "—";
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Tiny sparkline SVG showing command durations for a finished job.
function DurationSparkline({ commands }: { commands: CommandResult[] }) {
  const durations = commands
    .map((c) => c.durationMs)
    .filter((d): d is number => d != null && d > 0);
  if (durations.length < 2) return null;

  const w = 48;
  const h = 16;
  const max = Math.max(...durations);
  const min = Math.min(...durations);
  const range = max - min || 1;

  const points = durations.map((d, i) => {
    const x = (i / (durations.length - 1)) * (w - 4) + 2;
    const y = h - 2 - ((d - min) / range) * (h - 4);
    return `${x},${y}`;
  });

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="inline-block shrink-0 opacity-70"
      aria-hidden="true"
    >
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-amber-500"
      />
    </svg>
  );
}

function overallExit(job: Job): string {
  const failed = job.commands.find((c) => c.exitCode != null && c.exitCode !== 0);
  if (failed) return String(failed.exitCode);
  if (job.status === "success") return "0";
  return "—";
}

// Date-range filter options. The values are kept compact so they render
// cleanly inside the Select trigger alongside the calendar icon.
type DateRangeKey = "all" | "24h" | "7d" | "30d";

const DATE_RANGE_MS: Record<Exclude<DateRangeKey, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// Compact row of tag pills. If more than `max` tags, render the first `max`
// and a "+N" indicator instead of expanding the row.
function RowTags({ tags, max = 3 }: { tags: string[] | undefined; max?: number }) {
  if (!tags || tags.length === 0) {
    return <span className="text-[10px] text-muted-foreground/50">—</span>;
  }
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((t) => (
        <span
          key={t}
          className="inline-block max-w-[8rem] truncate rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
          title={t}
        >
          {t}
        </span>
      ))}
      {extra > 0 && (
        <span className="inline-block rounded-full bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
          +{extra}
        </span>
      )}
    </div>
  );
}

export function JobsTable({
  jobs,
  onSelect,
  refreshKey,
  onRefresh,
  loading = false,
}: {
  jobs: Job[];
  onSelect: (jobId: string) => void;
  refreshKey: number;
  onRefresh?: () => void;
  loading?: boolean;
}) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [copiedMd, setCopiedMd] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRangeKey>("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Live elapsed time counter
  const [tick, setTick] = useState(0);
  // Queue positions keyed by jobId (only for currently-queued jobs).
  const [queuePositions, setQueuePositions] = useState<Record<string, number | null>>({});

  // Favorite job IDs (localStorage-backed, updates live via the custom event).
  const favorites = useFavorites();
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  // Notify other components (e.g., the CommandPalette) whenever the
  // favorites filter is toggled, and listen for external toggle requests.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("purr-verify-favorites-filter-changed", { detail: { active: favoritesOnly } })
    );
  }, [favoritesOnly]);
  useEffect(() => {
    const handler = () => setFavoritesOnly((v) => !v);
    window.addEventListener("purr-verify-toggle-favorites-filter", handler);
    return () => window.removeEventListener("purr-verify-toggle-favorites-filter", handler);
  }, []);

  // Tick every second when any job is running
  useEffect(() => {
    const hasRunning = jobs.some((j) => j.status === "running");
    if (!hasRunning) return;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [jobs]);

  // Poll queue positions every 2s while any job is queued.
  useEffect(() => {
    const queuedIds = jobs.filter((j) => j.status === "queued").map((j) => j.jobId);
    if (queuedIds.length === 0) {
      // Clear stale positions when nothing is queued.
      setQueuePositions({});
      return;
    }
    let cancelled = false;
    const fetchPositions = async () => {
      const entries = await Promise.all(
        queuedIds.map(async (id) => {
          try {
            const info = await getQueuePosition(id);
            return [id, info.position] as const;
          } catch {
            return [id, null] as const;
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, number | null> = {};
      for (const [id, pos] of entries) next[id] = pos;
      setQueuePositions(next);
    };
    void fetchPositions();
    const iv = setInterval(fetchPositions, 2000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [jobs]);

  const cancel = async (jobId: string) => {
    setCancelling(jobId);
    try {
      const res = await cancelJob(jobId);
      toast.success(`Cancel requested: ${res.status}`);
      onRefresh?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCancelling(null);
    }
  };

  const handleDelete = async (jobId: string) => {
    setDeleting(jobId);
    try {
      await deleteJob(jobId);
      toast.success(`Job ${jobId.slice(0, 8)} deleted`);
      onRefresh?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  const handleClearFinished = async () => {
    setClearing(true);
    try {
      const res = await deleteAllJobs();
      toast.success(`Cleared ${res.deleted} finished jobs`);
      onRefresh?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setClearing(false);
    }
  };

  const copyMd = async (jobId: string) => {
    try {
      const md = await getJobMarkdown(jobId);
      await navigator.clipboard.writeText(md);
      setCopiedMd(jobId);
      toast.success("Markdown copied to clipboard");
      setTimeout(() => setCopiedMd(null), 1500);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const hasActive = jobs.some((j) => j.status === "running" || j.status === "queued");
  const finishedCount = jobs.filter(
    (j) => j.status !== "running" && j.status !== "queued"
  ).length;

  const filteredJobs = useMemo(() => {
    let result = jobs;
    // Date range filter — uses queuedAt (falls back to finishedAt when
    // queuedAt is missing, which shouldn't happen in practice but keeps
    // the filter forgiving for legacy jobs).
    if (dateRange !== "all") {
      const cutoff = Date.now() - DATE_RANGE_MS[dateRange];
      result = result.filter((j) => {
        const tsStr = j.queuedAt || j.finishedAt;
        if (!tsStr) return false;
        const ts = new Date(tsStr).getTime();
        if (Number.isNaN(ts)) return false;
        return ts >= cutoff;
      });
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (j) =>
          j.repo.toLowerCase().includes(q) ||
          j.ref.toLowerCase().includes(q) ||
          j.jobId.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== "all") {
      result = result.filter((j) => j.status === statusFilter);
    }
    if (tagFilter !== "all") {
      result = result.filter((j) => (j.tags ?? []).some((t) => t.toLowerCase() === tagFilter.toLowerCase()));
    }
    if (favoritesOnly) {
      result = result.filter((j) => favoriteSet.has(j.jobId));
    }
    return result;
  }, [jobs, searchQuery, statusFilter, tagFilter, dateRange, favoritesOnly, favoriteSet]);

  // Collect all unique tags across visible jobs for the tag filter dropdown.
  const uniqueTags = useMemo(() => {
    const set = new Set<string>();
    for (const j of jobs) {
      for (const t of j.tags ?? []) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [jobs]);

  const hasFilters = searchQuery.trim() !== "" || statusFilter !== "all" || tagFilter !== "all" || dateRange !== "all" || favoritesOnly;

  // ── Export helpers ──────────────────────────────────
  const exportJSON = useCallback(() => {
    const data = JSON.stringify(filteredJobs, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `purr-verify-jobs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filteredJobs.length} jobs as JSON`);
  }, [filteredJobs]);

  const exportCSV = useCallback(() => {
    const headers = ["Job ID", "Repo", "Ref", "Status", "Exit Code", "Duration (ms)", "Started At", "Finished At", "PR", "Purpose"];
    const escapeCSV = (val: string) => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };
    const rows = filteredJobs.map((job) => {
      const exitCode = overallExit(job);
      return [
        job.jobId,
        job.repo,
        job.ref,
        job.status,
        exitCode,
        job.durationMs != null ? String(job.durationMs) : "",
        job.startedAt ?? "",
        job.finishedAt ?? "",
        job.metadata?.pr ? String(job.metadata.pr) : "",
        job.metadata?.purpose ? String(job.metadata.purpose) : "",
      ].map(escapeCSV).join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `purr-verify-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filteredJobs.length} jobs as CSV`);
  }, [filteredJobs]);

  // Suppress unused variable warning
  void tick;
  void refreshKey;

  // ── Bulk selection helpers ──────────────────────────────────────────
  const toggleSelect = useCallback((jobId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredJobs.map((j) => j.jobId)));
  }, [filteredJobs]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const allFilteredSelected = filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.jobId));

  const handleBulkCancel = async () => {
    const toCancel = filteredJobs.filter(
      (j) => selectedIds.has(j.jobId) && (j.status === "running" || j.status === "queued")
    );
    if (toCancel.length === 0) {
      toast.info("No running/queued jobs selected");
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const j of toCancel) {
      try {
        await cancelJob(j.jobId);
        ok++;
      } catch {
        fail++;
      }
    }
    toast.success(`Canceled ${ok} job${ok !== 1 ? "s" : ""}${fail > 0 ? ` (${fail} failed)` : ""}`);
    deselectAll();
    onRefresh?.();
  };

  const handleBulkDelete = async () => {
    const toDelete = filteredJobs.filter(
      (j) => selectedIds.has(j.jobId) && j.status !== "running" && j.status !== "queued"
    );
    if (toDelete.length === 0) {
      toast.info("No deletable jobs selected");
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const j of toDelete) {
      try {
        await deleteJob(j.jobId);
        ok++;
      } catch {
        fail++;
      }
    }
    toast.success(`Deleted ${ok} job${ok !== 1 ? "s" : ""}${fail > 0 ? ` (${fail} failed)` : ""}`);
    deselectAll();
    onRefresh?.();
  };

  return (
    <div className="space-y-3 relative">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Recent jobs</h2>
          {hasActive && (
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-orange-500" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasFilters ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
              {filteredJobs.length} of {jobs.length} jobs
            </span>
          ) : (
            <p className="text-xs text-muted-foreground">
              {jobs.length} total
            </p>
          )}
          {finishedCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs text-rose-600 hover:text-rose-700"
              disabled={clearing}
              onClick={handleClearFinished}
            >
              {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash className="h-3.5 w-3.5" />}
              Clear finished
            </Button>
          )}
          {filteredJobs.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 text-xs">
                  <Download className="h-3.5 w-3.5" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={exportJSON}>
                  <FileJson className="h-4 w-4" />
                  Export JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={exportCSV}>
                  <FileSpreadsheet className="h-4 w-4" />
                  Export CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {jobs.length >= 2 && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => setShowCompare(true)}
            >
              <GitCompare className="h-3.5 w-3.5" />
              Compare
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-2" onClick={onRefresh}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={favoritesOnly ? "default" : "outline"}
          size="sm"
          className={cn(
            "h-8 gap-1.5 px-2 text-xs transition-all",
            favoritesOnly
              ? "bg-amber-500 text-white hover:bg-amber-600 shadow-sm shadow-amber-500/20"
              : "text-muted-foreground hover:text-amber-700 hover:border-amber-300 dark:hover:text-amber-300 dark:hover:border-amber-700"
          )}
          onClick={() => setFavoritesOnly((v) => !v)}
          aria-pressed={favoritesOnly}
          title={favoritesOnly ? "Showing only favorites — click to show all" : "Show only favorite jobs"}
        >
          <Star
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              favoritesOnly && "fill-white",
              !favoritesOnly && favoriteSet.size > 0 && "fill-amber-400 text-amber-500"
            )}
          />
          <span className="hidden sm:inline">{favoritesOnly ? "Favorites on" : "Favorites"}</span>
          {favoriteSet.size > 0 && (
            <span
              className={cn(
                "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-mono",
                favoritesOnly ? "bg-white/20" : "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
              )}
            >
              {favoriteSet.size}
            </span>
          )}
        </Button>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search repo / ref…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="running">Running</SelectItem>
            <SelectItem value="queued">Queued</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="canceled">Canceled</SelectItem>
            <SelectItem value="timeout">Timeout</SelectItem>
          </SelectContent>
        </Select>
        <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRangeKey)}>
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3 w-3 text-amber-500" />
              <SelectValue placeholder="Date" />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
        {dateRange !== "all" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setDateRange("all")}
            aria-label="Clear date filter"
            title="Clear date filter"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
        {uniqueTags.length > 0 && (
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="h-8 w-[150px] text-xs">
              <span className="flex items-center gap-1.5">
                <TagIcon className="h-3 w-3 text-amber-500" />
                <SelectValue placeholder="Tag" />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {uniqueTags.map((t) => (
                <SelectItem key={t} value={t.toLowerCase()}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs"
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("all");
              setTagFilter("all");
              setDateRange("all");
              setFavoritesOnly(false);
            }}
          >
            <X className="h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border transition-shadow hover:shadow-md">
        <div className="max-h-[28rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-2.5 text-center font-medium w-9">
                  <Checkbox
                    checked={allFilteredSelected ? true : selectedIds.size > 0 ? "indeterminate" : false}
                    onCheckedChange={(checked) => {
                      if (checked === true) selectAll();
                      else deselectAll();
                    }}
                    aria-label="Select all jobs"
                    className="mx-auto"
                  />
                </th>
                <th className="px-3 py-2.5 text-left font-medium">Job</th>
                <th className="px-3 py-2.5 text-left font-medium">Repo / Ref</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium">Tags</th>
                <th className="px-3 py-2.5 text-left font-medium">Exit</th>
                <th className="px-3 py-2.5 text-left font-medium">Duration</th>
                <th className="px-3 py-2.5 text-left font-medium">Started</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && jobs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-0">
                    <JobsTableSkeleton />
                  </td>
                </tr>
              ) : jobs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-16 text-center text-muted-foreground">
                    <div className="animate-fade-in-up">
                      <div className="animate-empty-bounce rounded-full bg-amber-500/5 p-6 mx-auto mb-4 w-fit">
                        <Inbox className="h-14 w-14 opacity-25" />
                      </div>
                      <div className="text-sm font-medium">No jobs found</div>
                      <div className="mt-1 text-xs">
                        {hasFilters
                          ? "Try adjusting your filters to see more results."
                          : "Submit a verification above to get started."}
                      </div>
                      {!hasFilters && (
                        <div className="mt-2 text-[11px] text-muted-foreground/80">
                          <span className="font-medium text-amber-600 dark:text-amber-400">Tip:</span>{" "}
                          Try submitting with commands like <code className="rounded bg-muted/60 px-1 py-0 font-mono text-[10px]">bun install</code> and{" "}
                          <code className="rounded bg-muted/60 px-1 py-0 font-mono text-[10px]">bun test</code>.
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ) : filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-16 text-center text-muted-foreground">
                    <div className="animate-fade-in-up">
                      <div className="animate-empty-bounce mx-auto mb-4 w-fit rounded-full bg-amber-500/5 p-6">
                        <Search className="h-14 w-14 text-amber-500/40 dark:text-amber-400/30" />
                      </div>
                      <div className="text-sm font-medium text-foreground/80">
                        No jobs match your filters
                      </div>
                      <div className="mt-1 text-xs">
                        Try clearing them to see all jobs.
                      </div>
                      <div className="mt-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 text-xs"
                          onClick={() => {
                            setSearchQuery("");
                            setStatusFilter("all");
                            setTagFilter("all");
                            setDateRange("all");
                          }}
                        >
                          <X className="h-3 w-3" />
                          Clear filters
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredJobs.map((job, rowIdx) => {
                  const active = job.status === "running" || job.status === "queued";
                  const isFinished = !active;
                  return (
                    <tr
                      key={job.jobId}
                      className={cn(
                        "group cursor-pointer transition-all duration-150 hover:bg-amber-50/40 dark:hover:bg-amber-950/10 border-l-2 border-l-transparent hover:border-l-amber-400 hover:shadow-[inset_2px_0_0_0_rgba(251,191,36,0.35)] dark:hover:border-l-amber-600 animate-row-fade-in row-slide-hover",
                        rowIdx % 2 === 1 && "bg-muted/10",
                        selectedIds.has(job.jobId) && "bg-amber-50/60 dark:bg-amber-950/20 border-l-amber-400 dark:border-l-amber-600"
                      )}
                      style={{
                        animationDelay: `${Math.min(rowIdx * 30, 300)}ms`,
                        animationFillMode: "both",
                      }}
                      onClick={() => onSelect(job.jobId)}
                    >
                      <td className="px-2 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(job.jobId)}
                          onCheckedChange={() => toggleSelect(job.jobId)}
                          aria-label={`Select job ${job.jobId.slice(0, 8)}`}
                          className="mx-auto"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const nowFav = toggleFavorite(job.jobId);
                              toast.success(nowFav ? "Added to favorites" : "Removed from favorites", {
                                description: job.jobId.slice(0, 8),
                              });
                            }}
                            aria-label={favoriteSet.has(job.jobId) ? `Remove ${job.jobId.slice(0, 8)} from favorites` : `Add ${job.jobId.slice(0, 8)} to favorites`}
                            title={favoriteSet.has(job.jobId) ? "Remove from favorites" : "Add to favorites"}
                            className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-all hover:scale-110 hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                          >
                            <Star
                              className={cn(
                                "h-3.5 w-3.5 transition-all",
                                favoriteSet.has(job.jobId)
                                  ? "fill-amber-400 text-amber-500"
                                  : "text-muted-foreground/60"
                              )}
                            />
                          </button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="text-left font-mono text-xs text-foreground hover:text-amber-600 dark:hover:text-amber-400 transition-colors cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelect(job.jobId);
                                }}
                                aria-label={`Open job ${job.jobId}`}
                              >
                                {job.jobId.slice(0, 8)}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-[20rem] p-3 text-left normal-case">
                              <div className="space-y-1">
                                <div className="font-mono text-[10px] text-primary-foreground/80">{job.jobId}</div>
                                <div className="flex items-center gap-1.5 text-[11px]">
                                  <span className="opacity-60">repo:</span>
                                  <span className="font-medium">{job.repo}</span>
                                </div>
                                <div className="flex items-center gap-1.5 text-[11px]">
                                  <span className="opacity-60">ref:</span>
                                  <code className="font-mono">{job.ref}</code>
                                </div>
                                <div className="flex items-center gap-1.5 text-[11px]">
                                  <span className="opacity-60">started:</span>
                                  <span className="font-mono">{job.startedAt ? new Date(job.startedAt).toLocaleString() : "—"}</span>
                                </div>
                                <div className="flex items-center gap-1.5 text-[11px]">
                                  <span className="opacity-60">first cmd:</span>
                                  <code className="font-mono truncate max-w-[12rem] inline-block align-bottom">
                                    {job.commands[0]?.command ?? "—"}
                                  </code>
                                </div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </div>
                        {job.metadata?.pr && (
                          <div className="ml-5 text-[10px] text-muted-foreground">PR #{String(job.metadata.pr)}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="text-xs font-medium">{job.repo}</div>
                        <div className="max-w-[16rem] truncate font-mono text-[11px] text-muted-foreground">
                          {job.ref}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={job.status} className={cn(job.status === "running" && "animate-status-pulse")} />
                          {job.status === "queued" && queuePositions[job.jobId] != null && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                              #{queuePositions[job.jobId]} in queue
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 max-w-[12rem]">
                        <RowTags tags={job.tags} />
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            "font-mono text-xs",
                            overallExit(job) === "0"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : overallExit(job) === "—"
                              ? "text-muted-foreground"
                              : "text-rose-600 dark:text-rose-400"
                          )}
                        >
                          {overallExit(job)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {job.status === "running" && job.startedAt ? (
                          <span className="text-orange-500 animate-pulse">
                            {fmtElapsed(job.startedAt)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            {fmtDuration(job.durationMs)}
                            {isFinished && <DurationSparkline commands={job.commands} />}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{fmtTime(job.startedAt)}</td>
                      <td className="px-3 py-2.5">
                        <div className="relative flex justify-end items-center gap-0" onClick={(e) => e.stopPropagation()}>
                          {/* Hover chevron — slides in from the right on row hover */}
                          <ChevronRight
                            className="pointer-events-none absolute -left-6 top-1/2 -translate-y-1/2 h-4 w-4 text-amber-500 opacity-0 translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200"
                            aria-hidden="true"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => onSelect(job.jobId)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            View
                          </Button>
                          <span className="h-4 w-px bg-border" />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => copyMd(job.jobId)}
                          >
                            {copiedMd === job.jobId ? "Copied" : "MD"}
                          </Button>
                          {isFinished && (
                            <>
                              <span className="h-4 w-px bg-border" />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs text-rose-600 hover:text-rose-700"
                                disabled={deleting === job.jobId}
                                onClick={() => handleDelete(job.jobId)}
                              >
                                {deleting === job.jobId ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </>
                          )}
                          {active && (
                            <>
                              <span className="h-4 w-px bg-border" />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs text-rose-600 hover:text-rose-700"
                                disabled={cancelling === job.jobId}
                                onClick={() => cancel(job.jobId)}
                              >
                                {cancelling === job.jobId ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Ban className="h-3.5 w-3.5" />
                                )}
                                Cancel
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCompare && (
        <CompareJobs
          jobs={jobs}
          onClose={() => setShowCompare(false)}
          onSelect={(id) => {
            setShowCompare(false);
            onSelect(id);
          }}
        />
      )}

      {/* Floating bulk action bar */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2"
          >
            <div className="flex items-center gap-3 rounded-xl border bg-card/95 backdrop-blur-lg px-4 py-2.5 shadow-lg shadow-amber-500/10 ring-1 ring-amber-500/20">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                {selectedIds.size} selected
              </span>
              {filteredJobs.some((j) => selectedIds.has(j.jobId) && (j.status === "running" || j.status === "queued")) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs text-amber-700 border-amber-200 hover:bg-amber-50 hover:text-amber-800 dark:text-amber-300 dark:border-amber-800 dark:hover:bg-amber-950/40"
                  onClick={handleBulkCancel}
                >
                  <Ban className="h-3.5 w-3.5" />
                  Cancel selected
                </Button>
              )}
              {filteredJobs.some((j) => selectedIds.has(j.jobId) && j.status !== "running" && j.status !== "queued") && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs text-rose-600 border-rose-200 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-950/30"
                  onClick={handleBulkDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete selected
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-muted-foreground"
                onClick={deselectAll}
              >
                <X className="h-3.5 w-3.5" />
                Clear selection
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
