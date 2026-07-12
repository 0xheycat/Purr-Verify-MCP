// GET /api/jobs  (auth required)
// DELETE /api/jobs  (auth required) — delete all finished jobs in self-hosted mode

import { NextRequest, NextResponse } from "next/server";
import { checkAuth, unauthorized } from "@/lib/verify/auth";
import { deleteAllFinishedJobs, listJobs, loadPersisted } from "@/lib/verify/store";
import { isHostedMode } from "@/lib/runtime/deployment-mode";
import { createHostedJobRepository } from "@/lib/jobs/job-repository-factory";
import { resolveHostedPrincipalFromRequest } from "@/lib/tenancy/hosted-request-context";
import { PrincipalContextError } from "@/lib/tenancy/request-principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hostedAuthFailure(error: unknown): NextResponse {
  if (error instanceof PrincipalContextError) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  console.error("Hosted jobs request failed", error);
  return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  if (isHostedMode()) {
    try {
      const principal = await resolveHostedPrincipalFromRequest(req);
      if (!principal) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

      const url = new URL(req.url);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const repository = await createHostedJobRepository();
      const jobs = (await repository.list(principal)).slice(0, limit);
      return NextResponse.json({ jobs });
    } catch (error) {
      return hostedAuthFailure(error);
    }
  }

  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const jobs = listJobs(limit);
  return NextResponse.json({ jobs });
}

export async function DELETE(req: NextRequest) {
  if (isHostedMode()) {
    // Hosted bulk deletion needs explicit tenant and ownership semantics. Keep it
    // unavailable rather than accidentally applying the legacy global operation.
    return NextResponse.json(
      { error: "bulk_delete_not_supported" },
      { status: 405, headers: { Allow: "GET" } },
    );
  }

  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const count = await deleteAllFinishedJobs();
  return NextResponse.json({ deleted: count });
}
