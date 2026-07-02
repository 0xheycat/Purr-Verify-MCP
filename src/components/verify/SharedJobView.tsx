"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Check,
  ChevronDown,
  ClipboardCopy,
  Clock,
  ExternalLink,
  Eye,
  Link2,
  Loader2,
  Share2,
  ShieldAlert,
  Terminal,
  TimerReset,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { StatusBadge } from "./StatusBadge";
import { JobDetailSkeleton } from "./Skeleton";
import { getSharedJob } from "@/lib/verify/client";
import type { CommandResult, PublicJobView } from "@/lib/verify/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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
          "max-h-72 overflow-auto rounded-md border",
          tone === "err"
            ? "border-rose-200 bg-rose-50/50 dark:border-rose-900/60 dark:bg-rose-950/20"
            : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40"
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

// Live countdown for the share link expiry.
function useExpiryCountdown(expiresAt: string): { text: string; urgent: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return { text: "expired", urgent: true };
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let text: string;
  if (h > 0) text = `${h}h ${m}m`;
  else if (m > 0) text = `${m}m ${sec}s`;
  else text = `${sec}s`;
  return { text, urgent: ms < 60 * 60 * 1000 }; // < 1h = urgent
}

function ShareExpiryBanner({ expiresAt }: { expiresAt: string }) {
  const { text, urgent } = useExpiryCountdown(expiresAt);
  return (
    <div
      className={cn(
        "relative flex flex-wrap items-center gap-2.5 overflow-hidden rounded-xl border p-3 text-xs shadow-sm",
        urgent
          ? "border-rose-200 bg-gradient-to-r from-rose-50 via-rose-50/60 to-transparent text-rose-800 dark:border-rose-900 dark:from-rose-950/40 dark:via-rose-950/20 dark:to-transparent dark:text-rose-300"
          : "border-amber-200 bg-gradient-to-r from-amber-50 via-orange-50/50 to-transparent text-amber-800 dark:border-amber-900 dark:from-amber-950/40 dark:via-orange-950/20 dark:to-transparent dark:text-amber-300"
      )}
    >
      <span
        className={cn(
          "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm ring-1 ring-inset",
          urgent
            ? "bg-gradient-to-br from-rose-400/25 to-rose-500/25 text-rose-600 ring-rose-500/20 dark:text-rose-400"
            : "bg-gradient-to-br from-amber-400/25 to-orange-500/25 text-amber-600 ring-amber-500/20 dark:text-amber-400"
        )}
      >
        <Share2 className="h-4 w-4" />
        <Link2 className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-background p-[1px] text-current ring-1 ring-current/20" />
      </span>
      <div className="flex-1">
        <div className="font-semibold">Shared verification result</div>
        <div className="mt-0.5 text-[11px] opacity-90">
          Read-only view via a temporary share link.{" "}
          <span className={cn("font-mono font-semibold", urgent && "animate-pulse")}>
            Expires in {text}
          </span>
          {" "}(at {new Date(expiresAt).toLocaleString()})
        </div>
      </div>
      <span className="inline-flex items-center gap-1 rounded-full border border-current/20 bg-background/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
        <Eye className="h-3 w-3 animate-pulse" /> Public
      </span>
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

export function SharedJobView({
  token,
  onBack,
}: {
  token: string;
  onBack: () => void;
}) {
  const [job, setJob] = useState<PublicJobView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const j = await getSharedJob(token);
        if (alive) {
          setJob(j);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  // Optional: poll for updates if the job is still active.
  useEffect(() => {
    if (!job) return;
    const isActive = job.status === "running" || job.status === "queued";
    if (!isActive) return;
    const iv = setInterval(async () => {
      try {
        const j = await getSharedJob(token);
        setJob(j);
      } catch {
        // ignore
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [job?.status, token]);

  if (loading) return <JobDetailSkeleton />;
  if (error || !job) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
          <ExternalLink className="h-4 w-4" /> Back to dashboard
        </Button>
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 animate-shake-x" />
          <div>
            <div className="font-semibold">Share link unavailable</div>
            <div className="mt-0.5 text-xs font-mono opacity-90">{error || "Unknown error"}</div>
            <div className="mt-2 text-[11px] opacity-80">
              The link may have expired, been revoked, or the shared job no longer exists.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" className="gap-2" onClick={onBack}>
          <ExternalLink className="h-4 w-4" /> Back to dashboard
        </Button>
        <div className="text-[11px] text-muted-foreground">
          Viewing shared job{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{job.jobId.slice(0, 8)}</code>
        </div>
      </div>

      <ShareExpiryBanner expiresAt={job.sharedVia.expiresAt} />

      {/* Summary header */}
      <div className="relative rounded-xl p-[1px] bg-gradient-to-r from-amber-500/30 via-orange-500/20 to-amber-500/30 animate-gradient-shift shadow-sm">
        <div className="rounded-[11px] bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-mono text-lg font-semibold">{job.jobId.slice(0, 8)}</h1>
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 shadow-sm dark:border-amber-700/50 dark:bg-amber-950/60 dark:text-amber-300">
                  <Share2 className="h-2.5 w-2.5" />
                  Shared
                </span>
                <StatusBadge status={job.status} />
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
              </div>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{job.repo}</span>
                <span className="mx-1.5 opacity-40">·</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{job.ref}</code>
              </p>
              {(job.tags ?? []).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                  {(job.tags ?? []).map((t) => (
                    <span
                      key={t}
                      className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                    >
                      {t}
                    </span>
                  ))}
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
            <Stat label="Actual head" value={job.actual_head ? job.actual_head.slice(0, 12) : "—"} mono />
            <Stat label="Commands" value={`${job.commands.length}`} />
            <Stat
              label="Continue on error"
              value={job.continue_on_error ? "yes" : "no"}
            />
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
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="px-3 pb-3">
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

      <div className="relative overflow-hidden rounded-xl border border-dashed border-amber-300/60 bg-gradient-to-br from-amber-50/60 via-orange-50/30 to-transparent p-4 text-center text-xs text-muted-foreground dark:border-amber-800/60 dark:from-amber-950/20 dark:via-orange-950/10 dark:to-transparent">
        <div className="flex items-center justify-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-100/70 text-amber-600 shadow-sm dark:bg-amber-900/40 dark:text-amber-400">
            <ClipboardCopy className="h-3.5 w-3.5" />
          </span>
          <span>
            This is a public read-only view. To run your own verification,{" "}
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
              onClick={onBack}
            >
              return to the dashboard
              <ExternalLink className="h-3 w-3" />
            </button>
            .
          </span>
        </div>
      </div>
    </div>
  );
}
