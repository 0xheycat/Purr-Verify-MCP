// Bearer token authentication for protected endpoints.
//
// Supported auth paths:
//
// 1. server_token (default, backward compatible):
//    Authorization: Bearer <VERIFY_TOKEN>
//
// 2. embedded OAuth access token:
//    Authorization: Bearer <OAuth JWT issued by this app>
//    In server_token mode, the OAuth token is validated first. If valid, the
//    request is accepted and executor falls back to env GITHUB_TOKEN.
//
// 3. github_passthrough:
//    Authorization: Bearer <GitHub PAT>
//    The token is validated by calling GitHub API /user and then used for clone.

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getConfig } from "./config";
import { verifyOAuthAccessToken } from "./oauth-server";

export interface AuthContext {
  ok: boolean;
  reason?: string;
  /** Active auth mode for this request. */
  authMode: "server_token" | "github_passthrough" | "oauth_jwt";
  /**
   * Per-request GitHub clone token.
   * - github_passthrough: the bearer GitHub PAT (used to clone private repos).
   * - server_token/oauth_jwt: undefined → executor falls back to env GITHUB_TOKEN.
   * NEVER persisted to disk; lives only in the in-memory job runtime.
   */
  githubToken?: string;
  /** GitHub username (login) when authenticated via github_passthrough. */
  githubUser?: string;
}

// ---- GitHub passthrough validation cache ----
interface CachedAuth {
  ok: boolean;
  user?: string;
  ts: number;
}
const authCache = new Map<string, CachedAuth>();
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const GITHUB_API_TIMEOUT_MS = 8000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authCache) {
    if (now - v.ts > AUTH_CACHE_TTL_MS * 2) authCache.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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
        // Token is valid even if the body cannot be parsed.
      }
      return { ok: true, user: login };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "GitHub rejected the token" };
    }
    return { ok: false, reason: `GitHub API returned ${res.status}` };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") return { ok: false, reason: "GitHub API validation timed out" };
    return { ok: false, reason: "GitHub API unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function checkAuth(req: NextRequest): Promise<AuthContext> {
  const cfg = getConfig();

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

  // server_token mode can also accept OAuth access tokens issued by the
  // embedded OAuth server. This keeps VERIFY_TOKEN private from ChatGPT.
  const oauth = verifyOAuthAccessToken(token, req);
  if (oauth.ok) {
    return { ok: true, authMode: "oauth_jwt" };
  }

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

  return { ok: true, authMode: "server_token" };
}

export function unauthorized(reason: string) {
  return NextResponse.json({ error: "unauthorized", message: reason }, { status: 401 });
}

export function badRequest(message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: "bad_request", message, ...extra }, { status: 400 });
}

export function notFound(message = "not found") {
  return NextResponse.json({ error: "not_found", message }, { status: 404 });
}
