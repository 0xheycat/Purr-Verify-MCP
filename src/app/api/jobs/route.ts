// GET /api/jobs  (auth required)
// DELETE /api/jobs  (auth required) — delete all finished jobs

import { NextRequest, NextResponse } from "next/server";
import { checkAuth, unauthorized } from "@/lib/verify/auth";
import { deleteAllFinishedJobs, listHistoryJobs, loadPersisted } from "@/lib/verify/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const cursor = url.searchParams.get("cursor") || undefined;
  const page = await listHistoryJobs({ limit, cursor });
  return NextResponse.json({
    jobs: page.jobs,
    nextCursor: page.nextCursor,
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const count = await deleteAllFinishedJobs();
  return NextResponse.json({ deleted: count });
}
