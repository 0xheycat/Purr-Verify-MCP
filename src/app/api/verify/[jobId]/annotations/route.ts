// POST /api/verify/:jobId/annotations  (auth required)
// Add an annotation (note) to a job.

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { badRequest, checkAuth, notFound, unauthorized } from "@/lib/verify/auth";
import { getJobDurable, loadPersisted, updateJob } from "@/lib/verify/store";
import type { JobAnnotation } from "@/lib/verify/types";

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
  const job = await getJobDurable(jobId);
  if (!job) return notFound(`job not found: ${jobId}`);

  let body: { text?: unknown; author?: unknown };
  try {
    body = (await req.json()) as { text?: unknown; author?: unknown };
  } catch {
    return badRequest("invalid JSON body");
  }

  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return badRequest("expected { text: string }");
  }

  const text = (body.text as string).trim();
  if (text.length > 2000) {
    return badRequest("annotation text must be ≤ 2000 characters");
  }

  const author =
    typeof body.author === "string" && body.author.trim()
      ? body.author.trim().slice(0, 100)
      : undefined;

  const annotation: JobAnnotation = {
    id: randomUUID(),
    text,
    createdAt: new Date().toISOString(),
    author,
  };

  const existing = job.annotations ?? [];
  const updated = updateJob(jobId, {
    annotations: [...existing, annotation],
  });

  if (!updated) return notFound(`job not found: ${jobId}`);

  return NextResponse.json(annotation, { status: 201 });
}
