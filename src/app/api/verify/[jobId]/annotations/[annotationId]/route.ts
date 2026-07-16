// DELETE /api/verify/:jobId/annotations/:annotationId  (auth required)
// Remove a specific annotation from a job.

import { NextRequest, NextResponse } from "next/server";
import { checkAuth, notFound, unauthorized } from "@/lib/verify/auth";
import { getJobDurable, loadPersisted, updateJob } from "@/lib/verify/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string; annotationId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId, annotationId } = await ctx.params;
  const job = await getJobDurable(jobId);
  if (!job) return notFound(`job not found: ${jobId}`);

  const annotations = job.annotations ?? [];
  const idx = annotations.findIndex((a) => a.id === annotationId);
  if (idx === -1) return notFound(`annotation not found: ${annotationId}`);

  const updatedAnnotations = annotations.filter((a) => a.id !== annotationId);
  const updated = updateJob(jobId, { annotations: updatedAnnotations });

  if (!updated) return notFound(`job not found: ${jobId}`);

  return NextResponse.json({ deleted: true, annotationId });
}
