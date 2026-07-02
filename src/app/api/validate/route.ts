// POST /api/validate  (auth required)
// Dry-run validation: validates repo allowlist + command allowlist without creating a job.

import { NextRequest, NextResponse } from "next/server";
import { badRequest, checkAuth, unauthorized } from "@/lib/verify/auth";
import { isRepoAllowed, isValidHead, isValidRef } from "@/lib/verify/config";
import { validateCommands } from "@/lib/verify/allowlist";
import type { VerifyRequest } from "@/lib/verify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return badRequest("invalid JSON body");
  }

  const errors: string[] = [];

  // Validate repo
  if (!body.repo || typeof body.repo !== "string") {
    errors.push("repo is required");
  } else if (!isRepoAllowed(body.repo)) {
    errors.push(`repo not in allowlist: ${body.repo}`);
  }

  // Validate ref
  if (!body.ref || typeof body.ref !== "string") {
    errors.push("ref is required");
  } else if (!isValidRef(body.ref)) {
    errors.push(`invalid ref: ${body.ref}`);
  }

  // Validate expected_head
  if (body.expected_head && !isValidHead(body.expected_head)) {
    errors.push(`invalid expected_head: ${body.expected_head}`);
  }

  // Validate commands
  const cv = validateCommands(body.commands);
  if (!cv.ok) {
    errors.push(cv.reason || "commands validation failed");
  }

  if (errors.length > 0) {
    return NextResponse.json({ valid: false, errors });
  }

  return NextResponse.json({ valid: true, commands: cv.commands });
}
