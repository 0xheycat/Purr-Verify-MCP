// POST /api/mcp  (JSON-RPC 2.0)
// Legacy MCP-style endpoint. initialize and tools/list are open; tools/call
// requires a bearer token. The canonical endpoint remains /mcp.

import { NextRequest } from "next/server";
import { handleMcp } from "@/lib/verify/mcp";
import { checkAuth } from "@/lib/verify/auth";
import {
  decorateMcpResponse,
  requestWithJsonBody,
  routeMcpExecutionBody,
} from "@/lib/verify/mcp-execution-routing";
import {
  mcpResourceUrl,
  oauthAuthenticateHeaders,
  oauthResourceMetadataUrl,
} from "@/lib/verify/oauth-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface McpMessage {
  id?: string | number | null;
  method?: string;
}

function asMessages(body: unknown): McpMessage[] {
  return Array.isArray(body) ? body as McpMessage[] : [body as McpMessage];
}

function requiresAuth(body: unknown): boolean {
  return asMessages(body).some((message) => message?.method === "tools/call");
}

function firstRequestId(body: unknown): string | number | null {
  return asMessages(body).find((message) => message?.id !== undefined)?.id ?? null;
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.clone().json();
  } catch {
    return handleMcp(req);
  }

  if (requiresAuth(body)) {
    const auth = await checkAuth(req);
    if (!auth.ok) {
      const reason = auth.reason || "Unauthorized";
      return Response.json(
        rpcError(firstRequestId(body), -32001, `Unauthorized: ${reason}`),
        {
          status: 401,
          headers: oauthAuthenticateHeaders(req, reason),
        }
      );
    }
  }

  const routed = routeMcpExecutionBody(body);
  const routedRequest = routed.changed ? requestWithJsonBody(req, routed.body) : req;
  const response = await handleMcp(routedRequest);
  const needsDecoration =
    routed.changed || routed.toolNames.some((toolName) => toolName === "health_check");
  if (!needsDecoration) return response;

  const json = await response.json();
  return Response.json(
    decorateMcpResponse(json, routed.routings, routed.toolNames),
    { status: response.status }
  );
}

// GET returns a small descriptor for discoverability.
export async function GET(req: NextRequest) {
  return Response.json({
    service: "purr-verify-mcp",
    transport: "jsonrpc-2.0",
    methods: ["initialize", "tools/list", "tools/call"],
    endpoints: {
      mcp: mcpResourceUrl(req),
      oauth_protected_resource_metadata: oauthResourceMetadataUrl(req),
    },
    note: "POST a JSON-RPC 2.0 request. tools/call requires Authorization: Bearer <access-token>. OAuth discovery is available at the protected resource metadata endpoint.",
  });
}
