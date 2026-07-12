// POST /mcp  (JSON-RPC 2.0)
// MCP-style endpoint at the path required by the spec.
// initialize and tools/list are open; tools/call is checked before execution.

import { NextRequest } from "next/server";
import { handleMcp } from "@/lib/verify/mcp";
import { checkAuth } from "@/lib/verify/auth";
import { handleHostedMcpJobRead } from "@/lib/verify/hosted-mcp-jobs";
import { mcpResourceUrl, oauthAuthenticateHeaders, oauthResourceMetadataUrl } from "@/lib/verify/oauth-metadata";
import {
  READ_OPERATING_GUIDE_TOOL,
  VERIFY_MCP_INSTRUCTIONS,
  VERIFY_OPERATING_GUIDE,
  findHeavySyncCommand,
} from "@/lib/verify/operating-guide";
import {
  VERIFY_DEBUG_TOOLS,
  purrRequestId,
  recentVerifyDebugErrors,
  recordVerifyDebugError,
  verifyDebugStatus,
} from "@/lib/verify/debug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface McpMessage {
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

function asMessages(body: unknown): McpMessage[] {
  return Array.isArray(body) ? (body as McpMessage[]) : [body as McpMessage];
}

function requiresCheck(body: unknown): boolean {
  return asMessages(body).some((message) => message?.method === "tools/call");
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

function isCreateVerificationJobCall(message: McpMessage): boolean {
  return message?.method === "tools/call" && message.params?.name === "create_verification_job";
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
        reason: auth.reason || null,
        githubUser: auth.githubUser || null,
        serverTime: new Date().toISOString(),
      })],
      isError: !auth.ok,
    }));
  }
  return null;
}

function heavySyncValidationError(message: McpMessage, requestId: string) {
  if (!isCreateVerificationJobCall(message)) return null;
  const args = message.params?.arguments || {};
  if (args.mode !== "sync") return null;
  const heavy = findHeavySyncCommand(args.commands);
  if (!heavy) return null;
  recordVerifyDebugError({
    requestId,
    phase: "validate_create_verification_job",
    tool: "create_verification_job",
    code: "heavy_sync_blocked",
    message: `Blocked sync verification command: ${heavy}`,
  });
  return rpcResult(message.id ?? null, {
    content: [
      toText({
        error: "heavy_sync_blocked",
        requestId,
        message:
          "Heavy verification commands must use mode='async'. Create the job asynchronously, then poll get_verification_job until terminal status.",
        blockedCommand: heavy,
        recommendedMode: "async",
      }),
    ],
    isError: true,
  });
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
    return Response.json(attachInstructions(json), { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (messages.length === 1 && messages[0]?.method === "tools/list") {
    const { json } = await mcpJson(req);
    return Response.json(appendStartupTools(json), { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (messages.length === 1 && isReadOperatingGuideCall(messages[0])) {
    return Response.json(readGuideResponse(messages[0].id ?? null), { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (messages.length === 1 && isLocalDebugCall(messages[0])) {
    const result = await debugToolResponse(req, messages[0], requestId);
    return Response.json(result, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
  }

  if (messages.length === 1) {
    const hostedResult = await handleHostedMcpJobRead(req, messages[0]);
    if (hostedResult) {
      return Response.json(hostedResult, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });
    }
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
  }

  const syncError = messages.map((message) => heavySyncValidationError(message, requestId)).find(Boolean);
  if (syncError) return Response.json(syncError, { status: 200, headers: { "x-purr-request-id": requestId, "cache-control": "no-store" } });

  const response = await handleMcp(req);
  return withDebugHeaders(response, requestId);
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
