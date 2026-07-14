import { NextRequest } from "next/server";
import { oauthAuthorizationServerMetadata } from "@/lib/verify/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const metadata = oauthAuthorizationServerMetadata(req);
  const issuer = String(metadata.issuer);
  return Response.json(
    { ...metadata, jwks_uri: `${issuer}/oauth/keys` },
    { headers: { "Cache-Control": "no-store" } }
  );
}
