import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { activeJobCount, queuedJobCount, totalJobCount } from "./store";
import { getConfig, githubTokenSource, VERSION } from "./config";

const MAX_RECENT_ERRORS = 50;
const startedAt = Date.now();
const recentErrors: Array<Record<string, unknown>> = [];

export function purrRequestId(req: NextRequest): string {
  return req.headers.get("x-purr-request-id") || req.headers.get("x-request-id") || `purr_${randomUUID()}`;
}

export function sanitizeDebugValue(value: unknown, limit = 1000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return String(text)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(ghp_|github_pat_|sk-)[A-Za-z0-9_\-]{12,}/gi, "$1[redacted]")
    .slice(0, limit);
}

export function recordVerifyDebugError(entry: Record<string, unknown>) {
  const safe = {
    time: new Date().toISOString(),
    requestId: entry.requestId || null,
    service: "purr-verify-mcp",
    phase: entry.phase || "unknown",
    tool: entry.tool || null,
    status: entry.status || null,
    code: entry.code || null,
    message: sanitizeDebugValue(entry.message || entry.error || "unknown error"),
    hint: entry.hint ? sanitizeDebugValue(entry.hint, 800) : undefined,
  };
  recentErrors.unshift(safe);
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.length = MAX_RECENT_ERRORS;
  return safe;
}

export function recentVerifyDebugErrors(limit = 20) {
  const n = Math.max(1, Math.min(Number(limit) || 20, MAX_RECENT_ERRORS));
  return recentErrors.slice(0, n);
}

export function verifyDebugStatus(requestId: string) {
  const cfg = getConfig();
  return {
    ok: true,
    requestId,
    service: "purr-verify-mcp",
    layer: "mcp-route",
    version: VERSION,
    time: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    queue: {
      active: activeJobCount(),
      queued: queuedJobCount(),
      total: totalJobCount(),
    },
    config: {
      authMode: cfg.authMode,
      allowAllRepos: cfg.allowAllRepos,
      allowedRepos: cfg.allowedRepos,
      githubTokenSource: githubTokenSource(),
      commandTimeoutMs: cfg.commandTimeoutMs,
      jobTimeoutMs: cfg.jobTimeoutMs,
      workdirBase: cfg.workdirBase,
    },
    debug: {
      recentErrorsCount: recentErrors.length,
    },
  };
}

export const VERIFY_DEBUG_TOOLS = [
  {
    name: "auth_status",
    description: "Return safe authentication diagnostics for the current Verify MCP request without exposing bearer material.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "debug_status",
    description: "Return public-safe runtime diagnostics for Purr Verify MCP, including queue counts, timeout config, and recent error count.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "debug_last_errors",
    description: "Return recent sanitized debug errors captured by Purr Verify MCP.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 20 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];
