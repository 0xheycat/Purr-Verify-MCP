// Bearer authentication for protected endpoints.
//
// OAuth access credentials are accepted only on the canonical MCP resource.
// REST endpoints retain the existing server-token or GitHub-passthrough modes.

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "./config";
import {
  oauthResourceUrl,
  verifyOAuthAccessToken,
} from "./oauth-server";

export interface AuthContext {
  ok: boolean;
  reason?: string;
  authMode: "server_token" | "github_passthrough" | "oauth_jwt";
  githubToken?: string;
  githubUser?: string;
  scopes?: string[];
  subject?: string;
  clientId?: string;
}

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
  for (const [key, value] of authCache) {
    if (now - value.ts > AUTH_CACHE_TTL_MS * 2) authCache.delete(key);
  }
}, 10 * 60 * 1000).unref?.();

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function validateGithubToken(
  value: string
): Promise<{ ok: boolean; user?: string; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.github.com/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${value}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "purr-verify-mcp",
      },
      signal: controller.signal,
    });
    if (response.ok) {
      let login: string | undefined;
      try {
        const body = (await response.json()) as { login?: string };
        login = body.login;
      } catch {
        // A successful status is sufficient even if the body is unavailable.
      }
      return { ok: true, user: login };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "GitHub rejected the credential" };
    }
    return { ok: false, reason: `GitHub API returned ${response.status}` };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return { ok: false, reason: "GitHub API validation timed out" };
    }
    return { ok: false, reason: "GitHub API unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function bearerValue(req: NextRequest): {
  value?: string;
  reason?: string;
} {
  const header = req.headers.get("authorization");
  if (!header) return { reason: "Missing Authorization header" };
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  if (!match) {
    return {
      reason: "Authorization header must use exactly: Bearer <credential>",
    };
  }
  return { value: match[1] };
}

function isCanonicalOAuthResource(req: NextRequest): boolean {
  try {
    return new URL(req.url).pathname === new URL(oauthResourceUrl(req)).pathname;
  } catch {
    return false;
  }
}

export async function checkAuth(req: NextRequest): Promise<AuthContext> {
  const cfg = getConfig();
  const bearer = bearerValue(req);
  if (!bearer.value) {
    return {
      ok: false,
      reason: bearer.reason || "Missing bearer credential",
      authMode: cfg.authMode,
    };
  }
  const value = bearer.value;

  if (cfg.authMode === "github_passthrough") {
    const hash = tokenHash(value);
    const cached = authCache.get(hash);
    const now = Date.now();
    if (cached && now - cached.ts < AUTH_CACHE_TTL_MS) {
      return cached.ok
        ? {
            ok: true,
            authMode: "github_passthrough",
            githubToken: value,
            githubUser: cached.user,
          }
        : {
            ok: false,
            reason: "Invalid GitHub credential (cached)",
            authMode: "github_passthrough",
          };
    }

    const result = await validateGithubToken(value);
    authCache.set(hash, { ok: result.ok, user: result.user, ts: now });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason || "Invalid GitHub credential",
        authMode: "github_passthrough",
      };
    }
    return {
      ok: true,
      authMode: "github_passthrough",
      githubToken: value,
      githubUser: result.user,
    };
  }

  if (isCanonicalOAuthResource(req)) {
    const oauth = await verifyOAuthAccessToken(value, req);
    if (oauth.ok) {
      return {
        ok: true,
        authMode: "oauth_jwt",
        scopes: oauth.scopes || [],
        subject: oauth.subject,
        clientId: oauth.clientId,
      };
    }
  }

  if (!cfg.verifyToken) {
    return {
      ok: false,
      reason:
        "Server is misconfigured: VERIFY_TOKEN is not set (AUTH_MODE=server_token)",
      authMode: "server_token",
    };
  }
  if (!safeEqual(value, cfg.verifyToken)) {
    return {
      ok: false,
      reason: "Invalid bearer credential",
      authMode: "server_token",
    };
  }

  return { ok: true, authMode: "server_token" };
}

export function unauthorized(reason: string) {
  return NextResponse.json(
    { error: "unauthorized", message: reason },
    { status: 401 }
  );
}

export function forbidden(message: string, scope?: string) {
  return NextResponse.json(
    { error: "forbidden", message, ...(scope ? { requiredScope: scope } : {}) },
    { status: 403 }
  );
}

export function badRequest(
  message: string,
  extra?: Record<string, unknown>
) {
  return NextResponse.json(
    { error: "bad_request", message, ...extra },
    { status: 400 }
  );
}

export function notFound(message = "not found") {
  return NextResponse.json(
    { error: "not_found", message },
    { status: 404 }
  );
}
