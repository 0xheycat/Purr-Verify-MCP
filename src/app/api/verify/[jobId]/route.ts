// GET /api/verify/:jobId  (auth required)
// PATCH /api/verify/:jobId  (auth required) — update tags on a job
// DELETE /api/verify/:jobId  (auth required) — delete a finished job

import { NextRequest, NextResponse } from "next/server";
import { badRequest, checkAuth, notFound, unauthorized } from "@/lib/verify/auth";
import { deleteJob, getJob, loadPersisted } from "@/lib/verify/store";
import { updateJobTags } from "@/lib/verify/executor";
import { validateTags } from "@/lib/verify/mcp";
import { jobToMarkdown } from "@/lib/verify/markdown";

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

  // Optional ?format=markdown returns a PR-ready summary.
  const url = new URL(req.url);
  if (url.searchParams.get("format") === "markdown") {
    return NextResponse.json({ jobId, markdown: jobToMarkdown(job) });
  }
  return NextResponse.json(job);
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId } = await ctx.params;
  const existing = getJob(jobId);
  if (!existing) return notFound(`job not found: ${jobId}`);

  let body: { tags?: unknown };
  try {
    body = (await req.json()) as { tags?: unknown };
  } catch {
    return badRequest("invalid JSON body");
  }

  if (!body || !Array.isArray(body.tags)) {
    return badRequest("expected { tags: string[] }");
  }

  const tv = validateTags(body.tags);
  if (!tv.ok) {
    return badRequest(tv.reason || "invalid tags");
  }

  const updated = await updateJobTags(jobId, tv.tags);
  if (!updated) return notFound(`job not found: ${jobId}`);

  return NextResponse.json({ jobId: updated.jobId, tags: updated.tags ?? [] });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId } = await ctx.params;
  const job = getJob(jobId);
  if (!job) return notFound(`job not found: ${jobId}`);

  if (job.status === "running" || job.status === "queued") {
    return badRequest("cannot delete a running or queued job");
  }

  const deleted = await deleteJob(jobId);
  if (!deleted) return notFound(`job not found: ${jobId}`);

  return NextResponse.json({ deleted: true, jobId });
}
