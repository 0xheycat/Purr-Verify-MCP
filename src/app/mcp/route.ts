// POST /mcp  (JSON-RPC 2.0)
// MCP-style endpoint at the path required by the spec.
// initialize and tools/list are open; tools/call requires the bearer token.

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
    tools: [
      "create_verification_job",
      "get_verification_job",
      "list_verification_jobs",
      "cancel_verification_job",
      "health_check",
    ],
    note: "POST a JSON-RPC 2.0 request. tools/call requires Authorization: Bearer <token> — send VERIFY_TOKEN for AUTH_MODE=server_token, or a GitHub PAT for AUTH_MODE=github_passthrough. See /api/health for the active authMode.",
  });
}
