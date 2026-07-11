import type { NextRequest } from "next/server";

import { createHostedJobRepository } from "../jobs/job-repository-factory";
import { resolveHostedJobTarget } from "../jobs/hosted-job-target";
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
  return name === "cancel_verification_job" || name === "create_verification_job"
    ? ["verify:read", "verify:write"]
    : ["verify:read"];
}

function validationFailure(id: string | number | null, message: string) {
  return rpcResult(id, {
    content: [toText({ error: "validation_failed", message })],
    isError: true,
  });
}

function hostedWorkflow(args: Record<string, unknown>) {
  return {
    version: 1,
    commands: Array.isArray(args.commands) ? args.commands : [],
    continueOnError: args.continue_on_error === true,
    metadata: typeof args.metadata === "object" && args.metadata !== null ? args.metadata : {},
    expectedHead: typeof args.expected_head === "string" ? args.expected_head : null,
    mode: "async",
  };
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
    name !== "cancel_verification_job" &&
    name !== "create_verification_job"
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
    if (name === "create_verification_job") {
      const repo = typeof args.repo === "string" ? args.repo.trim() : "";
      const ref = typeof args.ref === "string" ? args.ref.trim() : "";
      const commands = Array.isArray(args.commands)
        ? args.commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
        : [];

      if (!repo) return validationFailure(id, "repo is required");
      if (!ref) return validationFailure(id, "ref is required");
      if (commands.length === 0) return validationFailure(id, "commands must contain at least one command");
      if (args.mode === "sync") {
        return validationFailure(id, "hosted verification jobs must use mode='async'");
      }

      const target = await resolveHostedJobTarget(principal, repo);
      const job = await repository.create(principal, {
        tenantId: target.tenantId,
        repositoryId: target.repositoryId,
        installationId: target.installationId,
        ref,
        workflow: hostedWorkflow({ ...args, commands }),
        environmentName: typeof args.environment === "string" ? args.environment.trim() || null : null,
        createdByClientId: principal.clientId ?? null,
      });

      return rpcResult(id, {
        content: [toText({
          jobId: job.id,
          status: job.status,
          repository: target.fullName,
          ref: job.ref,
          statusUrl: `/api/jobs/${job.id}`,
        })],
        isError: false,
      });
    }

    if (name === "get_verification_job" || name === "cancel_verification_job") {
      const jobId = String(args.jobId || "");
      if (!jobId) {
        return validationFailure(id, "jobId is required");
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
        content: [toText({ error: "not_found", message: name === "create_verification_job" ? "Repository not found" : "Job not found" })],
        isError: true,
      });
    }
    throw error;
  }
}
