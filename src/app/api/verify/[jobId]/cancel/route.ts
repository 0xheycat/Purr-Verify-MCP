// POST /api/verify/:jobId/cancel  (auth required)
// Request cancellation of a running or queued job.

import { NextRequest, NextResponse } from "next/server";
import { checkAuth, notFound, unauthorized } from "@/lib/verify/auth";
import { getJob, loadPersisted } from "@/lib/verify/store";
import { requestCancel } from "@/lib/verify/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId } = await ctx.params;
  const job = getJob(jobId);
  if (!job) return notFound(`job not found: ${jobId}`);

  const canceled = requestCancel(jobId);
  return NextResponse.json({
    jobId,
    canceled,
    status: getJob(jobId)?.status,
  });
}
