import type { NextRequest } from "next/server";

import { createHostedJobRepository } from "../jobs/job-repository-factory";
import { isHostedMode } from "../runtime/deployment-mode";
import { TenantAccessError } from "../tenancy/authorization";
import { resolveHostedPrincipalFromRequest } from "../tenancy/hosted-request-context";

interface HostedMcpMessage {
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function toText(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

function requiredScopesForTool(name: string): readonly string[] {
  return name === "cancel_verification_job"
    ? ["verify:read", "verify:write"]
    : ["verify:read"];
}

export async function handleHostedMcpJobRead(
  req: NextRequest,
  message: HostedMcpMessage,
): Promise<Record<string, unknown> | null> {
  if (!isHostedMode() || message.method !== "tools/call") return null;

  const name = message.params?.name;
  if (
    name !== "get_verification_job" &&
    name !== "list_verification_jobs" &&
    name !== "cancel_verification_job"
  ) {
    return null;
  }

  const id = message.id ?? null;
  const principal = await resolveHostedPrincipalFromRequest(req, requiredScopesForTool(name));
  if (!principal) {
    return rpcError(id, -32001, "Unauthorized");
  }

  const repository = await createHostedJobRepository();
  const args = message.params?.arguments || {};

  try {
    if (name === "get_verification_job" || name === "cancel_verification_job") {
      const jobId = String(args.jobId || "");
      if (!jobId) {
        return rpcResult(id, {
          content: [toText({ error: "validation_failed", message: "jobId is required" })],
          isError: true,
        });
      }

      const job = name === "cancel_verification_job"
        ? await repository.cancel(principal, jobId)
        : await repository.get(principal, jobId);
      return rpcResult(id, { content: [toText(job)], isError: false });
    }

    const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
    const jobs = (await repository.list(principal)).slice(0, limit);
    return rpcResult(id, { content: [toText({ jobs })], isError: false });
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return rpcResult(id, {
        content: [toText({ error: "not_found", message: "Job not found" })],
        isError: true,
      });
    }
    throw error;
  }
}
