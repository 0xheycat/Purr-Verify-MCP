import { NextRequest } from "next/server";
import { oauthAuthorizationServerMetadata } from "@/lib/verify/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return Response.json(oauthAuthorizationServerMetadata(req));
}
