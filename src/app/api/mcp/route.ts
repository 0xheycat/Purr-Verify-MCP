// POST /mcp  (JSON-RPC 2.0)
// MCP-style endpoint. initialize and tools/list are open; tools/call requires
// a bearer token. OAuth protected-resource metadata is exposed for ChatGPT
// Apps and other remote MCP clients that perform discovery before auth.

import { NextRequest } from "next/server";
import { handleMcp } from "@/lib/verify/mcp";
import { checkAuth } from "@/lib/verify/auth";
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

  return handleMcp(req);
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
