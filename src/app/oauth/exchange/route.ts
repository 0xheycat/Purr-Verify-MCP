import { NextRequest } from "next/server";
import { handleToken as handleExchange } from "@/lib/verify/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleExchange(req);
}
