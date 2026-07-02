"use client";

import { useEffect, useMemo, useState } from "react";
import { GitCompare, Loader2, ArrowRight, CheckCircle2, XCircle, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "./StatusBadge";
import { getJob } from "@/lib/verify/client";
import type { CommandResult, Job } from "@/lib/verify/types";
import { cn } from "@/lib/utils";

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
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
  });
}

function overallExit(job: Job): string {
  const failed = job.commands.find((c) => c.exitCode != null && c.exitCode !== 0);
  if (failed) return String(failed.exitCode);
  if (job.status === "success") return "0";
  return "—";
}

function jobOptionLabel(job: Job): string {
  return `${job.jobId.slice(0, 8)} · ${job.repo} · ${job.ref}`;
}

// Determine whether a single command should be considered "the same" between
// the two jobs — i.e. exit code matched. Returns:
//   - "match": both succeeded (exit 0) or both failed (non-0)
//   - "differ": one succeeded, the other failed
//   - "missing": one of them is undefined (command not present in the other job)
//   - "pending": one or both haven't completed yet (running/queued/pending)
function compareCommands(
  a: CommandResult | undefined,
  b: CommandResult | undefined
): "match" | "differ" | "missing" | "pending" {
  if (!a || !b) return "missing";
  if (a.status === "pending" || a.status === "running" || b.status === "pending" || b.status === "running") {
    return "pending";
  }
  const aOk = a.exitCode === 0;
  const bOk = b.exitCode === 0;
  if (aOk && bOk) return "match";
  if (!aOk && !bOk) return "match";
  return "differ";
}

// Header comparison cell — color-tinted background depending on outcome.
function CommandCell({
  cmd,
  state,
  side,
}: {
  cmd: CommandResult | undefined;
  state: ReturnType<typeof compareCommands>;
  side: "a" | "b";
}) {
  if (!cmd) {
    return (
      <div className="rounded-md border border-dashed border-muted-foreground/30 bg-muted/10 px-2.5 py-1.5 text-[11px] text-muted-foreground/60">
        Not in this job
      </div>
    );
  }
  const isOk = cmd.exitCode === 0;
  const tint =
    state === "match"
      ? "border-transparent bg-transparent"
      : state === "differ"
      ? isOk
        ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
        : "border-rose-300 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30"
      : "border-transparent bg-transparent";
  return (
    <div className={cn("rounded-md border px-2.5 py-1.5", tint)}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {cmd.exitCode != null ? `exit ${cmd.exitCode}` : cmd.status}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {fmtDuration(cmd.durationMs)}
        </span>
      </div>
      {cmd.status === "success" ? (
        <CheckCircle2 className="mt-1 h-3 w-3 text-emerald-500" />
      ) : cmd.status === "failed" || cmd.status === "timeout" ? (
        <XCircle className="mt-1 h-3 w-3 text-rose-500" />
      ) : cmd.status === "running" ? (
        <Loader2 className="mt-1 h-3 w-3 animate-spin text-orange-500" />
      ) : cmd.status === "skipped" ? (
        <Clock className="mt-1 h-3 w-3 text-muted-foreground" />
      ) : null}
      {side === "a" && state === "differ" && (
        <ArrowRight className="hidden" aria-hidden />
      )}
    </div>
  );
}

export function CompareJobs({
  jobs,
  onClose,
  onSelect,
}: {
  jobs: Job[];
  onClose: () => void;
  onSelect: (jobId: string) => void;
}) {
  // Use the most recent 50 jobs for the selectors to keep things tidy.
  const recent = useMemo(() => jobs.slice(0, 50), [jobs]);
  const [aId, setAId] = useState<string | null>(recent[0]?.jobId ?? null);
  const [bId, setBId] = useState<string | null>(recent[1]?.jobId ?? null);
  const [a, setA] = useState<Job | null>(null);
  const [b, setB] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When the dialog opens or the selections change, fetch the full job
  // details. The list view may be a trimmed version (depending on the
  // backend `limit`), so we re-fetch to ensure we have all commands.
  useEffect(() => {
    let alive = true;
    if (!aId && !bId) {
      setA(null);
      setB(null);
      return;
    }
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const results = await Promise.all([
          aId ? getJob(aId) : Promise.resolve(null),
          bId ? getJob(bId) : Promise.resolve(null),
        ]);
        if (!alive) return;
        setA(results[0]);
        setB(results[1]);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [aId, bId]);

  // Build a unified list of commands (by command string) across both jobs,
  // preserving the order in which they appear in job A first, then any
  // extras only present in job B.
  const commandRows = useMemo(() => {
    if (!a && !b) return [] as { command: string; a?: CommandResult; b?: CommandResult }[];
    const rows: { command: string; a?: CommandResult; b?: CommandResult }[] = [];
    const seen = new Set<string>();
    for (const c of a?.commands ?? []) {
      if (!seen.has(c.command)) {
        seen.add(c.command);
        rows.push({ command: c.command, a: c });
      }
    }
    for (const c of b?.commands ?? []) {
      if (!seen.has(c.command)) {
        seen.add(c.command);
        rows.push({ command: c.command, b: c });
      } else {
        const row = rows.find((r) => r.command === c.command);
        if (row && !row.b) row.b = c;
      }
    }
    // Also populate `a` references if there are matching commands in job A
    // that we hadn't paired yet (this only matters if both jobs share a
    // command string but job A was iterated first).
    for (const c of a?.commands ?? []) {
      const row = rows.find((r) => r.command === c.command);
      if (row && !row.a) row.a = c;
    }
    return rows;
  }, [a, b]);

  const summary = useMemo(() => {
    let match = 0;
    let differ = 0;
    let missing = 0;
    let pending = 0;
    for (const row of commandRows) {
      const state = compareCommands(row.a, row.b);
      if (state === "match") match++;
      else if (state === "differ") differ++;
      else if (state === "missing") missing++;
      else pending++;
    }
    return { match, differ, missing, pending, total: commandRows.length };
  }, [commandRows]);

  const availableForB = useMemo(
    () => recent.filter((j) => j.jobId !== aId),
    [recent, aId]
  );
  const availableForA = useMemo(
    () => recent.filter((j) => j.jobId !== bId),
    [recent, bId]
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-amber-600" />
            Compare jobs
          </DialogTitle>
          <DialogDescription>
            Pick two jobs to see a side-by-side comparison of their results.
          </DialogDescription>
        </DialogHeader>

        {/* Selectors */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Job A
            </label>
            <Select value={aId ?? ""} onValueChange={(v) => setAId(v || null)}>
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select job A" />
              </SelectTrigger>
              <SelectContent>
                {availableForA.map((j) => (
                  <SelectItem key={j.jobId} value={j.jobId}>
                    {jobOptionLabel(j)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Job B
            </label>
            <Select value={bId ?? ""} onValueChange={(v) => setBId(v || null)}>
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select job B" />
              </SelectTrigger>
              <SelectContent>
                {availableForB.map((j) => (
                  <SelectItem key={j.jobId} value={j.jobId}>
                    {jobOptionLabel(j)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading job details…
          </div>
        )}

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}

        {!loading && !error && a && b && (
          <div className="space-y-4">
            {/* Headers */}
            <div className="grid gap-3 sm:grid-cols-2">
              <CompareHeader job={a} onClick={() => onSelect(a.jobId)} />
              <CompareHeader job={b} onClick={() => onSelect(b.jobId)} />
            </div>

            {/* Summary */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2.5 text-xs">
              <span className="font-semibold">Summary:</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                <CheckCircle2 className="h-3 w-3" />
                {summary.match} match
              </span>
              {summary.differ > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                  <XCircle className="h-3 w-3" />
                  {summary.differ} differ
                </span>
              )}
              {summary.missing > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                  {summary.missing} missing
                </span>
              )}
              {summary.pending > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 font-medium text-orange-800 dark:bg-orange-950/60 dark:text-orange-300">
                  <Clock className="h-3 w-3" />
                  {summary.pending} pending
                </span>
              )}
              <span className="ml-auto text-muted-foreground">
                of {summary.total} command{summary.total !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Command comparison table */}
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40%]">Command</TableHead>
                    <TableHead className="w-[30%]">Job A</TableHead>
                    <TableHead className="w-[30%]">Job B</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {commandRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} className="py-6 text-center text-xs text-muted-foreground">
                        No commands to compare.
                      </TableCell>
                    </TableRow>
                  ) : (
                    commandRows.map((row, i) => {
                      const state = compareCommands(row.a, row.b);
                      return (
                        <TableRow key={`${row.command}-${i}`}>
                          <TableCell className="align-top">
                            <code className="break-all font-mono text-[11px]">{row.command}</code>
                          </TableCell>
                          <TableCell className="align-top">
                            <CommandCell cmd={row.a} state={state} side="a" />
                          </TableCell>
                          <TableCell className="align-top">
                            <CommandCell cmd={row.b} state={state} side="b" />
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {!loading && !error && (!a || !b) && (
          <div className="rounded-lg border border-dashed bg-muted/20 py-8 text-center text-xs text-muted-foreground">
            Select two jobs above to see the comparison.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CompareHeader({ job, onClick }: { job: Job; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full rounded-lg border bg-card p-3 text-left transition-colors hover:border-amber-300 hover:bg-amber-50/50 dark:hover:border-amber-800 dark:hover:bg-amber-950/20"
    >
      <div className="flex items-center justify-between gap-2">
        <code className="font-mono text-xs font-semibold">{job.jobId.slice(0, 8)}</code>
        <StatusBadge status={job.status} />
      </div>
      <div className="mt-1 truncate text-xs font-medium">{job.repo}</div>
      <div className="truncate font-mono text-[11px] text-muted-foreground">{job.ref}</div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>exit {overallExit(job)}</span>
        <span>{fmtDuration(job.durationMs)}</span>
        <span>{fmtTime(job.startedAt)}</span>
      </div>
    </button>
  );
}
