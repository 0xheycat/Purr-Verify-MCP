"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  Loader2,
  XCircle,
  Clock,
  AlertTriangle,
  TimerReset,
  Terminal,
  RotateCcw,
  Trash2,
  Webhook,
  Pencil,
  Check,
  X,
  Tag as TagIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { StatusBadge } from "./StatusBadge";
import { JobDetailSkeleton } from "./Skeleton";
import { cancelJob, deleteJob, getJob, getJobMarkdown, getQueuePosition, retryWebhook, streamJob, updateJobTags } from "@/lib/verify/client";
import type { CommandResult, Job, WebhookDelivery } from "@/lib/verify/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SharePanel } from "./SharePanel";
import { JobAnnotations } from "./JobAnnotations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs}s`;
}

function CommandIcon({ status }: { status: string }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-rose-500" />;
    case "timeout":
      return <TimerReset className="h-4 w-4 text-orange-500" />;
    case "skipped":
      return <ChevronDown className="h-4 w-4 text-muted-foreground" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-orange-500" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

function LogBlockCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded px-2 text-[10px] font-medium transition-colors",
        copied
          ? "text-emerald-600"
          : "text-muted-foreground hover:text-foreground"
      )}
      aria-label={copied ? "Copied" : "Copy output"}
    >
      {copied ? (
        <Check className="h-3 w-3" />
      ) : (
        <ClipboardCopy className="h-3 w-3" />
      )}
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function LogBlock({ label, text, tone }: { label: string; text: string; tone: "out" | "err" }) {
  if (!text || !text.trim()) return null;
  const lines = text.split("\n");
  const isLong = lines.length > 20;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground">{lines.length} lines</span>
          <LogBlockCopyButton text={text} />
        </div>
      </div>
      <div
        className={cn(
          "max-h-72 overflow-auto rounded-md border relative",
          tone === "err"
            ? "border-rose-200 bg-rose-50/50 dark:border-rose-900/60 dark:bg-rose-950/20"
            : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40",
          isLong && "log-gradient-overlay"
        )}
      >
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={cn(
                tone === "err"
                  ? "text-rose-900 dark:text-rose-200"
                  : "text-zinc-800 dark:text-zinc-200"
              )}>
                <td className="select-none border-r px-2 py-0 text-right align-top text-[10px] leading-[1.6] text-muted-foreground/40 dark:text-muted-foreground/30 min-w-[2.5rem]">
                  {i + 1}
                </td>
                <td className="px-2.5 py-0 log-viewer leading-[1.6]">
                  {line || " "}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function JobDetail({
  jobId,
  onBack,
}: {
  jobId: string;
  onBack: () => void;
}) {
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [queueInfo, setQueueInfo] = useState<{ position: number | null; totalQueued: number; estimatedWaitMs: number | null } | null>(null);
  // Tag inline editor state
  const [editingTags, setEditingTags] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [pendingTags, setPendingTags] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const sseCleanupRef = useRef<(() => void) | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await getJob(jobId);
      setJob(j);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  // SSE streaming for active jobs; falls back to polling on error.
  useEffect(() => {
    if (!job) return;
    const isActive = job.status === "running" || job.status === "queued";
    if (!isActive) {
      // Clean up any existing SSE/polling for finished jobs.
      if (sseCleanupRef.current) {
        sseCleanupRef.current();
        sseCleanupRef.current = null;
      }
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      setSseConnected(false);
      return;
    }

    // Clean up previous connections.
    if (sseCleanupRef.current) {
      sseCleanupRef.current();
      sseCleanupRef.current = null;
    }
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    let fellBackToPolling = false;

    // Try SSE first.
    const cleanup = streamJob(
      jobId,
      (updatedJob) => {
        setJob(updatedJob);
        setSseConnected(true);
      },
      () => {
        // SSE error — fall back to polling.
        if (!fellBackToPolling) {
          fellBackToPolling = true;
          setSseConnected(false);
          // Start polling as fallback.
          pollingRef.current = setInterval(load, 2500);
        }
      }
    );
    sseCleanupRef.current = cleanup;

    return () => {
      if (sseCleanupRef.current) {
        sseCleanupRef.current();
        sseCleanupRef.current = null;
      }
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      setSseConnected(false);
    };
  }, [job?.status, jobId, load]);

  // Queue position polling: when the job is queued, fetch its position every 2s.
  useEffect(() => {
    const fetchQueue = async () => {
      try {
        const info = await getQueuePosition(jobId);
        setQueueInfo({
          position: info.position,
          totalQueued: info.totalQueued,
          estimatedWaitMs: info.estimatedWaitMs,
        });
      } catch {
        // ignore — best-effort
      }
    };

    if (job?.status === "queued") {
      void fetchQueue();
      queuePollRef.current = setInterval(fetchQueue, 2000);
    } else {
      setQueueInfo(null);
    }
    return () => {
      if (queuePollRef.current) {
        clearInterval(queuePollRef.current);
        queuePollRef.current = null;
      }
    };
  }, [job?.status, jobId]);

  const copyMd = async () => {
    try {
      const md = await getJobMarkdown(jobId);
      await navigator.clipboard.writeText(md);
      setCopied(true);
      toast.success("Verification markdown copied");
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      await cancelJob(jobId);
      toast.success("Cancel requested");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCancelling(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteJob(jobId);
      toast.success("Job deleted");
      onBack();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // ── Tag editing helpers ──────────────────────────────────────────
  const startEditTags = () => {
    setPendingTags(job?.tags ?? []);
    setTagDraft("");
    setEditingTags(true);
    // Focus the input after it renders.
    setTimeout(() => tagInputRef.current?.focus(), 0);
  };

  const cancelEditTags = () => {
    setEditingTags(false);
    setTagDraft("");
    setPendingTags([]);
  };

  const addPendingTag = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (t.length < 1 || t.length > 30) {
      toast.error("Tag must be 1-30 chars");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(t)) {
      toast.error("Tag may only contain letters, numbers, dash and underscore");
      return;
    }
    if (pendingTags.length >= 10) {
      toast.error("Max 10 tags");
      return;
    }
    if (pendingTags.some((existing) => existing.toLowerCase() === t.toLowerCase())) {
      setTagDraft("");
      return;
    }
    setPendingTags((prev) => [...prev, t]);
    setTagDraft("");
  };

  const removePendingTag = (tag: string) => {
    setPendingTags((prev) => prev.filter((t) => t !== tag));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addPendingTag(tagDraft);
    } else if (e.key === "Backspace" && tagDraft === "" && pendingTags.length > 0) {
      e.preventDefault();
      setPendingTags((prev) => prev.slice(0, -1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEditTags();
    }
  };

  const saveTags = async () => {
    setSavingTags(true);
    try {
      const res = await updateJobTags(jobId, pendingTags);
      // Update local job state without a full refetch.
      setJob((prev) => (prev ? { ...prev, tags: res.tags } : prev));
      setEditingTags(false);
      setTagDraft("");
      toast.success(`Saved ${res.tags.length} tag${res.tags.length !== 1 ? "s" : ""}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingTags(false);
    }
  };

  if (loading) {
    return <JobDetailSkeleton />;
  }
  if (error || !job) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error || "Job not found"}
        </div>
      </div>
    );
  }

  const active = job.status === "running" || job.status === "queued";

  // A command is a re-run target for the "failed only" mode if its terminal
  // status is failed / timeout / skipped. Success and still-pending commands
  // are excluded.
  const failedRerunTargets = job.commands.filter(
    (c) => c.status === "failed" || c.status === "timeout" || c.status === "skipped"
  );
  const hasNoFailedRerunTargets = failedRerunTargets.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={copyMd}>
            <ClipboardCopy className="h-4 w-4" />
            {copied ? "Copied!" : "Copy as Markdown"}
          </Button>
          <div className="inline-flex isolate">
            <Button
              variant="outline"
              size="sm"
              className="gap-2 rounded-r-none border-r-0 -mr-px focus-visible:z-10"
              onClick={() => {
                router.push(`/?rerun=${jobId}`);
              }}
            >
              <RotateCcw className="h-4 w-4" />
              Re-run
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-l-none px-2 focus-visible:z-10"
                  aria-label="Re-run options"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  onClick={() => {
                    router.push(`/?rerun=${jobId}`);
                  }}
                >
                  <RotateCcw className="h-4 w-4" />
                  <span>Re-run all</span>
                </DropdownMenuItem>
                {hasNoFailedRerunTargets ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        role="menuitem"
                        aria-disabled="true"
                        className="flex cursor-not-allowed items-center gap-2 rounded-sm px-2 py-1.5 text-sm opacity-50"
                      >
                        <AlertTriangle className="h-4 w-4" />
                        <span>Re-run failed only</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>No failed commands to re-run</TooltipContent>
                  </Tooltip>
                ) : (
                  <DropdownMenuItem
                    onClick={() => {
                      router.push(`/?rerun=${jobId}&filter=failed`);
                    }}
                  >
                    <AlertTriangle className="h-4 w-4" />
                    <span>Re-run failed only</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {!active && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </Button>
          )}
          {active && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 text-rose-600 hover:text-rose-700"
              disabled={cancelling}
              onClick={cancel}
            >
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              Cancel job
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {job.commands.filter((c) => c.status === "success" || c.status === "failed" || c.status === "timeout" || c.status === "skipped").length}/{job.commands.length} commands complete
          </span>
          <span className="font-mono">
            {Math.round(
              (job.commands.filter((c) => c.status === "success" || c.status === "failed" || c.status === "timeout" || c.status === "skipped").length /
                Math.max(job.commands.length, 1)) *
                100
            )}
            %
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
          <div
            className={cn(
              "h-full rounded-full bg-primary transition-all duration-300",
              job.status === "running" && "animate-stripes animate-progress-shimmer"
            )}
            style={{
              width: `${
                (job.commands.filter((c) => c.status === "success" || c.status === "failed" || c.status === "timeout" || c.status === "skipped").length /
                  Math.max(job.commands.length, 1)) *
                100
              }%`,
            }}
          />
        </div>
      </div>

      {/* Summary header */}
      <div className="relative rounded-xl p-[1px] bg-gradient-to-r from-amber-500/30 via-orange-500/20 to-amber-500/30 animate-gradient-shift shadow-sm">
        <div className="rounded-[11px] bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-lg font-semibold">{job.jobId.slice(0, 8)}</h1>
              <StatusBadge
                status={job.status}
                className={cn(
                  (job.status === "success" || job.status === "failed") &&
                    "animate-bounce-in"
                )}
              />
              {job.status === "success" && (
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="text-emerald-500 shrink-0"
                  aria-hidden="true"
                >
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="animate-draw-check"
                  />
                </svg>
              )}
              {sseConnected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping-ring rounded-full bg-emerald-400" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                  Live
                </span>
              )}
              {job.status === "queued" && queueInfo && queueInfo.position != null && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  #{queueInfo.position} in queue
                  {queueInfo.estimatedWaitMs != null && (
                    <span className="font-normal opacity-80">
                      · ~{fmtDuration(queueInfo.estimatedWaitMs)} wait
                    </span>
                  )}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{job.repo}</span>
              <span className="mx-1.5 opacity-40">·</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{job.ref}</code>
            </p>

            {/* Tags row */}
            {!editingTags ? (
              <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                <TagIcon className="h-3 w-3 text-amber-500" />
                {(job.tags ?? []).length === 0 ? (
                  <span className="text-[11px] text-muted-foreground/60">No tags</span>
                ) : (
                  (job.tags ?? []).map((t) => (
                    <span
                      key={t}
                      className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                    >
                      {t}
                    </span>
                  ))
                )}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-amber-300/60 bg-amber-50/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-800/60 dark:bg-amber-950/20 dark:text-amber-300 dark:hover:bg-amber-950/40"
                  onClick={startEditTags}
                  aria-label="Edit tags"
                >
                  <Pencil className="h-2.5 w-2.5" />
                  {(job.tags ?? []).length === 0 ? "Add tags" : "Edit"}
                </button>
              </div>
            ) : (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 dark:border-amber-900/60 dark:bg-amber-950/20">
                <div className="flex items-center gap-1.5">
                  <TagIcon className="h-3 w-3 text-amber-500" />
                  <Input
                    ref={tagInputRef}
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                    onBlur={() => { if (tagDraft.trim()) addPendingTag(tagDraft); }}
                    placeholder="press Enter or comma to add"
                    className="h-7 flex-1 text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={cancelEditTags}
                    disabled={savingTags}
                  >
                    <X className="h-3 w-3" />
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={saveTags}
                    disabled={savingTags}
                  >
                    {savingTags ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Save
                  </Button>
                </div>
                {pendingTags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {pendingTags.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                      >
                        {t}
                        <button
                          type="button"
                          className="hover:text-amber-900 dark:hover:text-amber-100"
                          onClick={() => removePendingTag(t)}
                          aria-label={`Remove tag ${t}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Max 10 tags · 1-30 chars · letters, numbers, dash, underscore
                </p>
              </div>
            )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>queued {new Date(job.queuedAt).toLocaleString()}</div>
            <div>started {job.startedAt ? new Date(job.startedAt).toLocaleString() : "—"}</div>
            <div>finished {job.finishedAt ? new Date(job.finishedAt).toLocaleString() : "—"}</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Duration" value={fmtDuration(job.durationMs)} />
          <Stat label="Expected head" value={job.expected_head ? job.expected_head.slice(0, 12) : "—"} mono />
          <Stat
            label="Actual head"
            value={job.actual_head ? job.actual_head.slice(0, 12) : "—"}
            mono
            highlight={
              job.expected_head && job.actual_head
                ? job.actual_head.toLowerCase().startsWith(job.expected_head.toLowerCase())
                : undefined
            }
          />
          <Stat label="Commands" value={`${job.commands.length}`} />
        </div>

        {job.error && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">Job note</div>
              <div className="mt-0.5 font-mono">{job.error}</div>
            </div>
          </div>
        )}

        {job.metadata && Object.keys(job.metadata).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(job.metadata).map(([k, v]) => (
              <span key={k} className="rounded-md border bg-muted/40 px-2 py-0.5">
                <span className="text-muted-foreground">{k}:</span>{" "}
                <span className="font-medium">{String(v)}</span>
              </span>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Commands */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Command log</h2>
        </div>
        <div className="p-2">
          {job.commands.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">No commands.</div>
          ) : (
            <Accordion type="multiple" defaultValue={[`cmd-0`]}>
              {job.commands.map((c: CommandResult, i: number) => {
                const hasOutput = (c.stdout && c.stdout.trim()) || (c.stderr && c.stderr.trim());
                const statusColor = c.status === "success"
                  ? "border-l-emerald-500"
                  : c.status === "failed"
                  ? "border-l-rose-500"
                  : c.status === "timeout"
                  ? "border-l-orange-500"
                  : c.status === "running"
                  ? "border-l-orange-500"
                  : c.status === "skipped"
                  ? "border-l-zinc-400"
                  : "border-l-zinc-300";
                return (
                  <div key={i} className="relative">
                    {/* Timeline connector */}
                    {i < job.commands.length - 1 && (
                      <div className="absolute left-[23px] top-10 bottom-0 w-px bg-border z-10" />
                    )}
                    <AccordionItem
                      value={`cmd-${i}`}
                      className={cn("border-b border-l-4 last:border-b-0", statusColor)}
                    >
                    <AccordionTrigger className="hover:no-underline px-3 py-3">
                      <div className="flex w-full items-center gap-3 pr-2">
                        <CommandIcon status={c.status} />
                        <code className="flex-1 truncate text-left font-mono text-xs">
                          {c.command}
                        </code>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {c.exitCode != null ? `exit ${c.exitCode}` : c.status}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {fmtDuration(c.durationMs)}
                        </span>
                        {c.truncated && (
                          <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                            TRUNC
                          </span>
                        )}
                        {/* Copy command log button */}
                        {hasOutput && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const logText = [c.stdout, c.stderr].filter(Boolean).join("\n");
                              navigator.clipboard.writeText(logText).then(() => {
                                toast.success("Command log copied");
                              }).catch(() => {
                                toast.error("Failed to copy");
                              });
                            }}
                            className="shrink-0 rounded p-1 text-muted-foreground/50 transition-all duration-200 hover:text-foreground hover:bg-muted/50 opacity-0 group-hover:opacity-100"
                            aria-label="Copy command log"
                            title="Copy stdout + stderr"
                          >
                            <ClipboardCopy className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="px-3 pb-3 animate-scale-in">
                      {!hasOutput && c.status !== "skipped" ? (
                        <div className="px-1 py-2 text-xs text-muted-foreground">
                          No output captured.
                        </div>
                      ) : c.status === "skipped" ? (
                        <div className="px-1 py-2 text-xs text-muted-foreground">
                          Skipped (a previous command failed and continue-on-error was off).
                        </div>
                      ) : (
                        <div>
                          <LogBlock label="stdout" text={c.stdout} tone="out" />
                          <LogBlock label="stderr" text={c.stderr} tone="err" />
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                  </div>
                );
              })}
            </Accordion>
          )}
        </div>
      </div>

      {/* Job Annotations */}
      <JobAnnotations
        jobId={job.jobId}
        annotations={job.annotations ?? []}
        onAnnotationsChanged={load}
      />

      {/* Webhook deliveries — show the card if there are any past deliveries
          OR the job has a callback_url configured (so the user can manually
          retry even if the automatic delivery hasn't happened yet). */}
      {(job.webhookDeliveries && job.webhookDeliveries.length > 0) || job.callback_url ? (
        <WebhookDeliveriesCard
          deliveries={job.webhookDeliveries ?? []}
          jobId={job.jobId}
          callbackUrl={job.callback_url}
          onRetried={load}
        />
      ) : null}

      {/* Share access (read-only public links) */}
      <SharePanel jobId={job.jobId} />

      {/* Raw JSON */}
      <details className="rounded-xl border bg-card shadow-sm">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
          Raw job JSON
        </summary>
        <pre className="max-h-96 overflow-auto border-t p-4 log-viewer text-muted-foreground">
          {JSON.stringify(job, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function deliveryStatusBadge(status: WebhookDelivery["status"]): {
  label: string;
  className: string;
  icon: "check" | "x" | "clock";
} {
  switch (status) {
    case "success":
      return {
        label: "Success",
        className: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900",
        icon: "check",
      };
    case "timeout":
      return {
        label: "Timeout",
        className: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/60 dark:text-orange-300 dark:border-orange-900",
        icon: "clock",
      };
    default:
      return {
        label: "Failed",
        className: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900",
        icon: "x",
      };
  }
}

function WebhookDeliveriesCard({
  deliveries,
  jobId,
  callbackUrl,
  onRetried,
}: {
  deliveries: WebhookDelivery[];
  jobId: string;
  callbackUrl?: string;
  onRetried: () => void | Promise<void>;
}) {
  const successCount = deliveries.filter((d) => d.status === "success").length;
  const lastFailed = deliveries.length > 0 && deliveries[deliveries.length - 1].status !== "success";
  const [retrying, setRetrying] = useState(false);
  const hasCallbackUrl = !!callbackUrl;

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await retryWebhook(jobId);
      if (res.ok) {
        toast.success(`Webhook retry succeeded (HTTP ${res.statusCode ?? "?"})`, {
          description: `Attempt #${res.attempt}`,
        });
      } else {
        toast.error(`Webhook retry failed: ${res.error ?? res.status}`, {
          description: `Attempt #${res.attempt}`,
        });
      }
      await onRetried();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <Accordion type="single" collapsible defaultValue="webhook">
        <AccordionItem value="webhook" className="border-b-0">
          <AccordionTrigger className="hover:no-underline px-4 py-3">
            <div className="flex w-full items-center gap-2 pr-2">
              <Webhook className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Webhook deliveries</h2>
              <span className="ml-auto mr-6 inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {successCount}/{deliveries.length} succeeded
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4">
            {/* Retry button — shown if there's a callback_url AND (no deliveries yet
                OR the last delivery was unsuccessful). Lets the user manually
                re-fire the webhook without re-running the job. */}
            {hasCallbackUrl && (deliveries.length === 0 || lastFailed) && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200/60 bg-amber-50/40 p-3 text-xs dark:border-amber-900/60 dark:bg-amber-950/20">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <div className="flex-1">
                  <div className="font-medium text-amber-800 dark:text-amber-300">
                    {deliveries.length === 0
                      ? "No webhook deliveries yet"
                      : "Last webhook delivery failed"}
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {deliveries.length === 0
                      ? "The automatic delivery may not have fired yet. Trigger a manual retry below."
                      : "The callback endpoint may have been temporarily unavailable. Trigger a manual retry below."}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px] transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]"
                  disabled={retrying}
                  onClick={handleRetry}
                >
                  {retrying ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3 w-3" />
                  )}
                  Retry webhook
                </Button>
              </div>
            )}
            <div className="space-y-2">
              {deliveries.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground">
                  <Webhook className="h-5 w-5 animate-float-y text-amber-500 opacity-50" />
                  <span>No deliveries recorded yet.</span>
                </div>
              ) : (
                deliveries.map((d, i) => {
                  const meta = deliveryStatusBadge(d.status);
                  return (
                    <div
                      key={i}
                      className="rounded-lg border bg-muted/20 p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground">
                          attempt #{d.attempt}
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                            meta.className
                          )}
                        >
                          {meta.icon === "check" && <CheckCircle2 className="h-3 w-3" />}
                          {meta.icon === "x" && <XCircle className="h-3 w-3" />}
                          {meta.icon === "clock" && <Clock className="h-3 w-3" />}
                          {meta.label}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          HTTP {d.statusCode ?? "—"}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {d.durationMs}ms
                        </span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {new Date(d.sentAt).toLocaleString()}
                        </span>
                      </div>
                      {d.error && (
                        <div className="mt-2 font-mono text-[11px] text-rose-600 dark:text-rose-400">
                          {d.error}
                        </div>
                      )}
                      <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
                        {d.url}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {/* Manual retry always available at the bottom if a callback_url is set,
                even when all past deliveries succeeded (lets the user re-fire on demand). */}
            {hasCallbackUrl && deliveries.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-3 gap-1.5 text-xs text-amber-700 hover:bg-amber-100 hover:text-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40"
                disabled={retrying}
                onClick={handleRetry}
              >
                {retrying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                Manually re-fire webhook
              </Button>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={cn(
      "rounded-lg border p-2.5",
      highlight === true
        ? "bg-gradient-to-br from-emerald-50 to-emerald-100/50 border-emerald-200 dark:from-emerald-950/40 dark:to-emerald-900/20 dark:border-emerald-900"
        : highlight === false
        ? "bg-gradient-to-br from-rose-50 to-rose-100/50 border-rose-200 dark:from-rose-950/40 dark:to-rose-900/20 dark:border-rose-900"
        : "bg-muted/20"
    )}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate text-sm font-semibold",
          mono && "font-mono",
          highlight === true && "text-emerald-600 dark:text-emerald-400",
          highlight === false && "text-rose-600 dark:text-rose-400"
        )}
      >
        {value}
      </div>
    </div>
  );
}
