// GET /api/share/:token  (PUBLIC — no auth required)
// Returns a redacted, read-only view of the shared job.
// Supports ?format=markdown for a PR-comment-ready summary.

import { NextRequest, NextResponse } from "next/server";
import { notFound } from "@/lib/verify/auth";
import { jobToMarkdown } from "@/lib/verify/markdown";
import { resolveShareToken, toPublicView } from "@/lib/verify/share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;
  if (!token || token.length < 10) {
    return notFound("invalid share token");
  }

  const resolved = await resolveShareToken(token);
  if (!resolved.ok || !resolved.token || !resolved.job) {
    return notFound(resolved.reason || "share not found");
  }

  const url = new URL(req.url);
  const wantMarkdown = url.searchParams.get("format") === "markdown";

  if (wantMarkdown) {
    // Reuse the existing markdown renderer. Note: jobToMarkdown may include
    // some fields that aren't in the public view (e.g., webhook deliveries)
    // but those are omitted from the markdown output anyway.
    return NextResponse.json({
      jobId: resolved.job.jobId,
      markdown: jobToMarkdown(resolved.job),
      sharedVia: {
        token: resolved.token.token,
        createdAt: resolved.token.createdAt,
        expiresAt: resolved.token.expiresAt,
      },
    });
  }

  const view = toPublicView(resolved.job, resolved.token);
  return NextResponse.json(view);
}
