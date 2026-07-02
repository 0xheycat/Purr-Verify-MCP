"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Clock,
  Link2,
  Link2Off,
  Loader2,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  createShareToken,
  listShareTokens,
  revokeAllShares,
  type ShareTokenInfo,
} from "@/lib/verify/client";
import { QrCodeDialog } from "./QrCodeDialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface SharePanelProps {
  jobId: string;
}

const TTL_OPTIONS = [
  { label: "1 hour", value: "1" },
  { label: "24 hours", value: "24" },
  { label: "7 days", value: "168" },
];

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtExpiresIn(iso: string): { text: string; urgent: boolean } {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: "expired", urgent: true };
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return { text: `${h}h ${m}m left`, urgent: ms < 60 * 60 * 1000 };
  if (m > 0) return { text: `${m}m left`, urgent: true };
  return { text: `${s}s left`, urgent: true };
}

export function SharePanel({ jobId }: SharePanelProps) {
  const [tokens, setTokens] = useState<ShareTokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [ttl, setTtl] = useState("24");
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  // Token created in the most recent handleCreate call — used to play a
  // one-shot fade-in-up entrance animation on its row.
  const [newToken, setNewToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listShareTokens(jobId);
      setTokens(res.tokens);
    } catch {
      // ignore — best-effort
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    refresh();
    // Poll for expiry updates every 30s.
    const iv = setInterval(refresh, 30_000);
    return () => clearInterval(iv);
  }, [refresh]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const ttlHours = parseInt(ttl, 10);
      const t = await createShareToken(jobId, {
        ttlHours,
        note: showNote && note.trim() ? note.trim() : undefined,
      });
      // Try to copy to clipboard automatically.
      try {
        await navigator.clipboard.writeText(t.shareUrl);
        toast.success("Share link created and copied to clipboard");
      } catch {
        toast.success("Share link created");
      }
      setNote("");
      setShowNote(false);
      setNewToken(t.token);
      await refresh();
      // Clear the highlight after the entrance animation has time to play.
      window.setTimeout(() => setNewToken(null), 1000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevokeAll = async () => {
    setRevoking(true);
    try {
      const res = await revokeAllShares(jobId);
      toast.success(`Revoked ${res.revoked} share link${res.revoked === 1 ? "" : "s"}`);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRevoking(false);
    }
  };

  const copyUrl = async (t: ShareTokenInfo) => {
    try {
      await navigator.clipboard.writeText(t.shareUrl);
      setCopiedToken(t.token);
      toast.success("Share URL copied");
      setTimeout(() => setCopiedToken((cur) => (cur === t.token ? null : cur)), 1500);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <Accordion type="single" collapsible defaultValue="share">
        <AccordionItem value="share" className="border-b-0">
          <AccordionTrigger className="hover:no-underline px-4 py-3">
            <div className="flex w-full items-center gap-2 pr-2">
              <Share2 className="h-4 w-4 text-amber-600" />
              <h2 className="text-sm font-semibold">Share access</h2>
              <span className="ml-auto mr-6 inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {tokens.length} active link{tokens.length === 1 ? "" : "s"}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4">
            <div className="space-y-4">
              {/* Create new share link */}
              <div className="rounded-lg border border-amber-200/60 bg-amber-50/30 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    <Plus className="mr-1 inline h-3 w-3" />
                    New link
                  </span>
                  <Select value={ttl} onValueChange={setTtl}>
                    <SelectTrigger className="h-8 w-[120px] text-xs transition-[color,box-shadow] data-[state=open]:border-amber-400 data-[state=open]:ring-2 data-[state=open]:ring-amber-400/20 dark:data-[state=open]:border-amber-500 dark:data-[state=open]:ring-amber-500/20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TTL_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className="text-xs">
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8 gap-1.5 text-xs transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]"
                    onClick={handleCreate}
                    disabled={creating}
                  >
                    {creating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Link2 className="h-3.5 w-3.5" />
                    )}
                    Create & copy
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setShowNote((s) => !s)}
                  >
                    {showNote ? "Hide note" : "Add note"}
                  </Button>
                </div>
                {showNote && (
                  <div className="mt-2">
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Optional note (e.g., PR review, Slack share) — max 200 chars"
                      maxLength={200}
                      className="h-8 text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleCreate();
                        }
                      }}
                    />
                  </div>
                )}
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Anyone with the share URL can view this job&apos;s result (read-only, no token
                  needed). Sensitive fields like webhook URLs are stripped from the public view.
                </p>
              </div>

              {/* Active share links */}
              {loading ? (
                <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading share links…
                </div>
              ) : tokens.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                  <Share2 className="h-6 w-6 animate-float-y text-amber-500 opacity-50 dark:text-amber-400" />
                  <span>No active share links. Create one above.</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {tokens.map((t) => {
                    const exp = fmtExpiresIn(t.expiresAt);
                    return (
                      <div
                        key={t.token}
                        className={cn(
                          "rounded-lg border bg-muted/20 p-3 transition-all duration-200 hover:translate-x-0.5 hover:bg-muted/30 hover:shadow-sm",
                          t.token === newToken && "animate-fade-in-up"
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <code
                            className="max-w-[280px] truncate rounded bg-background/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                            title={t.shareUrl}
                          >
                            {t.shareUrl}
                          </code>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 px-2 text-[11px]"
                            onClick={() => copyUrl(t)}
                          >
                            {copiedToken === t.token ? (
                              <>
                                <Check className="h-3 w-3 text-emerald-600" /> Copied
                              </>
                            ) : (
                              <>
                                <ClipboardCopy className="h-3 w-3" /> Copy
                              </>
                            )}
                          </Button>
                          <QrCodeDialog
                            url={t.shareUrl}
                            title={`Share link · ${t.token.slice(0, 8)}…`}
                            iconOnly
                            triggerClassName="h-7 w-7 p-0 text-[11px]"
                          />
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                              exp.urgent
                                ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                                : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                            )}
                          >
                            <Clock className="h-2.5 w-2.5" />
                            <span className={cn(exp.urgent && "animate-pulse")}>
                              {exp.text}
                            </span>
                          </span>
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            created {fmtRelative(t.createdAt)}
                          </span>
                        </div>
                        {t.note && (
                          <div className="mt-1.5 text-[11px] italic text-muted-foreground">
                            &ldquo;{t.note}&rdquo;
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 gap-1.5 text-xs text-rose-600 transition-colors hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-950/50 dark:hover:text-rose-300"
                    onClick={handleRevokeAll}
                    disabled={revoking}
                  >
                    {revoking ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Link2Off className="h-3.5 w-3.5" />
                    )}
                    Revoke all share links
                  </Button>
                </div>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
