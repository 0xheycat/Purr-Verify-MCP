"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Bookmark,
  BookmarkPlus,
  Trash2,
  ChevronDown,
  History,
  X,
  Tag as TagIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { createJob, validateJob } from "@/lib/verify/client";
import type { VerifyRequest } from "@/lib/verify/types";
import {
  getPresets,
  savePreset,
  deletePreset,
  getRecentRefs,
  addRecentRef,
  addRecentRepo,
  type CommandPreset,
  type RecentRef,
} from "@/lib/verify/presets";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const QUICK_COMMANDS = [
  "bun install",
  "bun install --frozen-lockfile",
  "bunx prisma generate",
  "bun run ci:check",
  "bun run build",
  "bun test",
  "npm ci",
  "npm run build",
  "npx prisma generate",
];

export function SubmitForm({
  allowedRepos,
  allowAllRepos,
  onCreated,
  rerunJobId,
  rerunFilter,
}: {
  allowedRepos: string[];
  allowAllRepos?: boolean;
  onCreated?: () => void;
  rerunJobId?: string;
  rerunFilter?: string;
}) {
  // Unrestricted mode (ALLOWED_REPOS empty/"*" or ALLOW_ALL_REPOS=true): any
  // owner/repo slug is accepted, so the repo field becomes free-text instead
  // of a fixed dropdown.
  const unrestricted = !!allowAllRepos || allowedRepos.length === 0;
  const [repo, setRepo] = useState(unrestricted ? "" : allowedRepos[0] || "");
  const [ref, setRef] = useState("");
  const [expectedHead, setExpectedHead] = useState("");
  const [commandsText, setCommandsText] = useState("bun install\nbun test");
  const [continueOnError, setContinueOnError] = useState(false);
  const [pr, setPr] = useState("");
  const [purpose, setPurpose] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validating, setValidating] = useState(false);

  // Re-run "failed only" banner state. When `rerunFilter === "failed"`, the
  // form is pre-filled with only the failed/timeout/skipped commands from the
  // source job and an amber info banner is shown at the top.
  const [rerunFilterMode, setRerunFilterMode] = useState<"failed" | null>(null);
  const [rerunFailedCount, setRerunFailedCount] = useState(0);
  const [rerunJobShortId, setRerunJobShortId] = useState("");
  // The full (unfiltered) command list from the rerun job. Used by the
  // "Re-run all instead" link to swap back without re-fetching.
  const [rerunAllCommandsText, setRerunAllCommandsText] = useState("");

  // Presets + recent refs state
  const [presets, setPresets] = useState<CommandPreset[]>([]);
  const [recentRefs, setRecentRefs] = useState<RecentRef[]>([]);
  const [presetName, setPresetName] = useState("");
  const [showSavePreset, setShowSavePreset] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [showRecentRefs, setShowRecentRefs] = useState(false);
  const refInputRef = useRef<HTMLInputElement>(null);

  // Load presets + recent refs on mount and when repo changes.
  useEffect(() => {
    setPresets(getPresets());
  }, []);

  useEffect(() => {
    setRecentRefs(getRecentRefs(repo));
  }, [repo]);

  // Listen for "apply preset" events from the CommandPalette. This lets the
  // palette quick-fill the commands textarea without prop drilling.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { commands?: string[] } | undefined;
      if (!detail || !Array.isArray(detail.commands) || detail.commands.length === 0) return;
      setCommandsText(detail.commands.join("\n"));
      // Clear any re-run filter mode so the new preset takes precedence.
      setRerunFilterMode(null);
      setRerunFailedCount(0);
      setRerunJobShortId("");
      setRerunAllCommandsText("");
    };
    window.addEventListener("purr-verify-apply-preset", handler);
    return () => window.removeEventListener("purr-verify-apply-preset", handler);
  }, []);

  // Re-run: fetch the old job and pre-fill the form
  useEffect(() => {
    if (!rerunJobId) return;
    let alive = true;
    (async () => {
      try {
        const { getJob } = await import("@/lib/verify/client");
        const job = await getJob(rerunJobId);
        if (!alive) return;
        if (job.repo) setRepo(job.repo);
        if (job.ref) setRef(job.ref);
        if (job.expected_head) setExpectedHead(job.expected_head);
        if (job.continue_on_error) setContinueOnError(true);
        if (job.metadata?.pr) setPr(String(job.metadata.pr));
        if (job.metadata?.purpose) setPurpose(String(job.metadata.purpose));
        if (job.tags && job.tags.length) setTags(job.tags);
        if (job.callback_url) setCallbackUrl(job.callback_url);

        // Command pre-fill — honour the `filter=failed` query param.
        const allCommands = (job.commands ?? []).map((c) => c.command).join("\n");
        setRerunAllCommandsText(allCommands);
        setRerunJobShortId(job.jobId.slice(0, 8));

        const isFailedFilter = rerunFilter === "failed";
        if (isFailedFilter && job.commands?.length) {
          const failedCommands = job.commands
            .filter(
              (c) =>
                c.status === "failed" ||
                c.status === "timeout" ||
                c.status === "skipped"
            )
            .map((c) => c.command);
          if (failedCommands.length > 0) {
            setCommandsText(failedCommands.join("\n"));
            setRerunFilterMode("failed");
            setRerunFailedCount(failedCommands.length);
          } else {
            // No failed commands to re-run — fall back to all commands.
            setCommandsText(allCommands);
            setRerunFilterMode(null);
            setRerunFailedCount(0);
            toast.info("All commands succeeded — re-running all");
          }
        } else {
          setCommandsText(allCommands);
          setRerunFilterMode(null);
          setRerunFailedCount(0);
        }
      } catch {
        // ignore — user can fill manually
      }
    })();
    return () => { alive = false; };
  }, [rerunJobId, rerunFilter]);

  // Swap the form back to the full command list (dismiss the failed-only
  // banner).
  const handleRerunAllInstead = () => {
    if (rerunAllCommandsText) {
      setCommandsText(rerunAllCommandsText);
    }
    setRerunFilterMode(null);
    setRerunFailedCount(0);
  };

  // ── Tag helpers ────────────────────────────────────────────────
  const addTag = (raw: string) => {
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
    if (tags.length >= 10) {
      toast.error("Max 10 tags");
      return;
    }
    if (tags.some((existing) => existing.toLowerCase() === t.toLowerCase())) {
      // already added — just clear the draft
      setTagDraft("");
      return;
    }
    setTags((prev) => [...prev, t]);
    setTagDraft("");
  };

  const removeTag = (tag: string) => {
    setTags((prev) => prev.filter((t) => t !== tag));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagDraft);
    } else if (e.key === "Backspace" && tagDraft === "" && tags.length > 0) {
      e.preventDefault();
      setTags((prev) => prev.slice(0, -1));
    }
  };

  const addQuick = (cmd: string) => {
    setCommandsText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${cmd}` : cmd));
  };

  const handleSavePreset = () => {
    const name = presetName.trim();
    if (!name) {
      toast.error("Enter a preset name");
      return;
    }
    if (!commandsText.trim()) {
      toast.error("Add at least one command before saving a preset");
      return;
    }
    const saved = savePreset({
      name,
      commands: commandsText,
      continueOnError,
    });
    if (saved) {
      toast.success(`Preset "${name}" saved`);
      setPresets(getPresets());
      setPresetName("");
      setShowSavePreset(false);
    } else {
      toast.error("Failed to save preset");
    }
  };

  const handleLoadPreset = (preset: CommandPreset) => {
    setCommandsText(preset.commands);
    setContinueOnError(preset.continueOnError);
    toast.success(`Loaded preset "${preset.name}"`);
    setShowPresets(false);
  };

  const handleDeletePreset = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    deletePreset(name);
    setPresets(getPresets());
    toast.success(`Preset "${name}" deleted`);
  };

  const handleSelectRecentRef = (r: RecentRef) => {
    setRef(r.ref);
    setShowRecentRefs(false);
    refInputRef.current?.focus();
  };

  const handleValidate = async () => {
    if (!repo) return toast.error("Select a repo");
    if (!ref.trim()) return toast.error("Ref is required");
    const commands = commandsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (commands.length === 0) return toast.error("Add at least one command");

    setValidating(true);
    try {
      const body: VerifyRequest = {
        repo,
        ref: ref.trim(),
        expected_head: expectedHead.trim() || undefined,
        commands,
        continue_on_error: continueOnError,
        metadata: {
          ...(pr.trim() ? { pr: pr.trim() } : {}),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        },
        callback_url: callbackUrl.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      };
      const res = await validateJob(body);
      if (res.valid) {
        toast.success(`Validation passed — ${res.commands?.length || commands.length} command(s) approved`);
      } else {
        toast.error(`Validation failed: ${res.errors?.join("; ")}`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setValidating(false);
    }
  };

  const submit = async () => {
    if (!repo) return toast.error("Select a repo");
    if (!ref.trim()) return toast.error("Ref is required");
    const commands = commandsText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (commands.length === 0) return toast.error("Add at least one command");

    setSubmitting(true);
    try {
      const body: VerifyRequest = {
        repo,
        ref: ref.trim(),
        expected_head: expectedHead.trim() || undefined,
        commands,
        continue_on_error: continueOnError,
        metadata: {
          ...(pr.trim() ? { pr: pr.trim() } : {}),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        },
        callback_url: callbackUrl.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      };
      const res = await createJob(body);
      toast.success(`Job queued: ${res.jobId.slice(0, 8)}`);
      // Record ref + repo in localStorage.
      addRecentRef(repo, ref.trim());
      addRecentRepo(repo);
      // Refresh recents.
      setRecentRefs(getRecentRefs(repo));
      setRef("");
      setExpectedHead("");
      setTags([]);
      setTagDraft("");
      onCreated?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const commandCount = useMemo(
    () => commandsText.split("\n").filter((l) => l.trim()).length,
    [commandsText]
  );

  return (
    <div className="space-y-4">
      {rerunFilterMode === "failed" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-800 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            Re-running <strong>{rerunFailedCount}</strong> failed/skipped command
            {rerunFailedCount !== 1 ? "s" : ""} from job{" "}
            <code className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-amber-900/60">
              {rerunJobShortId}
            </code>
          </span>
          <button
            type="button"
            onClick={handleRerunAllInstead}
            className="ml-auto inline-flex items-center gap-1 font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-200"
          >
            <RotateCcw className="h-3 w-3" />
            Re-run all instead
          </button>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="repo" className="flex items-center justify-between">
            <span>Repository</span>
            {unrestricted && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
                <ShieldCheck className="h-3 w-3" />
                any repo
              </span>
            )}
          </Label>
          {unrestricted ? (
            <>
              <Input
                id="repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repo (e.g. 0xheycat/purrfarmworld)"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono text-sm"
              />
              <p className="text-[10px] text-muted-foreground">
                Unrestricted mode — any public GitHub repo matching{" "}
                <code className="font-mono">owner/repo</code> is accepted.
              </p>
            </>
          ) : (
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger id="repo">
                <SelectValue placeholder="Select repo" />
              </SelectTrigger>
              <SelectContent>
                {allowedRepos.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="ref" className="flex items-center justify-between">
            <span>Ref (branch / tag)</span>
            {recentRefs.length > 0 && (
              <Popover open={showRecentRefs} onOpenChange={setShowRecentRefs}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400"
                    onClick={(e) => { e.preventDefault(); setShowRecentRefs(true); }}
                  >
                    <History className="h-3 w-3" />
                    Recent ({recentRefs.length})
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-1" align="end">
                  <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Recently used refs for {repo}
                  </div>
                  <div className="max-h-56 overflow-y-auto">
                    {recentRefs.map((r) => (
                      <button
                        key={`${r.repo}-${r.ref}-${r.ts}`}
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
                        onClick={() => handleSelectRecentRef(r)}
                      >
                        <code className="font-mono truncate">{r.ref}</code>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {new Date(r.ts).toLocaleDateString()}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </Label>
          <Input
            id="ref"
            ref={refInputRef}
            placeholder="feat/auto-1-scheduler"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="head">Expected head (optional)</Label>
          <Input
            id="head"
            placeholder="f067361"
            value={expectedHead}
            onChange={(e) => setExpectedHead(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pr">PR # / purpose (optional)</Label>
          <div className="flex gap-2">
            <Input
              id="pr"
              placeholder="1"
              value={pr}
              onChange={(e) => setPr(e.target.value)}
              className="w-24"
            />
            <Input
              placeholder="purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="tags" className="flex items-center gap-1.5">
            <TagIcon className="h-3.5 w-3.5 text-amber-500" />
            Tags
            <span className="text-[10px] font-normal text-muted-foreground">
              (optional — press Enter or comma to add, max 10)
            </span>
          </Label>
          <Input
            id="tags"
            placeholder="hotfix, release-1-2, experiment"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={() => { if (tagDraft.trim()) addTag(tagDraft); }}
            className="text-xs"
          />
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="animate-scale-in inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                >
                  {t}
                  <button
                    type="button"
                    className="transition-all duration-150 hover:scale-110 hover:bg-rose-500/20 hover:text-rose-700 dark:hover:text-rose-300 rounded-full p-0.5"
                    onClick={() => removeTag(t)}
                    aria-label={`Remove tag ${t}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="callback" className="flex items-center gap-1.5">
            Callback URL
            <span className="text-[10px] font-normal text-muted-foreground">(optional — receives POST on completion)</span>
          </Label>
          <Input
            id="callback"
            placeholder="https://your-server.com/webhook"
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            className="text-xs"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="commands">Commands (one per line)</Label>
          <div className="flex items-center gap-2">
            {/* Presets dropdown */}
            <Popover open={showPresets} onOpenChange={setShowPresets}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border bg-muted/30 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-all duration-200 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 dark:hover:border-amber-800 dark:hover:bg-amber-950/40 dark:hover:text-amber-300"
                  onClick={(e) => { e.preventDefault(); setShowPresets(true); }}
                >
                  <Bookmark className="h-2.5 w-2.5" />
                  Presets{presets.length > 0 ? ` (${presets.length})` : ""}
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-0" align="end">
                <div className="flex items-center justify-between border-b px-3 py-2">
                  <span className="text-xs font-semibold">Saved presets</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-2 text-[11px]"
                    onClick={() => { setShowPresets(false); setShowSavePreset(true); }}
                  >
                    <BookmarkPlus className="h-3 w-3" />
                    Save current
                  </Button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {presets.length === 0 ? (
                    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                      No presets yet. Configure commands above and click &quot;Save current&quot;.
                    </div>
                  ) : (
                    presets.map((p) => (
                      <div
                        key={p.name}
                        className="group flex items-start justify-between gap-2 px-3 py-2 hover:bg-muted cursor-pointer"
                        onClick={() => handleLoadPreset(p)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium truncate">{p.name}</span>
                            {p.continueOnError && (
                              <span className="rounded bg-amber-100 px-1 py-0 text-[9px] text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                                +err
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                            {p.commands.split("\n").filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="shrink-0 text-muted-foreground hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => handleDeletePreset(p.name, e)}
                          aria-label={`Delete preset ${p.name}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {/* Save preset button (quick) */}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border bg-muted/30 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-all duration-200 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 dark:hover:border-amber-800 dark:hover:bg-amber-950/40 dark:hover:text-amber-300"
              onClick={(e) => { e.preventDefault(); setShowSavePreset(true); }}
            >
              <BookmarkPlus className="h-2.5 w-2.5" />
              Save
            </button>
            {/* Quick add chips */}
            {QUICK_COMMANDS.slice(0, 6).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => addQuick(c)}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/30 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-all duration-150 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 active:scale-95 dark:hover:border-amber-800 dark:hover:bg-amber-950/40 dark:hover:text-amber-300"
              >
                <Plus className="h-2.5 w-2.5" />
                {c}
              </button>
            ))}
          </div>
        </div>
        <Textarea
          id="commands"
          value={commandsText}
          onChange={(e) => setCommandsText(e.target.value)}
          rows={6}
          className="border-l-4 border-l-amber-400 dark:border-l-amber-600 font-mono text-xs ring-offset-background transition-all duration-300 focus:ring-2 focus:ring-amber-400/50 focus:animate-subtle-pulse"
          placeholder={"bun install\nbun test"}
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            Only allowlisted commands are accepted. Dangerous tokens (<code>; &amp; | ` $()</code>,{" "}
            <code>rm</code>, <code>sudo</code>, <code>curl|sh</code>, absolute paths, …) are rejected.
          </p>
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground flex items-center gap-1">
            {commandCount} command{commandCount !== 1 ? "s" : ""}
            <span className="inline-block h-3 w-0.5 bg-amber-500 animate-typing-cursor" aria-hidden="true" />
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="inline-flex items-center gap-2 text-sm">
          <Checkbox
            checked={continueOnError}
            onCheckedChange={(v) => setContinueOnError(v === true)}
          />
          <span className="text-muted-foreground">Continue on error</span>
        </label>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleValidate} disabled={validating || submitting} className="gap-2">
            {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Validate
          </Button>
          <Button onClick={submit} disabled={submitting} className="gap-2 btn-shimmer bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:scale-[1.02] active:scale-[0.98] transition-transform duration-150 shadow-md hover:shadow-lg">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {submitting ? "Running…" : "Run verification"}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-dashed border-l-4 border-l-amber-400 dark:border-l-amber-600 bg-muted/30 p-3 text-xs text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-amber-500" />
          Example
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
{`POST /api/verify
Authorization: Bearer <VERIFY_TOKEN>

{
  "repo": "0xheycat/Purrliquid",
  "ref": "feat/auto-1-scheduler",
  "expected_head": "f067361",
  "commands": ["bun install", "bun test", "bun run build"]
}`}
        </pre>
      </div>

      {/* Save preset dialog */}
      <Dialog open={showSavePreset} onOpenChange={setShowSavePreset}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookmarkPlus className="h-4 w-4 text-amber-500" />
              Save command preset
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="preset-name" className="text-xs">Preset name</Label>
              <Input
                id="preset-name"
                placeholder="e.g. quick-test, full-ci, pr-check"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSavePreset();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="rounded-md border bg-muted/30 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Will save ({commandCount} command{commandCount !== 1 ? "s" : ""})
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed">
                {commandsText || "(empty)"}
              </pre>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Continue on error: <strong>{continueOnError ? "on" : "off"}</strong>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSavePreset(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSavePreset}
              className="gap-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white"
            >
              <Bookmark className="h-4 w-4" />
              Save preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
