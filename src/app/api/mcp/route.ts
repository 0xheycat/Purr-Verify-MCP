// POST /mcp  (JSON-RPC 2.0)
// MCP-style endpoint. initialize and tools/list are open; tools/call requires
// the bearer token.

import { NextRequest } from "next/server";
import { handleMcp } from "@/lib/verify/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleMcp(req);
}

// GET returns a small descriptor for discoverability.
export async function GET() {
  return Response.json({
    service: "purr-verify-mcp",
    transport: "jsonrpc-2.0",
    methods: ["initialize", "tools/list", "tools/call"],
    note: "POST a JSON-RPC 2.0 request. tools/call requires Authorization: Bearer <VERIFY_TOKEN>.",
  });
}
