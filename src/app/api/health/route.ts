// GET /api/health  (public)
// Returns service health and active/queued/total job counts.

import { NextResponse } from "next/server";
import { VERSION, getConfig, isConfigured, githubTokenSource } from "@/lib/verify/config";
import { activeJobCount, queuedJobCount, totalJobCount, loadPersisted } from "@/lib/verify/store";
import { ensureScheduler } from "@/lib/verify/executor";
import type { HealthResponse } from "@/lib/verify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await loadPersisted();
  void ensureScheduler();
  const cfg = getConfig();
  const configured = isConfigured();
  const body: HealthResponse = {
    status: "ok",
    service: "purr-verify-mcp",
    time: new Date().toISOString(),
    activeJobs: activeJobCount(),
    queuedJobs: queuedJobCount(),
    totalJobs: totalJobCount(),
    version: VERSION,
    allowedRepos: cfg.allowedRepos,
    allowAllRepos: cfg.allowAllRepos,
    authMode: cfg.authMode,
    githubTokenSource: githubTokenSource(),
    configured: configured.ok,
    backgroundJobsReliable: true,
    syncModeAvailable: true,
    nodeVersion: process.version,
    bunVersion: (process.versions as unknown as { bun?: string }).bun ?? null,
    workspaceRoot: cfg.workdirBase,
    toolchainCacheRoot: cfg.toolchainCacheRoot,
    toolchainDefaultNode: cfg.toolchainDefaultNode || null,
    toolchainDefaultBun: cfg.toolchainDefaultBun || null,
    commandTimeoutMs: cfg.commandTimeoutMs,
    jobTimeoutMs: cfg.jobTimeoutMs,
  };
  return NextResponse.json(body);
}
