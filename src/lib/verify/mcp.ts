// MCP-style JSON-RPC 2.0 handler for POST /mcp.
//
// Supports methods: initialize, tools/list, tools/call.
// Tools exposed:
//   - create_verification_job
//   - get_verification_job
//   - list_verification_jobs
//   - cancel_verification_job
//   - list_allowed_commands
//   - health_check

import { NextRequest, NextResponse } from "next/server";
import { VERSION, getConfig, isConfigured, isRepoAllowed, isValidHead, isValidRef, githubTokenSource } from "./config";
import { checkAuth, unauthorized } from "./auth";
import { validateCommands, listPatterns } from "./allowlist";
import { enqueueJob, requestCancel, runJobSync } from "./executor";
import { getJob, listJobs, loadPersisted } from "./store";
import { activeJobCount, queuedJobCount, totalJobCount } from "./store";
import {
  createShareToken,
  listShareTokensForJob,
  revokeAllForJob,
} from "./share";
import type { HealthResponse, Job, VerifyRequest } from "./types";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "create_verification_job",
    description:
      "Create a verification job that clones a repo/ref and runs allowlisted commands (e.g. bun install, bun test, bun run build). In async mode (default), returns a jobId and statusUrl immediately. In sync mode, runs the job to completion inline and returns the full final job result (including commands, summary, cleanupStatus). AUTH: send your Bearer token per the server's AUTH_MODE — server_token mode expects VERIFY_TOKEN; github_passthrough mode expects a GitHub PAT (the PAT is validated via the GitHub API and used to clone private repos).",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo slug (e.g. octocat/Hello-World). Accepted when it matches /^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/ AND is listed in ALLOWED_REPOS, OR when the server is in unrestricted mode (ALLOWED_REPOS empty/'*', or ALLOW_ALL_REPOS=true). Arbitrary git URLs are never accepted; cloning is always from https://github.com/<owner>/<repo>.git" },
        ref: { type: "string", description: "branch or tag" },
        expected_head: { type: "string", description: "optional short or full SHA to verify" },
        commands: { type: "array", items: { type: "string" }, description: "allowlisted commands to run sequentially" },
        continue_on_error: { type: "boolean", default: false },
        metadata: { type: "object" },
        callback_url: { type: "string", description: "optional HTTPS URL to POST a {event,jobId,status,...} payload when the job finishes" },
        tags: { type: "array", items: { type: "string" }, description: "optional free-form tags for organization (max 10, 1-30 chars, alphanumeric + dash/underscore)" },
        mode: {
          type: "string",
          enum: ["sync", "async"],
          default: "async",
          description: "Execution mode: 'async' (default) queues the job and returns immediately with a jobId; 'sync' runs the job inline and returns the full final result. Sync mode blocks until the job completes (subject to JOB_TIMEOUT_MS).",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional environment variables (string values) injected into every command's process environment. Values may contain secrets — they are redacted from stored logs, results, and share links, and are never persisted to disk. Reserved keys (PATH, NODE_PATH, NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES) are rejected. Max 50 vars.",
        },
        resolution_probe: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            {
              type: "object",
              properties: { packages: { type: "array", items: { type: "string" } } },
              required: ["packages"],
            },
          ],
          description: "Optional diagnostic package list. After a successful install, the runner reports each package's resolved entry file and inferred ESM/CJS format from the cloned workspace.",
        },
      },
      required: ["repo", "ref", "commands"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "get_verification_job",
    description: "Get the full status and result of a verification job by jobId.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "list_verification_jobs",
    description: "List recent verification jobs (most recent first).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 50 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "cancel_verification_job",
    description: "Request cancellation of a running or queued verification job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "health_check",
    description: "Return service health and active job counts.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "list_allowed_commands",
    description:
      "List the allowlisted command patterns this runner will execute. Any command that does not match one of these exact grammars is rejected before a job runs. Use this to discover what can be passed in `commands`.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "create_share_link",
    description:
      "Create a temporary public read-only share link for a finished verification job. The link allows anyone with the URL to view the job's result (no token required). Sensitive fields (callback URLs, webhook deliveries) are stripped from the public view. Returns a share URL and expiry timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "ID of the job to share" },
        ttlHours: {
          type: "number",
          description: "Time-to-live in hours (default 24, max 168 = 7 days)",
          default: 24,
        },
        note: {
          type: "string",
          description: "Optional note (max 200 chars) — e.g., 'PR review', 'Slack share'",
        },
      },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "list_share_links",
    description: "List active (non-expired, non-revoked) share links for a verification job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "revoke_share_links",
    description: "Revoke all active share links for a verification job. The shared URLs will immediately stop working.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function toText(obj: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(obj, null, 2) };
}

function publicJob(job: Job | undefined) {
  if (!job) return null;
  return job;
}

export async function handleMcp(req: NextRequest): Promise<NextResponse> {
  const id: string | number | null = null;
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = (await req.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return NextResponse.json(rpcError(id, -32700, "Parse error"), { status: 200 });
  }

  const handleOne = async (r: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const rid = r.id ?? null;
    const method = r.method;

    // initialize and tools/list do not require auth per common MCP usage, but
    // we still gate tools/call behind the bearer token since it mutates state.
    if (method === "initialize") {
      return rpcResult(rid, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "purr-verify-mcp", version: VERSION },
      });
    }

    if (method === "tools/list") {
      return rpcResult(rid, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });
    }

    if (method === "tools/call") {
      // Auth required for tool calls.
      const auth = await checkAuth(req);
      if (!auth.ok) {
        return rpcError(rid, -32001, `Unauthorized: ${auth.reason}`);
      }
      const params = (r.params || {}) as { name?: string; arguments?: Record<string, unknown> };
      const name = params.name;
      const args = params.arguments || {};
      try {
        switch (name) {
          case "health_check": {
            await loadPersisted();
            const cfg = getConfig();
            const configured = isConfigured();
            const health: HealthResponse = {
              status: "ok",
              service: "purr-verify-mcp",
              time: new Date().toISOString(),
              activeJobs: activeJobCount(),
              queuedJobs: queuedJobCount(),
              totalJobs: totalJobCount(),
              version: VERSION,
              allowedRepos: cfg.allowedRepos,
              allowAllRepos: cfg.allowAllRepos,
              authMode: cfg.authMode,
              githubTokenSource: githubTokenSource(),
              configured: configured.ok,
              backgroundJobsReliable: true,
              syncModeAvailable: true,
              nodeVersion: process.version,
              bunVersion: (process.versions as unknown as { bun?: string }).bun ?? null,
              workspaceRoot: cfg.workdirBase,
              toolchainCacheRoot: cfg.toolchainCacheRoot,
              toolchainDefaultNode: cfg.toolchainDefaultNode || null,
              toolchainDefaultBun: cfg.toolchainDefaultBun || null,
              commandTimeoutMs: cfg.commandTimeoutMs,
              jobTimeoutMs: cfg.jobTimeoutMs,
            };
            return rpcResult(rid, { content: [toText(health)], isError: false });
          }
          case "list_allowed_commands": {
            return rpcResult(rid, {
              content: [toText({ patterns: listPatterns() })],
              isError: false,
            });
          }
          case "list_verification_jobs": {
            await loadPersisted();
            const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
            const jobs = listJobs(limit);
            return rpcResult(rid, { content: [toText({ jobs })], isError: false });
          }
          case "get_verification_job": {
            await loadPersisted();
            const jobId = String(args.jobId || "");
            const job = publicJob(getJob(jobId));
            if (!job) return rpcError(rid, -32602, `Job not found: ${jobId}`);
            return rpcResult(rid, { content: [toText(job)], isError: false });
          }
          case "cancel_verification_job": {
            await loadPersisted();
            const jobId = String(args.jobId || "");
            const ok = requestCancel(jobId);
            return rpcResult(rid, {
              content: [toText({ jobId, canceled: ok, status: getJob(jobId)?.status })],
              isError: false,
            });
          }
          case "create_verification_job": {
            const input = args as unknown as VerifyRequest;
            const validation = validateCreateInput(input);
            if (!validation.ok) {
              return rpcResult(rid, {
                content: [toText({ error: "validation_failed", message: validation.reason })],
                isError: true,
              });
            }
            const jobInput = {
              repo: input.repo,
              ref: input.ref,
              expected_head: input.expected_head,
              commands: validation.commands!,
              continue_on_error: !!input.continue_on_error,
              metadata: (input.metadata as Record<string, unknown>) || {},
              callback_url: input.callback_url?.trim() || undefined,
              tags: validation.tags,
              // Per-request GitHub clone token (github_passthrough mode).
              githubToken: auth.githubToken,
              // Optional per-job env injection (validated + redacted from logs).
              env: validation.env,
              resolutionProbePackages: validation.resolutionProbePackages,
            };

            // Determine execution mode. Default is "async".
            const mode: "sync" | "async" =
              input.mode === "sync" ? "sync" : "async";

            if (mode === "sync") {
              // Synchronous mode: run the job inline and return the full
              // final result (status, commands, summary, cleanupStatus, etc.).
              const finalJob = await runJobSync(jobInput);
              return rpcResult(rid, {
                content: [toText(finalJob)],
                isError: false,
              });
            }

            // Asynchronous mode (default): queue and return immediately.
            const job = await enqueueJob(jobInput);
            return rpcResult(rid, {
              content: [
                toText({
                  jobId: job.jobId,
                  status: job.status,
                  statusUrl: `/api/verify/${job.jobId}`,
                }),
              ],
              isError: false,
            });
          }
          case "create_share_link": {
            await loadPersisted();
            const jobId = String(args.jobId || "");
            if (!jobId) {
              return rpcResult(rid, {
                content: [toText({ error: "validation_failed", message: "jobId is required" })],
                isError: true,
              });
            }
            const job = getJob(jobId);
            if (!job) {
              return rpcResult(rid, {
                content: [toText({ error: "not_found", message: `Job not found: ${jobId}` })],
                isError: true,
              });
            }
            let ttlHours: number | undefined;
            if (typeof args.ttlHours === "number" && Number.isFinite(args.ttlHours)) {
              ttlHours = Math.floor(args.ttlHours);
              if (ttlHours < 1 || ttlHours > 168) {
                return rpcResult(rid, {
                  content: [toText({ error: "validation_failed", message: "ttlHours must be between 1 and 168" })],
                  isError: true,
                });
              }
            }
            let note: string | undefined;
            if (typeof args.note === "string") {
              note = args.note.trim().slice(0, 200);
            }
            try {
              const t = await createShareToken(jobId, { ttlHours, note });
              // Build a relative share URL; the caller can resolve to absolute
              // using their own host. We also include the token so they can
              // construct the URL either way.
              return rpcResult(rid, {
                content: [
                  toText({
                    token: t.token,
                    jobId: t.jobId,
                    createdAt: t.createdAt,
                    expiresAt: t.expiresAt,
                    note: t.note,
                    shareUrl: `/?share=${t.token}`,
                    shareUrlRelative: `/?share=${t.token}`,
                  }),
                ],
                isError: false,
              });
            } catch (e) {
              return rpcResult(rid, {
                content: [toText({ error: "tool_error", message: (e as Error).message })],
                isError: true,
              });
            }
          }
          case "list_share_links": {
            await loadPersisted();
            const jobId = String(args.jobId || "");
            if (!jobId) {
              return rpcResult(rid, {
                content: [toText({ error: "validation_failed", message: "jobId is required" })],
                isError: true,
              });
            }
            const tokens = await listShareTokensForJob(jobId);
            return rpcResult(rid, {
              content: [toText({ jobId, tokens })],
              isError: false,
            });
          }
          case "revoke_share_links": {
            await loadPersisted();
            const jobId = String(args.jobId || "");
            if (!jobId) {
              return rpcResult(rid, {
                content: [toText({ error: "validation_failed", message: "jobId is required" })],
                isError: true,
              });
            }
            const revoked = await revokeAllForJob(jobId);
            return rpcResult(rid, {
              content: [toText({ jobId, revoked })],
              isError: false,
            });
          }
          default:
            return rpcError(rid, -32601, `Unknown tool: ${name}`);
        }
      } catch (e) {
        return rpcResult(rid, {
          content: [toText({ error: "tool_error", message: (e as Error).message })],
          isError: true,
        });
      }
    }

    return rpcError(rid, -32601, `Method not found: ${method}`);
  };

  if (Array.isArray(body)) {
    const results = await Promise.all(body.map(handleOne));
    return NextResponse.json(results, { status: 200 });
  }
  const resp = await handleOne(body);
  return NextResponse.json(resp, { status: 200 });
}

// Shared validation used by REST + MCP.
export function validateCreateInput(input: VerifyRequest): {
  ok: boolean;
  reason?: string;
  commands?: string[];
  tags?: string[];
  env?: Record<string, string>;
  resolutionProbePackages?: string[];
} {
  if (!input || typeof input !== "object") return { ok: false, reason: "invalid body" };
  if (!input.repo || typeof input.repo !== "string")
    return { ok: false, reason: "repo is required" };
  if (!isRepoAllowed(input.repo))
    return { ok: false, reason: `repo not in allowlist: ${input.repo}` };
  if (!input.ref || typeof input.ref !== "string")
    return { ok: false, reason: "ref is required" };
  if (!isValidRef(input.ref)) return { ok: false, reason: `invalid ref: ${input.ref}` };
  if (input.expected_head && !isValidHead(input.expected_head))
    return { ok: false, reason: `invalid expected_head: ${input.expected_head}` };
  const cv = validateCommands(input.commands);
  if (!cv.ok) return { ok: false, reason: cv.reason };
  const tv = validateTags(input.tags);
  if (!tv.ok) return { ok: false, reason: tv.reason };
  const ev = validateEnv(input.env);
  if (!ev.ok) return { ok: false, reason: ev.reason };
  const rp = validateResolutionProbe(input.resolution_probe);
  if (!rp.ok) return { ok: false, reason: rp.reason };
  return { ok: true, commands: cv.commands, tags: tv.tags, env: ev.env, resolutionProbePackages: rp.packages };
}

export function validateResolutionProbe(value: unknown): {
  ok: boolean;
  reason?: string;
  packages: string[];
} {
  if (value == null) return { ok: true, packages: [] };
  const raw = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { packages?: unknown }).packages)
      ? (value as { packages: unknown[] }).packages
      : null;
  if (!raw) return { ok: false, reason: "resolution_probe must be an array or { packages: [...] }", packages: [] };
  if (raw.length > 20) return { ok: false, reason: "resolution_probe supports max 20 packages", packages: [] };
  const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      return { ok: false, reason: "resolution_probe package names must be strings", packages: [] };
    }
    const name = item.trim();
    if (!PACKAGE_RE.test(name) || name.includes("..")) {
      return { ok: false, reason: `invalid resolution_probe package: ${name}`, packages: [] };
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return { ok: true, packages: out };
}

// Validate the optional `env` field: a Record<string,string> of environment
// variables injected into each command's process environment. Keys must be
// POSIX-shell-safe env names; a small set of resolution/loader-sensitive keys
// is rejected so a job can never repoint module/library resolution. Empty or
// undefined → {}.
export function validateEnv(env: unknown): {
  ok: boolean;
  reason?: string;
  env: Record<string, string>;
} {
  if (env == null) return { ok: true, env: {} };
  if (typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, reason: "env must be an object of string values", env: {} };
  }
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > 50) return { ok: false, reason: "too many env vars (max 50)", env: {} };
  const RESERVED = new Set([
    "PATH",
    "NODE_PATH",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { ok: false, reason: `invalid env key: ${key}`, env: {} };
    }
    if (RESERVED.has(key.toUpperCase())) {
      return { ok: false, reason: `env key not allowed: ${key}`, env: {} };
    }
    if (typeof value !== "string") {
      return { ok: false, reason: `env value for ${key} must be a string`, env: {} };
    }
    if (value.length > 4096) {
      return { ok: false, reason: `env value for ${key} is too long (max 4096 chars)`, env: {} };
    }
    out[key] = value;
  }
  return { ok: true, env: out };
}

// Validate the optional `tags` field: array of strings, max 10, each 1-30
// chars, alphanumeric + dash/underscore only. Empty/undefined → [].
export function validateTags(tags: unknown): {
  ok: boolean;
  reason?: string;
  tags: string[];
} {
  if (tags == null) return { ok: true, tags: [] };
  if (!Array.isArray(tags)) return { ok: false, reason: "tags must be an array of strings", tags: [] };
  if (tags.length > 10) return { ok: false, reason: "too many tags (max 10)", tags: [] };
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tags.length; i++) {
    const raw = tags[i];
    if (typeof raw !== "string") {
      return { ok: false, reason: `tag #${i + 1} must be a string`, tags: [] };
    }
    const t = raw.trim();
    if (t.length < 1 || t.length > 30) {
      return { ok: false, reason: `tag #${i + 1} must be 1-30 chars`, tags: [] };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(t)) {
      return { ok: false, reason: `tag #${i + 1} may only contain letters, numbers, dash and underscore`, tags: [] };
    }
    const lower = t.toLowerCase();
    if (seen.has(lower)) {
      // silently dedupe — case-insensitive
      continue;
    }
    seen.add(lower);
    out.push(t);
  }
  return { ok: true, tags: out };
}
