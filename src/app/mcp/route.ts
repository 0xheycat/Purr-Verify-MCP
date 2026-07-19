// POST /mcp  (JSON-RPC 2.0)
// MCP-style endpoint at the path required by the spec.
// initialize and tools/list are open; tools/call is checked before execution.

import { NextRequest } from "next/server";
import { handleMcp } from "@/lib/verify/mcp";
import { checkAuth } from "@/lib/verify/auth";
import { mcpResourceUrl, oauthAuthenticateHeaders, oauthResourceMetadataUrl } from "@/lib/verify/oauth-metadata";
import {
  READ_OPERATING_GUIDE_TOOL,
  VERIFY_MCP_INSTRUCTIONS,
  VERIFY_OPERATING_GUIDE,
} from "@/lib/verify/operating-guide";
import {
  decorateMcpResponse,
  requestWithJsonBody,
  routeMcpExecutionBody,
} from "@/lib/verify/mcp-execution-routing";
import {
  VERIFY_DEBUG_TOOLS,
  purrRequestId,
  recentVerifyDebugErrors,
  recordVerifyDebugError,
  verifyDebugStatus,
} from "@/lib/verify/debug";
import {
  decorateVerifyMcpInitialize,
  decorateVerifyMcpToolResults,
  decorateVerifyMcpToolsList,
  listVerifyMcpAppResources,
  readVerifyMcpAppResource,
} from "@/lib/verify/mcp-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface McpMessage {
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    uri?: string;
  };
}

function asMessages(body: unknown): McpMessage[] {
  return Array.isArray(body) ? (body as McpMessage[]) : [body as McpMessage];
}

function requiresCheck(body: unknown): boolean {
  return asMessages(body).some((message) => message?.method === "tools/call");
}

const TOOL_SCOPE: Record<string, string> = {
  health_check: "verify:read",
  list_allowed_commands: "verify:read",
  list_verification_jobs: "verify:read",
  get_verification_job: "verify:read",
  search_verification_history: "verify:read",
  get_latest_verification: "verify:read",
  get_verification_summary: "verify:read",
  compare_verification_jobs: "verify:read",
  get_job_log_chunk: "verify:read",
  search_job_logs: "verify:read",
  purr_discover_projects: "verify:read",
  purr_inspect_project: "verify:read",
  purr_inspect_runtime: "verify:read",
  purr_inspect_environment: "verify:read",
  purr_plan_deployment: "verify:read",
  purr_get_job_status: "verify:read",
  purr_get_job_logs: "verify:read",
  list_share_links: "verify:read",
  purr_run_command: "verify:run",
  purr_verify_project: "verify:run",
  purr_create_deploy_snapshot: "verify:run",
  purr_deploy_project: "verify:run",
  purr_restart_service: "verify:run",
  purr_check_health: "verify:run",
  purr_rollback_deployment: "verify:run",
  purr_cancel_job: "verify:run",
  create_verification_job: "verify:run",
  cancel_verification_job: "verify:run",
  create_share_link: "verify:share",
  revoke_share_links: "verify:share",
};

function missingOAuthScope(messages: McpMessage[], scopes?: string[]): { tool: string; scope: string } | null {
  if (!scopes) return null;
  const granted = new Set(scopes);
  for (const message of messages) {
    if (message.method !== "tools/call") continue;
    const tool = message.params?.name || "";
    const required = TOOL_SCOPE[tool];
    if (required && !granted.has(required)) return { tool, scope: required };
  }
  return null;
}

function firstRequestId(body: unknown): string | number | null {
  return asMessages(body).find((message) => message?.id !== undefined)?.id ?? null;
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function toText(obj: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(obj, null, 2) };
}

function isLocalDebugCall(message: McpMessage): boolean {
  const name = message.params?.name;
  return message?.method === "tools/call" && (name === "auth_status" || name === "debug_status" || name === "debug_last_errors");
}

function isReadOperatingGuideCall(message: McpMessage): boolean {
  return message?.method === "tools/call" && message.params?.name === "read_operating_guide";
}

function readGuideResponse(id: string | number | null) {
  return rpcResult(id, {
    content: [toText(VERIFY_OPERATING_GUIDE)],
    isError: false,
  });
}

function debugToolResponse(req: NextRequest, message: McpMessage, requestId: string) {
  const name = message.params?.name;
  const args = message.params?.arguments || {};
  if (name === "debug_status") {
    return rpcResult(message.id ?? null, { content: [toText(verifyDebugStatus(requestId))], isError: false });
  }
  if (name === "debug_last_errors") {
    return rpcResult(message.id ?? null, {
      content: [toText({ requestId, service: "purr-verify-mcp", errors: recentVerifyDebugErrors(Number(args.limit) || 20) })],
      isError: false,
    });
  }
  if (name === "auth_status") {
    return checkAuth(req).then((auth) => rpcResult(message.id ?? null, {
      content: [toText({
        requestId,
        ok: auth.ok,
        service: "purr-verify-mcp",
        authMode: auth.authMode,
        scopes: auth.scopes || null,
        reason: auth.reason || null,
        githubUser: auth.githubUser || null,
        serverTime: new Date().toISOString(),
      })],
      isError: !auth.ok,
    }));
  }
  return null;
}

async function mcpJson(req: NextRequest) {
  const response = await handleMcp(req);
  const json = await response.json();
  return { response, json };
}

function attachInstructions(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const packet = json as { result?: Record<string, unknown> };
  if (!packet.result || typeof packet.result !== "object") return json;
  packet.result.instructions = VERIFY_MCP_INSTRUCTIONS;
  return packet;
}

function appendStartupTools(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const packet = json as { result?: { tools?: unknown[] } };
  if (!Array.isArray(packet.result?.tools)) return json;
  const existing = new Set(packet.result.tools.map((tool) => {
    return typeof tool === "object" && tool !== null ? (tool as { name?: unknown }).name : null;
  }));
  const startupTools = [READ_OPERATING_GUIDE_TOOL, ...VERIFY_DEBUG_TOOLS];
  for (const tool of startupTools.reverse()) {
    if (!existing.has(tool.name)) packet.result.tools.unshift(tool);
  }
  return packet;
}

function withDebugHeaders(response: Response, requestId: string): Response {
  response.headers.set("x-purr-request-id", requestId);
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(req: NextRequest) {
  const requestId = purrRequestId(req);
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return withDebugHeaders(await handleMcp(req), requestId);
  }

  const messages = asMessages(body);

  if (messages.length === 1 && messages[0]?.method === "initialize") {
    const { json } = await mcpJson(req);
    const initialized = decorateVerifyMcpInitialize(attachInstructions(json));
    return Response.json(initialized, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (messages.length === 1 && messages[0]?.method === "tools/list") {
    const { json } = await mcpJson(req);
    const tools = decorateVerifyMcpToolsList(appendStartupTools(json));
    return Response.json(tools, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (messages.length === 1 && messages[0]?.method === "resources/list") {
    return Response.json(
      rpcResult(messages[0].id ?? null, { resources: listVerifyMcpAppResources() }),
      { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } }
    );
  }

  if (messages.length === 1 && messages[0]?.method === "resources/read") {
    const uri = messages[0].params?.uri || "";
    const resource = readVerifyMcpAppResource(req, uri);
    const packet = resource
      ? rpcResult(messages[0].id ?? null, resource)
      : rpcError(messages[0].id ?? null, -32002, `Resource not found: ${uri}`);
    return Response.json(packet, {
      status: 200,
      headers: { "x-purr-request-id": requestId, "cache-control": "no-store" },
    });
  }

  if (messages.length === 1 && isReadOperatingGuideCall(messages[0])) {
    const id = messages[0].id ?? null;
    const result = decorateVerifyMcpToolResults(readGuideResponse(id), [
      { id, tool: "read_operating_guide" },
    ]);
    return Response.json(result, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (messages.length === 1 && isLocalDebugCall(messages[0])) {
    const message = messages[0];
    const result = await debugToolResponse(req, message, requestId);
    const decorated = decorateVerifyMcpToolResults(result, [
      { id: message.id, tool: message.params?.name },
    ]);
    return Response.json(decorated, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (requiresCheck(body)) {
    const auth = await checkAuth(req);
    if (!auth.ok) {
      const reason = auth.reason || "Unauthorized";
      recordVerifyDebugError({ requestId, phase: "auth_check", status: 401, code: "unauthorized", message: reason });
      return Response.json(rpcError(firstRequestId(body), -32001, `Unauthorized: ${reason}`), {
        status: 401,
        headers: { ...Object.fromEntries(oauthAuthenticateHeaders(req, reason)), "x-purr-request-id": requestId, "cache-control": "no-store" },
      });
    }
    const missing = missingOAuthScope(messages, auth.scopes);
    if (missing) {
      const reason = `Insufficient scope: ${missing.scope} is required for ${missing.tool}`;
      recordVerifyDebugError({ requestId, phase: "scope_check", status: 403, code: "insufficient_scope", message: reason });
      const headers = oauthAuthenticateHeaders(req);
      headers.set("WWW-Authenticate", `${headers.get("WWW-Authenticate")}, error="insufficient_scope", scope="${missing.scope}"`);
      return Response.json(rpcError(firstRequestId(body), -32003, reason), {
        status: 403,
        headers: { ...Object.fromEntries(headers), "x-purr-request-id": requestId, "cache-control": "no-store" },
      });
    }
  }

  const routed = routeMcpExecutionBody(body);
  const routedRequest = routed.changed ? requestWithJsonBody(req, routed.body) : req;
  const response = await handleMcp(routedRequest);
  const toolCalls = messages
    .filter((message) => message.method === "tools/call")
    .map((message) => ({ id: message.id, tool: message.params?.name }));
  const needsExecutionDecoration =
    routed.changed || routed.toolNames.some((toolName) => toolName === "health_check");
  const needsUiDecoration = toolCalls.length > 0;
  if (!needsExecutionDecoration && !needsUiDecoration) {
    return withDebugHeaders(response, requestId);
  }

  const json = await response.json();
  const executionDecorated = needsExecutionDecoration
    ? decorateMcpResponse(json, routed.routings, routed.toolNames)
    : json;
  const decorated = decorateVerifyMcpToolResults(executionDecorated, toolCalls);
  return Response.json(decorated, {
    status: response.status,
    headers: { "x-purr-request-id": requestId, "cache-control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const requestId = purrRequestId(req);
  return Response.json({
    service: "purr-verify-mcp",
    transport: "jsonrpc-2.0",
    methods: ["initialize", "tools/list", "tools/call"],
    instructions: VERIFY_MCP_INSTRUCTIONS,
    debug: verifyDebugStatus(requestId),
    endpoints: {
      mcp: mcpResourceUrl(req),
      oauth_protected_resource_metadata: oauthResourceMetadataUrl(req),
    },
    startup: ["read_operating_guide", "auth_status", "debug_status", "debug_last_errors", "health_check", "list_allowed_commands"],
    note: "POST JSON-RPC here. Discovery metadata is available from the protected resource metadata endpoint.",
  }, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
}
