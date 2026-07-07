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
  findHeavySyncCommand,
} from "@/lib/verify/operating-guide";

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

function heavySyncValidationError(message: McpMessage) {
  if (!isCreateVerificationJobCall(message)) return null;
  const args = message.params?.arguments || {};
  if (args.mode !== "sync") return null;
  const heavy = findHeavySyncCommand(args.commands);
  if (!heavy) return null;
  return rpcResult(message.id ?? null, {
    content: [
      toText({
        error: "heavy_sync_blocked",
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

function appendGuideTool(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const packet = json as { result?: { tools?: unknown[] } };
  if (!Array.isArray(packet.result?.tools)) return json;
  const exists = packet.result.tools.some((tool) => {
    return typeof tool === "object" && tool !== null && (tool as { name?: unknown }).name === "read_operating_guide";
  });
  if (!exists) packet.result.tools.unshift(READ_OPERATING_GUIDE_TOOL);
  return packet;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return handleMcp(req);
  }

  const messages = asMessages(body);

  if (messages.length === 1 && messages[0]?.method === "initialize") {
    const { json } = await mcpJson(req);
    return Response.json(attachInstructions(json), { status: 200 });
  }

  if (messages.length === 1 && messages[0]?.method === "tools/list") {
    const { json } = await mcpJson(req);
    return Response.json(appendGuideTool(json), { status: 200 });
  }

  if (messages.length === 1 && isReadOperatingGuideCall(messages[0])) {
    return Response.json(readGuideResponse(messages[0].id ?? null), { status: 200 });
  }

  if (requiresCheck(body)) {
    const auth = await checkAuth(req);
    if (!auth.ok) {
      const reason = auth.reason || "Unauthorized";
      return Response.json(rpcError(firstRequestId(body), -32001, `Unauthorized: ${reason}`), {
        status: 401,
        headers: oauthAuthenticateHeaders(req, reason),
      });
    }
  }

  const syncError = messages.map(heavySyncValidationError).find(Boolean);
  if (syncError) return Response.json(syncError, { status: 200 });

  return handleMcp(req);
}

export async function GET(req: NextRequest) {
  return Response.json({
    service: "purr-verify-mcp",
    transport: "jsonrpc-2.0",
    methods: ["initialize", "tools/list", "tools/call"],
    instructions: VERIFY_MCP_INSTRUCTIONS,
    endpoints: {
      mcp: mcpResourceUrl(req),
      oauth_protected_resource_metadata: oauthResourceMetadataUrl(req),
    },
    startup: ["read_operating_guide", "health_check", "list_allowed_commands"],
    note: "POST JSON-RPC here. Discovery metadata is available from the protected resource metadata endpoint.",
  });
}
