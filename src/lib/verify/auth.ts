// Bearer token authentication for protected endpoints.
//
// Two auth modes (selected by AUTH_MODE env):
//
// 1. server_token (default, backward compatible):
//    Authorization: Bearer <VERIFY_TOKEN>
//    The server authenticates the bearer against the configured VERIFY_TOKEN
//    using a constant-time comparison. Cloning uses the server's env
//    GITHUB_TOKEN (if set) for private repos. Good for stable/private
//    deployments.
//
// 2. github_passthrough:
//    Authorization: Bearer <GitHub PAT>
//    The server authenticates by calling the GitHub API
//    (GET https://api.github.com/user) with the bearer token. If GitHub
//    returns 200, the request is authenticated and the SAME GitHub token is
//    used to clone/fetch private repos. This lets MCP clients paste a GitHub
//    PAT directly as the bearer token, without the server needing
//    GITHUB_TOKEN in env. Results are cached for 5 minutes by token hash to
//    avoid hammering the GitHub API on every poll.
//
// SECURITY: The GitHub token / Authorization header is NEVER logged. It is
// only ever (a) sent to api.github.com over HTTPS for validation, (b) used
// to construct an x-access-token clone URL that is immediately redacted from
// captured stdout/stderr by redact.ts. See also redact.ts which scrubs
// github_pat_, ghp_, gho_, ghu_, ghs_, ghr_ patterns and x-access-token:@ URLs.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getConfig } from "./config";

export interface AuthContext {
  ok: boolean;
  reason?: string;
  /** Active auth mode for this request. */
  authMode: "server_token" | "github_passthrough";
  /**
   * Per-request GitHub clone token.
   * - github_passthrough: the bearer GitHub PAT (used to clone private repos).
   * - server_token: undefined → executor falls back to env GITHUB_TOKEN.
   * NEVER persisted to disk; lives only in the in-memory job runtime.
   */
  githubToken?: string;
  /** GitHub username (login) when authenticated via github_passthrough. */
  githubUser?: string;
}

// ---- GitHub passthrough validation cache ----
// Keyed by sha256(token) so the raw token is never stored. In-memory only.
interface CachedAuth {
  ok: boolean;
  user?: string;
  ts: number;
}
const authCache = new Map<string, CachedAuth>();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const GITHUB_API_TIMEOUT_MS = 8000;

// Periodically prune stale cache entries to bound memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCache) {
    if (now - v.ts > AUTH_CACHE_TTL_MS * 2) authCache.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Validate a GitHub PAT by calling GET https://api.github.com/user.
 * Returns { ok, user } on HTTP 200. Fails closed (ok:false) on 401/403,
 * network error, or timeout — never throws.
 */
async function validateGithubToken(token: string): Promise<{ ok: boolean; user?: string; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.github.com/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "purr-verify-mcp",
      },
      signal: controller.signal,
    });
    if (res.ok) {
      let login: string | undefined;
      try {
        const body = (await res.json()) as { login?: string };
        login = body?.login;
      } catch {
        // Non-fatal: token is valid even if we can't parse the body.
      }
      return { ok: true, user: login };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "GitHub rejected the token" };
    }
    // 404 / 5xx / rate-limit → fail closed; don't reveal token state.
    return { ok: false, reason: `GitHub API returned ${res.status}` };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { ok: false, reason: "GitHub API validation timed out" };
    }
    return { ok: false, reason: "GitHub API unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Constant-time string comparison. Returns true iff equal. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Authenticate a request. Async because github_passthrough mode calls the
 * GitHub API (cached for 5 min by token hash).
 *
 * Supports Authorization: Bearer <token> header and ?token=<token> query
 * param (the latter is needed for SSE/EventSource which can't set headers).
 */
export async function checkAuth(req: NextRequest): Promise<AuthContext> {
  const cfg = getConfig();

  // Extract bearer token from header or ?token= query (SSE fallback).
  let token: string | null = null;
  const header = req.headers.get("authorization") || req.headers.get("Authorization");
  if (header) {
    const trimmed = header.trim();
    if (/^bearer\s+/i.test(trimmed)) {
      token = trimmed.replace(/^bearer\s+/i, "").trim();
    } else {
      token = trimmed;
    }
  }
  if (!token) {
    const url = new URL(req.url);
    token = url.searchParams.get("token");
  }

  if (!token) {
    return { ok: false, reason: "Missing Authorization header or token query param", authMode: cfg.authMode };
  }

  if (cfg.authMode === "github_passthrough") {
    // Validate the bearer against the GitHub API (cached).
    const hash = tokenHash(token);
    const cached = authCache.get(hash);
    const now = Date.now();
    if (cached && now - cached.ts < AUTH_CACHE_TTL_MS) {
      return cached.ok
        ? { ok: true, authMode: "github_passthrough", githubToken: token, githubUser: cached.user }
        : { ok: false, reason: "Invalid GitHub token (cached)", authMode: "github_passthrough" };
    }
    const res = await validateGithubToken(token);
    authCache.set(hash, { ok: res.ok, user: res.user, ts: now });
    if (!res.ok) {
      return { ok: false, reason: res.reason || "Invalid GitHub token", authMode: "github_passthrough" };
    }
    return { ok: true, authMode: "github_passthrough", githubToken: token, githubUser: res.user };
  }

  // server_token mode (default).
  if (!cfg.verifyToken) {
    return {
      ok: false,
      reason: "Server is misconfigured: VERIFY_TOKEN is not set (AUTH_MODE=server_token)",
      authMode: "server_token",
    };
  }
  if (!safeEqual(token, cfg.verifyToken)) {
    return { ok: false, reason: "Invalid token", authMode: "server_token" };
  }
  // githubToken is undefined here → executor falls back to env GITHUB_TOKEN.
  return { ok: true, authMode: "server_token" };
}

export function unauthorized(reason: string) {
  return NextResponse.json(
    { error: "unauthorized", message: reason },
    { status: 401 }
  );
}

export function badRequest(message: string, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error: "bad_request", message, ...extra },
    { status: 400 }
  );
}

export function notFound(message = "not found") {
  return NextResponse.json({ error: "not_found", message }, { status: 404 });
}
