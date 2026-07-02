// GET /api/verify/:jobId/queue-position  (auth required)
// Returns the queue position for a queued job, plus the total queued count and
// an estimated wait time (position * avgJobDurationMs). Returns position=null
// for jobs that are not currently queued.

import { NextRequest, NextResponse } from "next/server";
import { checkAuth, notFound, unauthorized } from "@/lib/verify/auth";
import {
  getAverageJobDurationMs,
  getJob,
  getQueuePosition,
  getQueuedTotal,
  loadPersisted,
} from "@/lib/verify/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId } = await ctx.params;

  const job = getJob(jobId);
  if (!job) return notFound(`job not found: ${jobId}`);

  const position = getQueuePosition(jobId);
  const totalQueued = getQueuedTotal();
  const avgDurationMs = getAverageJobDurationMs();
  const estimatedWaitMs =
    position != null && avgDurationMs != null ? position * avgDurationMs : null;

  return NextResponse.json({
    jobId,
    position,
    totalQueued,
    estimatedWaitMs,
  });
}
