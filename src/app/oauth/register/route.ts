import { NextRequest } from "next/server";
import { handleRegister } from "@/lib/verify/oauth-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleRegister(req);
}
