// GET /api/health  (public)
// Returns service health and active/queued/total job counts.

import { NextResponse } from "next/server";
import {
  MAX_LONG_RUN_TIMEOUT_MS,
  VERSION,
  effectiveDefaultTimeouts,
  getConfig,
  githubTokenSource,
  isConfigured,
} from "@/lib/verify/config";
import {
  activeJobCount,
  loadPersisted,
  queuedJobCount,
  totalJobCount,
} from "@/lib/verify/store";
import { ensureScheduler } from "@/lib/verify/executor";
import { runnerTools } from "@/lib/verify/system-tools";
import type { HealthResponse } from "@/lib/verify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await loadPersisted();
  void ensureScheduler();
  const cfg = getConfig();
  const timeouts = effectiveDefaultTimeouts(cfg);
  const configured = isConfigured();
  const tools = await runnerTools();
  const body: HealthResponse & {
    oauthStorage: {
      mode: "json" | "prisma";
      multiInstanceSafe: boolean;
      notes: string[];
    };
  } = {
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
    oauthStorage: {
      mode: cfg.oauthStorageMode,
      multiInstanceSafe: cfg.oauthStorageMode === "prisma",
      notes:
        cfg.oauthStorageMode === "prisma"
          ? [
              "Shared transactional OAuth storage is selected.",
              "Confirm DATABASE_URL points at migrated Prisma tables before scaling instances.",
            ]
          : [
              "Local JSON OAuth storage supports one active instance only.",
              "Set OAUTH_STORAGE_MODE=prisma after deploying the OAuth Prisma tables and DATABASE_URL.",
            ],
    },
    configured: configured.ok,
    backgroundJobsReliable: true,
    syncModeAvailable: true,
    autoModeAvailable: true,
    nodeVersion: process.version,
    bunVersion: (process.versions as unknown as { bun?: string }).bun ?? null,
    workspaceRoot: cfg.workdirBase,
    toolchainCacheRoot: cfg.toolchainCacheRoot,
    toolchainDefaultNode: cfg.toolchainDefaultNode || null,
    toolchainDefaultBun: cfg.toolchainDefaultBun || null,
    commandTimeoutMs: timeouts.commandTimeoutMs,
    configuredCommandTimeoutMs: timeouts.configuredCommandTimeoutMs,
    jobTimeoutMs: timeouts.jobTimeoutMs,
    timeoutWarnings: timeouts.warnings,
    maxLongRunTimeoutMs: MAX_LONG_RUN_TIMEOUT_MS,
    runnerTools: tools,
  };
  return NextResponse.json(body);
}
