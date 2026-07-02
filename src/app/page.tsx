"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Cat, Github, ShieldAlert, BookOpen } from "lucide-react";
import { JobStats } from "@/components/verify/JobStats";
import { JobTimeline } from "@/components/verify/JobTimeline";
import { DurationTrends } from "@/components/verify/DurationTrends";
import { DurationHeatmap } from "@/components/verify/DurationHeatmap";
import { PerCommandStats } from "@/components/verify/PerCommandStats";
import { RepoStats } from "@/components/verify/RepoStats";
import { ConfigViewer } from "@/components/verify/ConfigViewer";
import { useKeyboardShortcuts } from "@/components/verify/KeyboardShortcuts";
import { CommandPalette, CommandPaletteButton } from "@/components/verify/CommandPalette";
import { CodeBlock } from "@/components/verify/CodeBlock";
import { motion } from "framer-motion";
import { HealthBadge } from "@/components/verify/HealthBadge";
import { TokenGate } from "@/components/verify/TokenGate";
import { ThemeToggle } from "@/components/verify/ThemeToggle";
import { NotificationsToggle } from "@/components/verify/NotificationsToggle";
import { SubmitForm } from "@/components/verify/SubmitForm";
import { fireCompletionNotifications } from "@/lib/verify/notifications";
import { JobsTable } from "@/components/verify/JobsTable";
import { AllowlistViewer } from "@/components/verify/AllowlistViewer";
import { JobDetail } from "@/components/verify/JobDetail";
import { SharedJobView } from "@/components/verify/SharedJobView";
import { getHealth, listJobs } from "@/lib/verify/client";
import type { HealthResponse, Job } from "@/lib/verify/types";
import { getToken } from "@/lib/verify/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function DashboardInner() {
  const router = useRouter();
  const params = useSearchParams();
  const jobId = params.get("job");
  const rerunId = params.get("rerun");
  const rerunFilter = params.get("filter");
  const shareToken = params.get("share");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [hasToken, setHasToken] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  // Command palette open state — toggled by the header button, the Cmd+K
  // shortcut (via the global event), or the palette's own close button.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Mirror of the JobsTable's favoritesOnly filter state, so the CommandPalette
  // can display the correct label ("Show only favorites" vs "Show all jobs").
  const [favoritesFilterActive, setFavoritesFilterActive] = useState(false);

  // Enable keyboard shortcuts globally
  useKeyboardShortcuts();

  // Listen for the global "open command palette" event dispatched by the
  // KeyboardShortcuts handler on Cmd+K. Acknowledge so the shortcut handler
  // knows the palette handled it (and doesn't fall back to focusing search).
  useEffect(() => {
    const handler = () => {
      setPaletteOpen(true);
      window.dispatchEvent(new CustomEvent("purr-verify-open-command-palette-ack"));
    };
    window.addEventListener("purr-verify-open-command-palette", handler);
    return () => window.removeEventListener("purr-verify-open-command-palette", handler);
  }, []);

  // Mirror the JobsTable's favoritesOnly state for the CommandPalette.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { active?: boolean } | undefined;
      if (detail && typeof detail.active === "boolean") {
        setFavoritesFilterActive(detail.active);
      }
    };
    window.addEventListener("purr-verify-favorites-filter-changed", handler);
    return () => window.removeEventListener("purr-verify-favorites-filter-changed", handler);
  }, []);

  // Apply a preset (from the CommandPalette) to the SubmitForm. We do this by
  // dispatching a global event that SubmitForm listens for.
  const applyPreset = useCallback((commands: string[]) => {
    window.dispatchEvent(
      new CustomEvent("purr-verify-apply-preset", { detail: { commands } })
    );
    // Scroll the form into view so the user sees the applied preset.
    const form = document.querySelector('#ref')?.closest('form') ?? document.querySelector('#ref');
    if (form) {
      (form as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  // Toggle the favorites filter (called by the CommandPalette). Dispatches
  // an event that JobsTable listens for.
  const toggleFavoritesFilter = useCallback(() => {
    window.dispatchEvent(new CustomEvent("purr-verify-toggle-favorites-filter"));
  }, []);

  useEffect(() => {
    const t = setInterval(() => setHasToken(!!getToken()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await getHealth();
        if (alive) setHealth(h);
      } catch {
        /* ignore */
      }
    };
    tick();
    const iv = setInterval(tick, 8000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  const selectJob = useCallback(
    (id: string) => {
      router.push(`/?job=${id}`);
    },
    [router]
  );

  const back = useCallback(() => {
    router.push(`/`);
    setRefreshKey((k) => k + 1);
  }, [router]);

  const triggerRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Load jobs for stats + table
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setJobsLoading(true);
      try {
        const j = await listJobs(100);
        if (alive) setJobs(j);
      } catch {
        /* ignore */
      } finally {
        if (alive) setJobsLoading(false);
      }
    };
    load();
    return () => { alive = false; };
  }, [refreshKey]);

  // Auto-poll while any job is running/queued
  useEffect(() => {
    const hasActive = jobs.some((j) => j.status === "running" || j.status === "queued");
    if (!hasActive) return;
    let alive = true;
    const load = async () => {
      try {
        const j = await listJobs(100);
        if (alive) {
          setJobs(j);
          // Fire browser notifications for newly-completed jobs.
          fireCompletionNotifications(j);
        }
      } catch {
        /* ignore */
      }
    };
    const iv = setInterval(load, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [jobs]);

  return (
    <div className="flex min-h-screen flex-col" style={{
      background: "radial-gradient(ellipse 80% 60% at 50% -20%, rgba(245,158,11,0.06) 0%, transparent 60%), radial-gradient(ellipse 60% 50% at 80% 0%, rgba(249,115,22,0.04) 0%, transparent 50%), radial-gradient(ellipse 60% 40% at 20% 0%, rgba(245,158,11,0.03) 0%, transparent 50%), linear-gradient(to bottom, var(--background), color-mix(in srgb, var(--muted) 30%, var(--background)))"
    }}>
      {/* Header */}
      <header className="sticky top-0 z-30 glass backdrop-blur-xl bg-background/70 border-b border-border/50 shadow-[0_1px_20px_-4px_rgba(0,0,0,0.08)]">
        <div className="relative mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          {/* Decorative gradient orb behind header */}
          <div className="pointer-events-none absolute -top-20 left-1/2 -translate-x-1/2 h-40 w-[500px] rounded-full bg-gradient-to-br from-amber-500/10 via-orange-500/5 to-transparent blur-3xl animate-orb-drift" />
          <div className="flex items-center gap-2.5">
            <div className="logo-icon-hover flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
              <Cat className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-bold leading-tight tracking-tight">
                Purr Verify <span className="text-amber-600">MCP</span>
              </h1>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Private verification runner for GitHub branches
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <CommandPaletteButton onClick={() => setPaletteOpen(true)} hasToken={hasToken} />
            <HealthBadge />
            <ThemeToggle />
            <NotificationsToggle />
            <TokenGate onTokenChanged={triggerRefresh} />
          </div>
        </div>
      </header>

      {/* Command palette — mounted globally so Cmd+K works on every view. */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        jobs={jobs}
        onRefresh={triggerRefresh}
        onApplyPreset={applyPreset}
        onToggleFavoritesFilter={toggleFavoritesFilter}
        favoritesFilterActive={favoritesFilterActive}
      />

      {/* Main */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {shareToken ? (
          <SharedJobView
            token={shareToken}
            onBack={() => {
              router.push("/");
              setRefreshKey((k) => k + 1);
            }}
          />
        ) : jobId ? (
          <JobDetail jobId={jobId} onBack={back} />
        ) : (
          <div className="space-y-6">
            {/* Banner if misconfigured */}
            {health && !health.configured && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <div className="font-semibold">Server not fully configured</div>
                  <div className="mt-0.5 text-xs">
                    Set <code>VERIFY_TOKEN</code> and <code>ALLOWED_REPOS</code> in your{" "}
                    <code>.env</code> before submitting jobs.
                  </div>
                </div>
              </div>
            )}

            {/* Token hint */}
            {!hasToken && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <div className="font-semibold">Auth required to submit &amp; view jobs</div>
                  <div className="mt-0.5 text-xs">
                    Click <strong>Set API token</strong> in the header and paste your{" "}
                    <code>VERIFY_TOKEN</code> (or GitHub PAT in <code>github_passthrough</code> mode).
                    Health checks are public; everything else needs the bearer token. See{" "}
                    <code>.env.example</code> for setup.
                  </div>
                </div>
              </div>
            )}

          {/* Job Stats */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            <JobStats jobs={jobs} />
          </motion.div>

          {/* Job Activity Timeline */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.08 }}
          >
            <JobTimeline jobs={jobs} />
          </motion.div>

          {/* Duration Trends — area chart of last 20 finished jobs.
              The component wraps itself in its own motion.div (delay 0.082). */}
          <DurationTrends jobs={jobs} />

          {/* Activity Heatmap (day-of-week × hour) */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.09 }}
          >
            <DurationHeatmap jobs={jobs} />
          </motion.div>

          {/* Per-Command Stats */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            <PerCommandStats jobs={jobs} />
          </motion.div>

          {/* Per-Repo Stats */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.11 }}
          >
            <RepoStats jobs={jobs} />
          </motion.div>

          <motion.div
            className="grid gap-6 lg:grid-cols-5"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
              <div className="lg:col-span-2 rounded-xl p-[1px] bg-gradient-to-r from-amber-500/20 to-orange-500/20">
                <Card className="lg:col-span-2 border-0 shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Github className="h-4 w-4 text-amber-600" />
                      New verification
                    </CardTitle>
                    <CardDescription>
                      Clone a branch fresh and run allowlisted commands.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <SubmitForm
                      allowedRepos={health?.allowedRepos || []}
                      allowAllRepos={health?.allowAllRepos}
                      onCreated={triggerRefresh}
                      rerunJobId={rerunId || undefined}
                      rerunFilter={rerunFilter || undefined}
                    />
                  </CardContent>
                </Card>
              </div>

              <div className="lg:col-span-3">
                <JobsTable jobs={jobs} onSelect={selectJob} refreshKey={refreshKey} onRefresh={triggerRefresh} loading={jobsLoading} />
              </div>
          </motion.div>

            {/* API / MCP reference */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.2 }}
            >
            <div className="rounded-xl p-[1px] bg-gradient-to-r from-amber-500/20 to-orange-500/20">
            <Card className="border-0 shadow-none">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <BookOpen className="h-4 w-4 text-amber-600" />
                  API &amp; MCP reference
                </CardTitle>
                <CardDescription>
                  Agents can call these endpoints directly — no browser needed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 md:grid-cols-2">
                  <RefBlock
                    title="REST endpoints"
                    items={[
                      ["GET /api/health", "public"],
                      ["POST /api/verify", "auth · async (202)"],
                      ["POST /api/verify?mode=sync", "auth · sync (200)"],
                      ["GET /api/verify/:jobId", "auth · full result"],
                      ["GET /api/verify/:jobId?format=markdown", "auth · PR comment"],
                      ["POST /api/verify/:jobId/cancel", "auth · cancel"],
                      ["POST /api/verify/:jobId/annotations", "auth · add note"],
                      ["POST /api/verify/:jobId/webhook/retry", "auth · re-fire webhook"],
                      ["POST /api/verify/:jobId/share", "auth · create share link"],
                      ["GET /api/verify/:jobId/share", "auth · list share links"],
                      ["DELETE /api/verify/:jobId/share", "auth · revoke all"],
                      ["GET /api/share/:token", "public · shared job view"],
                      ["GET /api/jobs", "auth · list recent"],
                      ["GET /api/smoke", "auth · diagnostics"],
                    ]}
                  />
                  <RefBlock
                    title="MCP JSON-RPC (POST /mcp)"
                    items={[
                      ["initialize", "handshake"],
                      ["tools/list", "list 8 tools"],
                      ["tools/call · create_verification_job", ""],
                      ["tools/call · get_verification_job", "readOnly · idempotent"],
                      ["tools/call · list_verification_jobs", "readOnly · idempotent"],
                      ["tools/call · cancel_verification_job", "destructive"],
                      ["tools/call · create_share_link", "public read-only link"],
                      ["tools/call · list_share_links", "readOnly · idempotent"],
                      ["tools/call · revoke_share_links", "destructive"],
                      ["tools/call · health_check", "readOnly · idempotent"],
                    ]}
                  />
                </div>
                <CodeBlock
                  language="bash"
                  className="mt-4"
                  code={`# Async verification (default — returns 202 immediately)
curl -X POST http://localhost:3000/api/verify \\
  -H "Authorization: Bearer $VERIFY_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"repo":"0xheycat/Purr-github-MCP","ref":"main","commands":["bun install","bun test"]}'

# Sync verification (returns 200 with full final result)
curl -X POST "http://localhost:3000/api/verify?mode=sync" \\
  -H "Authorization: Bearer $VERIFY_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"repo":"0xheycat/Purr-github-MCP","ref":"main","commands":["bun install"]}'

# MCP tools/call — sync mode returns full job result
curl -X POST http://localhost:3000/mcp \\
  -H "Authorization: Bearer $VERIFY_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"create_verification_job",
                 "arguments":{"repo":"0xheycat/Purr-github-MCP","ref":"main",
                              "mode":"sync",
                              "commands":["bun install","bun test"]}}}'`}
                />
              </CardContent>
            </Card>
            </div>
            </motion.div>

            {/* Allowlist & Security */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.3 }}
            >
              <AllowlistViewer />
            </motion.div>

            {/* Server Configuration */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.35 }}
            >
              <ConfigViewer />
            </motion.div>

            {/* Keyboard shortcuts hint */}
            <div className="flex flex-wrap items-center justify-center gap-4 py-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">⌘+Enter</kbd>
                Focus form
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">⌘+K</kbd>
                Command palette
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">Esc</kbd>
                Back
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">?</kbd>
                Help
              </span>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto bg-background/80 backdrop-blur transition-colors hover:bg-amber-500/5">
        <div
          className="h-[1.5px] bg-gradient-to-r from-transparent via-amber-500/30 to-transparent animate-gradient-line"
          style={{ boxShadow: "0 -1px 12px -2px rgba(245,158,11,0.1)" }}
        />
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Cat className="h-3.5 w-3.5 text-amber-500 footer-cat-hover" />
            <span>Purr Verify MCP · allowlisted verification runner</span>
            {health?.version && (
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0 text-[10px] font-mono text-amber-700 dark:text-amber-300">
                v{health.version}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span>Not a general shell executor</span>
            <span className="opacity-40">·</span>
            <span>Fresh workspace per job</span>
            <span className="opacity-40">·</span>
            <span>Auto-cleanup</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function RefBlock({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div className="group/ref rounded-lg border bg-muted/20 p-3 transition-colors hover:border-amber-300/60 hover:bg-amber-50/20 dark:hover:border-amber-800/60 dark:hover:bg-amber-950/10">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="h-1 w-1 rounded-full bg-amber-500" />
        {title}
      </div>
      <ul className="space-y-1">
        {items.map(([k, v]) => (
          <li
            key={k}
            className="flex items-baseline justify-between gap-2 text-xs transition-colors hover:text-foreground"
          >
            <code className="font-mono text-foreground">{k}</code>
            {v && (
              <span className="rounded-full bg-muted/40 px-1.5 py-px text-[10px] text-muted-foreground">
                {v}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-muted-foreground">
          Loading…
        </div>
      }
    >
      <DashboardInner />
    </Suspense>
  );
}
