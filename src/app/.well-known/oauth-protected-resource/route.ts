import { NextRequest } from "next/server";
import { oauthProtectedResourceMetadata } from "@/lib/verify/oauth-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return Response.json(oauthProtectedResourceMetadata(req));
}
