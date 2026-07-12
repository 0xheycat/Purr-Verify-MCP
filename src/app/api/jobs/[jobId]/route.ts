// Hosted per-job REST boundary.
// GET    /api/jobs/:jobId        — read one tenant-visible job
// PATCH  /api/jobs/:jobId        — currently supports { action: "cancel" }
// DELETE /api/jobs/:jobId        — delete one job when the principal may mutate it

import { NextRequest, NextResponse } from "next/server";
import { createHostedJobRepository } from "@/lib/jobs/job-repository-factory";
import { isHostedMode } from "@/lib/runtime/deployment-mode";
import { TenantAccessError } from "@/lib/tenancy/authorization";
import { resolveHostedPrincipalFromRequest } from "@/lib/tenancy/hosted-request-context";
import { PrincipalContextError } from "@/lib/tenancy/request-principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

function unavailableInSelfHosted(): NextResponse {
  return NextResponse.json(
    { error: "hosted_job_route_unavailable" },
    { status: 404 },
  );
}

function hostedFailure(error: unknown): NextResponse {
  if (error instanceof PrincipalContextError) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (error instanceof TenantAccessError) {
    // Do not reveal whether the job exists outside the caller's tenants.
    return NextResponse.json({ error: "job_not_found" }, { status: 404 });
  }

  console.error("Hosted job request failed", error);
  return NextResponse.json({ error: "internal_server_error" }, { status: 500 });
}

async function resolveRequest(req: NextRequest, context: RouteContext) {
  const principal = await resolveHostedPrincipalFromRequest(req);
  if (!principal) throw new PrincipalContextError("Hosted authentication required.");

  const { jobId } = await context.params;
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) throw new TenantAccessError();

  return {
    principal,
    jobId: normalizedJobId,
    repository: await createHostedJobRepository(),
  };
}

export async function GET(req: NextRequest, context: RouteContext) {
  if (!isHostedMode()) return unavailableInSelfHosted();

  try {
    const { principal, jobId, repository } = await resolveRequest(req, context);
    const job = await repository.get(principal, jobId);
    return NextResponse.json({ job });
  } catch (error) {
    return hostedFailure(error);
  }
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  if (!isHostedMode()) return unavailableInSelfHosted();

  try {
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== "cancel") {
      return NextResponse.json(
        { error: "unsupported_action" },
        { status: 400 },
      );
    }

    const { principal, jobId, repository } = await resolveRequest(req, context);
    const job = await repository.cancel(principal, jobId);
    return NextResponse.json({ job });
  } catch (error) {
    return hostedFailure(error);
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  if (!isHostedMode()) return unavailableInSelfHosted();

  try {
    const { principal, jobId, repository } = await resolveRequest(req, context);
    await repository.delete(principal, jobId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return hostedFailure(error);
  }
}
