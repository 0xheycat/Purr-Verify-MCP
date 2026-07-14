import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  oauthConfigurationStatus,
  oauthIssuer,
  oauthPublicBaseUrl,
  oauthResourceUrl,
  supportedOauthScopes,
} from "./oauth-crypto";
import {
  getOAuthClient,
  type OAuthClientRecord,
} from "./oauth-store";

export const PKCE_VALUE_RE = /^[A-Za-z0-9_-]{43,128}$/;

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

interface OAuthHttpGlobal {
  __purrOAuthRateLimits?: Map<string, RateLimitRecord>;
}

function splitList(raw = ""): string[] {
  return raw
    .split(/[ ,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function dcrEnabled(): boolean {
  return boolEnv("OAUTH_DCR_ENABLED", false);
}

export function allowedRedirectUris(): string[] {
  return [
    ...new Set(
      splitList(
        process.env.OAUTH_ALLOWED_REDIRECT_URIS ||
          process.env.ALLOWED_REDIRECT_URIS ||
          ""
      )
    ),
  ];
}

function defaultClientId(): string {
  return process.env.OAUTH_CLIENT_ID || "chatgpt-purr-verify";
}

export function ownerCode(): string {
  return process.env.OAUTH_OWNER_CODE || process.env.OAUTH_ADMIN_CODE || "";
}

export function codeTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.OAUTH_CODE_TTL_SECONDS || "300", 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
  return Math.min(value, 600);
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function requestedScopes(
  raw: string | null
): { ok: true; value: string } | { ok: false; reason: string } {
  const supported = supportedOauthScopes();
  const requested = splitList(raw || supported.join(" "));
  if (requested.length === 0) {
    return { ok: false, reason: "scope is required" };
  }
  const unsupported = requested.filter((scope) => !supported.includes(scope));
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `unsupported scope: ${unsupported.join(" ")}`,
    };
  }
  return { ok: true, value: [...new Set(requested)].join(" ") };
}

async function resolveClient(clientId: string): Promise<OAuthClientRecord | null> {
  if (clientId === defaultClientId()) {
    return {
      clientId,
      redirectUris: allowedRedirectUris(),
      tokenEndpointAuthMethod: "none",
      clientName: "ChatGPT / Purr Verify",
      createdAt: "predefined",
    };
  }
  return getOAuthClient(clientId);
}

export async function validateAuthorizeParams(
  params: URLSearchParams,
  req: NextRequest
): Promise<string> {
  const responseType = params.get("response_type");
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "";
  const resource = params.get("resource") || "";

  if (responseType !== "code") return "response_type must be code";
  if (!clientId) return "client_id is required";
  if (!redirectUri) return "redirect_uri is required";
  if (!validRedirectUri(redirectUri)) return "redirect_uri is invalid";
  const client = await resolveClient(clientId);
  if (!client) return "unknown client_id";
  if (!client.redirectUris.includes(redirectUri)) {
    return "redirect_uri is not registered for this client_id";
  }
  if (!PKCE_VALUE_RE.test(codeChallenge)) {
    return "code_challenge is invalid";
  }
  if (codeChallengeMethod !== "S256") {
    return "code_challenge_method must be S256";
  }
  if (!resource) return "resource is required";
  if (resource !== oauthResourceUrl(req)) {
    return "resource does not match this MCP server";
  }
  const scopes = requestedScopes(params.get("scope"));
  if (!scopes.ok) return scopes.reason;
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function redirectHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "invalid redirect";
  }
}

export function renderAuthorizePage(
  params: URLSearchParams,
  req: NextRequest,
  error = ""
): string {
  const fields = [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
    "resource",
  ];
  const hidden = fields
    .map(
      (key) =>
        `<input type="hidden" name="${key}" value="${escapeHtml(
          params.get(key) || ""
        )}">`
    )
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Purr Verify MCP OAuth</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#09090b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{width:min(460px,100%);background:#18181b;border:1px solid #3f3f46;border-radius:18px;padding:24px;box-shadow:0 18px 60px #0008}h1{font-size:20px;margin:0 0 8px}p{color:#d4d4d8;line-height:1.5}code{color:#fbbf24;word-break:break-all}input,button{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #52525b;background:#09090b;color:#fafafa;padding:12px;font-size:15px}button{margin-top:12px;background:#22c55e;border:0;font-weight:700;cursor:pointer}.err{color:#fca5a5}.muted{font-size:13px;color:#a1a1aa}.warning{border:1px solid #854d0e;background:#422006;padding:10px;border-radius:10px;color:#fde68a}</style></head><body><main><h1>Authorize Purr Verify MCP</h1><p>ChatGPT is requesting access to <code>${escapeHtml(
    oauthResourceUrl(req)
  )}</code>.</p><p class="warning">After approval you will be redirected to <strong>${escapeHtml(
    redirectHost(params.get("redirect_uri") || "")
  )}</strong>. Continue only if you recognize this destination.</p><p class="muted">Client: <code>${escapeHtml(
    params.get("client_id") || ""
  )}</code><br>Scopes: <code>${escapeHtml(
    params.get("scope") || supportedOauthScopes().join(" ")
  )}</code></p>${
    error ? `<p class="err">${escapeHtml(error)}</p>` : ""
  }<form method="post" action="/oauth/authorize">${hidden}<label>Owner approval code</label><input type="password" name="owner_code" autocomplete="current-password" required autofocus><button type="submit">Authorize ChatGPT</button></form></main></body></html>`;
}

function securityHeaders(contentType: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: securityHeaders("text/html; charset=utf-8"),
  });
}

export function oauthJson(
  body: unknown,
  status = 200,
  extraHeaders?: HeadersInit
): Response {
  const headers = securityHeaders("application/json; charset=utf-8");
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return NextResponse.json(body, { status, headers });
}

export async function readOAuthParams(
  req: NextRequest
): Promise<URLSearchParams> {
  const raw = await req.text();
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = JSON.parse(raw || "{}") as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(raw);
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export function rateLimit(
  req: NextRequest,
  name: string,
  limit: number,
  windowMs: number
): Response | null {
  const globalRate = globalThis as OAuthHttpGlobal;
  const records = (globalRate.__purrOAuthRateLimits ??= new Map());
  const now = Date.now();
  const key = `${name}:${clientIp(req)}`;
  const current = records.get(key);

  if (!current || current.resetAt <= now) {
    records.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }
  if (current.count >= limit) {
    const retryAfter = Math.max(
      1,
      Math.ceil((current.resetAt - now) / 1000)
    );
    return oauthJson(
      {
        error: "temporarily_unavailable",
        error_description: "Too many OAuth requests",
      },
      429,
      { "Retry-After": String(retryAfter) }
    );
  }

  current.count += 1;
  records.set(key, current);
  return null;
}

export function configurationFailure(req: NextRequest): Response | null {
  const status = oauthConfigurationStatus(req);
  const reasons = [...status.reasons];
  if (!dcrEnabled() && allowedRedirectUris().length === 0) {
    reasons.push(
      "OAUTH_ALLOWED_REDIRECT_URIS is required when dynamic registration is disabled"
    );
  }
  if (allowedRedirectUris().some((uri) => !validRedirectUri(uri))) {
    reasons.push("OAUTH_ALLOWED_REDIRECT_URIS contains an invalid redirect URI");
  }
  if (status.ok && reasons.length === 0) return null;
  return oauthJson(
    {
      error: "server_error",
      error_description: "OAuth server is not configured",
      details: reasons,
    },
    503
  );
}

export function invalidGrant(result: {
  reason: string;
  description?: string;
}): Response {
  return oauthJson(
    {
      error: "invalid_grant",
      error_description:
        result.description || result.reason.replaceAll("_", " "),
    },
    400
  );
}

export function oauthAuthorizationServerMetadata(
  req: NextRequest
): Record<string, unknown> {
  const issuer = oauthIssuer(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/exchange`,
    ...(dcrEnabled()
      ? { registration_endpoint: `${issuer}/oauth/register` }
      : {}),
    jwks_uri: `${issuer}/oauth/keys`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: supportedOauthScopes(),
    resource_indicators_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${oauthPublicBaseUrl(req)}/`,
  };
}
