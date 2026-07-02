// POST /api/verify/:jobId/webhook/retry  (auth required)
// Manually re-fire the webhook for a job. Useful when the automatic delivery
// failed (e.g., the callback endpoint was temporarily down) and the user
// wants to retry without re-running the whole verification job.

import { NextRequest, NextResponse } from "next/server";
import { checkAuth, notFound, unauthorized } from "@/lib/verify/auth";
import { getJob, loadPersisted } from "@/lib/verify/store";
import { retryCallback } from "@/lib/verify/executor";

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

  if (!job.callback_url) {
    return NextResponse.json(
      { message: "job has no callback_url to retry" },
      { status: 400 }
    );
  }

  const result = await retryCallback(jobId);
  return NextResponse.json({
    jobId,
    ...result,
  });
}
