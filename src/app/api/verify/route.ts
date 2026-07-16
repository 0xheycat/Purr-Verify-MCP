// POST /api/verify  (auth required)
// Create a verification job.
//
// mode=auto is the default. One short smoke command can run inline, while
// long-running or multi-command work is queued automatically. Explicit async
// always queues. Explicit sync remains available for short work and safely
// falls back to async instead of rejecting long-running commands.

import { NextRequest, NextResponse } from "next/server";
import { badRequest, checkAuth, unauthorized } from "@/lib/verify/auth";
import { resolveExecutionMode } from "@/lib/verify/execution-policy";
import { validateCreateInput } from "@/lib/verify/mcp";
import { enqueueJob, ensureScheduler, runJobSync } from "@/lib/verify/executor";
import type { VerifyRequest } from "@/lib/verify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return badRequest("invalid JSON body");
  }

  const validation = validateCreateInput(body);
  if (!validation.ok) {
    return badRequest(validation.reason || "validation failed");
  }

  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode")?.toLowerCase().trim();
  const requestedMode =
    modeParam === "sync" || modeParam === "async" || modeParam === "auto"
      ? modeParam
      : body.mode;
  const routing = resolveExecutionMode(requestedMode, validation.commands!);
  const metadata = (body.metadata as Record<string, unknown>) || {};

  const jobInput = {
    repo: body.repo,
    ref: body.ref,
    expected_head: body.expected_head,
    commands: validation.commands!,
    continue_on_error: !!body.continue_on_error,
    metadata: { ...metadata, _purrExecution: routing },
    callback_url: body.callback_url?.trim() || undefined,
    tags: validation.tags,
    // Per-request GitHub clone token (github_passthrough mode). Forwarded to
    // the in-memory runtime so the executor can clone private repos with the
    // caller's PAT. Undefined in server_token mode uses env GITHUB_TOKEN.
    githubToken: auth.githubToken,
    env: validation.env,
    resolutionProbePackages: validation.resolutionProbePackages,
    resolutionProbeModules: validation.resolutionProbeModules,
    timeoutPolicy: validation.timeoutPolicy,
    execution: routing,
  };

  if (routing.effectiveMode === "sync") {
    const finalJob = await runJobSync(jobInput);
    return NextResponse.json(finalJob, { status: 200 });
  }

  void ensureScheduler();
  const job = await enqueueJob(jobInput);

  return NextResponse.json(
    {
      jobId: job.jobId,
      status: job.status,
      statusUrl: `/api/verify/${job.jobId}`,
      ...routing,
    },
    { status: 202 }
  );
}

export async function GET() {
  // Convenience: GET /api/verify returns recent jobs (alias of /api/jobs).
  const { listJobs, loadPersisted } = await import("@/lib/verify/store");
  await loadPersisted();
  return NextResponse.json({ jobs: listJobs(50) });
}
