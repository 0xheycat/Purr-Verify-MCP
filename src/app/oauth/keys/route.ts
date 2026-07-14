export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    {
      keys: [],
      warning: "Embedded self-hosted OAuth currently uses HS256. Asymmetric signing and JWKS are tracked for the hosted production phase.",
    },
    { status: 501, headers: { "Cache-Control": "no-store" } }
  );
}
