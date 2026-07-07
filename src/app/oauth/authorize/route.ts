import { NextRequest } from "next/server";
import { handleAuthorize } from "@/lib/verify/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleAuthorize(req);
}

export async function POST(req: NextRequest) {
  return handleAuthorize(req);
}
