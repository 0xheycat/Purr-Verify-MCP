import { getOAuthJwks } from "@/lib/verify/oauth-jwks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getOAuthJwks(), {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=300",
    },
  });
}
