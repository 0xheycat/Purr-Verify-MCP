import type { NextRequest } from "next/server";

import { createHostedJobRepository } from "../jobs/job-repository-factory";
import { resolveHostedJobTarget } from "../jobs/hosted-job-target";
import { isHostedMode } from "../runtime/deployment-mode";
import { TenantAccessError } from "../tenancy/authorization";
import { resolveHostedPrincipalFromRequest } from "../tenancy/hosted-request-context";
import { validateCommands } from "./allowlist";

interface HostedMcpMessage {
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

export interface HostedCreateJobInput {
  repo: string;
  ref: string;
  workflow: {
    version: 1;
    commands: string[];
    continueOnError: boolean;
    metadata: Record<string, unknown>;
    expectedHead: string | null;
    mode: "async";
  };
  environmentName: string | null;
}

export type HostedCreateJobParseResult =
  | { ok: true; value: HostedCreateJobInput }
  | { ok: false; message: string };

const MAX_REF_LENGTH = 255;
const MAX_ENVIRONMENT_NAME_LENGTH = 64;
const MAX_METADATA_BYTES = 16 * 1024;
const EXPECTED_HEAD_PATTERN = /^[0-9a-f]{7,40}$/i;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function parseHostedCreateJobInput(args: Record<string, unknown>): HostedCreateJobParseResult {
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";

  if (!repo) return { ok: false, message: "repo is required" };
  if (!ref) return { ok: false, message: "ref is required" };
  if (ref.length > MAX_REF_LENGTH) {
    return { ok: false, message: `ref is too long (max ${MAX_REF_LENGTH} characters)` };
  }
  if (ref.startsWith("-") || ref.includes("..") || /[~^:?*[\\\s]/.test(ref)) {
    return { ok: false, message: "ref contains unsupported characters" };
  }

  const commandValidation = validateCommands(args.commands);
  if (!commandValidation.ok || !commandValidation.commands) {
    return { ok: false, message: commandValidation.reason || "commands are invalid" };
  }
  if (args.mode === "sync") {
    return { ok: false, message: "hosted verification jobs must use mode='async'" };
  }

  const metadata = typeof args.metadata === "object" && args.metadata !== null && !Array.isArray(args.metadata)
    ? args.metadata as Record<string, unknown>
    : {};
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(metadata);
  } catch {
    return { ok: false, message: "metadata must be JSON serializable" };
  }
  if (Buffer.byteLength(metadataJson, "utf8") > MAX_METADATA_BYTES) {
    return { ok: false, message: `metadata is too large (max ${MAX_METADATA_BYTES} bytes)` };
  }

  const expectedHead = typeof args.expected_head === "string" ? args.expected_head.trim() : "";
  if (expectedHead && !EXPECTED_HEAD_PATTERN.test(expectedHead)) {
    return { ok: false, message: "expected_head must be a 7 to 40 character hexadecimal commit SHA" };
  }

  const environmentName = typeof args.environment === "string" ? args.environment.trim() : "";
  if (environmentName.length > MAX_ENVIRONMENT_NAME_LENGTH) {
    return { ok: false, message: `environment is too long (max ${MAX_ENVIRONMENT_NAME_LENGTH} characters)` };
  }
  if (environmentName && !ENVIRONMENT_NAME_PATTERN.test(environmentName)) {
    return { ok: false, message: "environment contains unsupported characters" };
  }

  return {
    ok: true,
    value: {
      repo,
      ref,
      workflow: {
        version: 1,
        commands: commandValidation.commands,
        continueOnError: args.continue_on_error === true,
        metadata,
        expectedHead: expectedHead || null,
        mode: "async",
      },
      environmentName: environmentName || null,
    },
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
      const parsed = parseHostedCreateJobInput(args);
      if (!parsed.ok) return validationFailure(id, parsed.message);

      const target = await resolveHostedJobTarget(principal, parsed.value.repo);
      const job = await repository.create(principal, {
        tenantId: target.tenantId,
        repositoryId: target.repositoryId,
        installationId: target.installationId,
        ref: parsed.value.ref,
        workflow: parsed.value.workflow,
        environmentName: parsed.value.environmentName,
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
