// POST /api/verify  (auth required)
// Create a verification job.
//
// Query param `mode` controls execution strategy:
//   - mode=async (default): queues the job for background execution.
//     Returns HTTP 202 with { jobId, status: "queued", statusUrl }.
//   - mode=sync: runs the job inline within this HTTP request, waits for
//     completion, and returns HTTP 200 with the full final job result
//     (including commands, summary, cleanupStatus, etc.).
//
// Both modes validate auth/repo/commands identically, create a job record,
// enforce COMMAND_TIMEOUT_MS and JOB_TIMEOUT_MS, and always clean up the
// workspace in a finally block.

import { NextRequest, NextResponse } from "next/server";
import { badRequest, checkAuth, unauthorized } from "@/lib/verify/auth";
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

  // Determine execution mode from query string.
  // Default is "async". Explicit "sync" runs the job inline.
  const url = new URL(req.url);
  const modeParam = url.searchParams.get("mode")?.toLowerCase().trim();
  const mode: "sync" | "async" =
    modeParam === "sync" ? "sync" : "async";

  // Also allow the mode to be specified in the request body (convenience for
  // clients that can't easily set query params). Body mode is overridden by
  // the query param if both are present.
  const effectiveMode = modeParam
    ? mode
    : body.mode === "sync"
      ? "sync"
      : "async";

  const jobInput = {
    repo: body.repo,
    ref: body.ref,
    expected_head: body.expected_head,
    commands: validation.commands!,
    continue_on_error: !!body.continue_on_error,
    metadata: (body.metadata as Record<string, unknown>) || {},
    callback_url: body.callback_url?.trim() || undefined,
    tags: validation.tags,
    // Per-request GitHub clone token (github_passthrough mode). Forwarded to
    // the in-memory runtime so the executor can clone private repos with the
    // caller's PAT. Undefined in server_token mode → executor uses env
    // GITHUB_TOKEN. Never persisted to disk.
    githubToken: auth.githubToken,
    env: validation.env,
    resolutionProbePackages: validation.resolutionProbePackages,
    resolutionProbeModules: validation.resolutionProbeModules,
    timeoutPolicy: validation.timeoutPolicy,
  };

  if (effectiveMode === "sync") {
    // Synchronous mode: run the job inline and return the final result.
    // The job is marked "running" immediately inside runJobSync to prevent
    // the background scheduler from also picking it up.
    const finalJob = await runJobSync(jobInput);

    return NextResponse.json(finalJob, { status: 200 });
  }

  // Asynchronous mode (default): queue the job and return immediately.
  void ensureScheduler();
  const job = await enqueueJob(jobInput);

  return NextResponse.json(
    {
      jobId: job.jobId,
      status: job.status,
      statusUrl: `/api/verify/${job.jobId}`,
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
