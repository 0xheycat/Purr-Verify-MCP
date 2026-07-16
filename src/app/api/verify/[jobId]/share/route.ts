// POST /api/verify/:jobId/share  (auth required) — create a share token
// GET  /api/verify/:jobId/share  (auth required) — list active share tokens
// DELETE /api/verify/:jobId/share  (auth required) — revoke all share tokens for a job

import { NextRequest, NextResponse } from "next/server";
import { badRequest, checkAuth, notFound, unauthorized } from "@/lib/verify/auth";
import { getJobDurable, loadPersisted } from "@/lib/verify/store";
import {
  createShareToken,
  listShareTokensForJob,
  revokeAllForJob,
} from "@/lib/verify/share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap note length to keep persistence tidy.
const MAX_NOTE_LEN = 200;

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

  // Optional body: { ttlHours?: number, note?: string }
  let body: { ttlHours?: unknown; note?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return badRequest("invalid JSON body");
  }

  const ttlHours =
    typeof body.ttlHours === "number" && Number.isFinite(body.ttlHours)
      ? Math.floor(body.ttlHours)
      : undefined;
  if (ttlHours !== undefined && (ttlHours < 1 || ttlHours > 24 * 7)) {
    return badRequest("ttlHours must be between 1 and 168 (7 days)");
  }

  let note: string | undefined;
  if (typeof body.note === "string") {
    note = body.note.trim().slice(0, MAX_NOTE_LEN);
  }

  try {
    const t = await createShareToken(jobId, { ttlHours, note });
    // Build the absolute share URL (best-effort; fall back to relative).
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const shareUrl = `${origin}/?share=${t.token}`;
    return NextResponse.json(
      {
        token: t.token,
        jobId: t.jobId,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        note: t.note,
        shareUrl,
        ttlHours: ttlHours ?? 24,
      },
      { status: 201 }
    );
  } catch (e) {
    return badRequest(`failed to create share token: ${(e as Error).message}`);
  }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId } = await ctx.params;
  const job = await getJobDurable(jobId);
  if (!job) return notFound(`job not found: ${jobId}`);

  const tokens = await listShareTokensForJob(jobId);
  // Build absolute share URLs for each token so the client doesn't have to
  // construct them. The origin comes from the request URL.
  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  const tokensWithUrls = tokens.map((t) => ({
    token: t.token,
    jobId: t.jobId,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    note: t.note ?? null,
    shareUrl: `${origin}/?share=${t.token}`,
    ttlHours: Math.max(
      1,
      Math.round(
        (new Date(t.expiresAt).getTime() - new Date(t.createdAt).getTime()) /
          (60 * 60 * 1000)
      ),
    ),
  }));
  return NextResponse.json({ jobId, tokens: tokensWithUrls });
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId } = await ctx.params;
  const job = await getJobDurable(jobId);
  if (!job) return notFound(`job not found: ${jobId}`);

  const n = await revokeAllForJob(jobId);
  return NextResponse.json({ jobId, revoked: n });
}
