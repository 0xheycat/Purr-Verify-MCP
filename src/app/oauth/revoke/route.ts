import { NextRequest } from "next/server";
import { handleRevoke } from "@/lib/verify/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleRevoke(req);
}
