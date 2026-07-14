import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getOAuthSigningKey, oauthSigningAlgorithm, signEd25519, verifyEd25519 } from "./oauth-keys";

const registeredClients = new Map<string, { redirect_uris: string[]; created_at: number }>();
const consumedAuthorizationCodes = new Set<string>();

interface AuthorizationCodePayload {
  typ: "oauth_code";
  client_id: string;
  redirect_uri: string;
  scope: string;
  resource: string;
  code_challenge: string;
  jti: string;
  iat: number;
  exp: number;
}

function splitList(raw = ""): string[] {
  return raw.split(/[ ,]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeNoTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function requestOrigin(req: NextRequest): string {
  const parsed = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || parsed.protocol.replace(/:$/, "") || "https";
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || parsed.host;
  return `${proto}://${host}`;
}

function publicBaseUrl(req: NextRequest): string {
  return normalizeNoTrailingSlash(process.env.PUBLIC_BASE_URL || requestOrigin(req));
}

export function oauthIssuer(req: NextRequest): string {
  return normalizeNoTrailingSlash(process.env.OAUTH_ISSUER || requestOrigin(req));
}

export function oauthResourceUrl(req: NextRequest): string {
  return process.env.OAUTH_RESOURCE_URL || `${publicBaseUrl(req)}/mcp`;
}

export function supportedOauthScopes(): string[] {
  return splitList(process.env.OAUTH_SCOPES_SUPPORTED || "verify:read verify:run verify:share");
}

export function normalizeRequestedOauthScope(raw: string): { ok: boolean; scope?: string; reason?: string } {
  const supported = new Set(supportedOauthScopes());
  const requested = splitList(raw || supportedOauthScopes().join(" "));
  if (requested.length === 0) return { ok: false, reason: "scope is required" };
  const unique = [...new Set(requested)];
  const unsupported = unique.find((scope) => !supported.has(scope));
  if (unsupported) return { ok: false, reason: `unsupported scope: ${unsupported}` };
  return { ok: true, scope: unique.join(" ") };
}

function allowedRedirectUris(): string[] {
  return splitList(process.env.OAUTH_ALLOWED_REDIRECT_URIS || process.env.ALLOWED_REDIRECT_URIS || "");
}

function defaultClientId(): string {
  return process.env.OAUTH_CLIENT_ID || "chatgpt-purr-verify";
}

function ownerCode(): string {
  return process.env.OAUTH_OWNER_CODE || process.env.OAUTH_ADMIN_CODE || "";
}

function tokenTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.OAUTH_TOKEN_TTL_SECONDS || "3600", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600;
}

function jwtSecret(): string {
  return process.env.OAUTH_JWT_SECRET || process.env.VERIFY_TOKEN || "";
}

function subject(): string {
  return process.env.OAUTH_SUBJECT || "0xheycat";
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function jsonBase64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function hmacBase64url(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function signPayload(payload: Record<string, unknown>): string {
  const secret = jwtSecret();
  if (!secret) throw new Error("OAUTH_JWT_SECRET or VERIFY_TOKEN is required");
  const header = { alg: "HS256", typ: "JWT" };
  const unsigned = `${jsonBase64url(header)}.${jsonBase64url(payload)}`;
  return `${unsigned}.${hmacBase64url(unsigned, secret)}`;
}

function decodeSignedPayload(token: string): { ok: boolean; reason?: string; payload?: Record<string, unknown> } {
  const secret = jwtSecret();
  if (!secret) return { ok: false, reason: "missing_jwt_secret" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const [encodedHeader, encodedPayload, signature] = parts;
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { alg?: string };
    if (header.alg !== "HS256") return { ok: false, reason: "unsupported_alg" };
    const expected = hmacBase64url(`${encodedHeader}.${encodedPayload}`, secret);
    if (!safeEqual(signature, expected)) return { ok: false, reason: "bad_signature" };
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "invalid_token_json" };
  }
}

function signAuthorizationCode(payload: AuthorizationCodePayload): string {
  return signPayload(payload as unknown as Record<string, unknown>);
}

function verifyAuthorizationCode(code: string): { ok: boolean; reason?: string; payload?: AuthorizationCodePayload } {
  const decoded = decodeSignedPayload(code);
  if (!decoded.ok || !decoded.payload) return { ok: false, reason: decoded.reason };
  const payload = decoded.payload as Partial<AuthorizationCodePayload>;
  const now = Math.floor(Date.now() / 1000);
  if (payload.typ !== "oauth_code") return { ok: false, reason: "wrong_code_type" };
  if (typeof payload.exp !== "number" || payload.exp <= now) return { ok: false, reason: "expired_code" };
  if (!payload.client_id || !payload.redirect_uri || !payload.resource || !payload.code_challenge || !payload.jti) {
    return { ok: false, reason: "malformed_code" };
  }
  return { ok: true, payload: payload as AuthorizationCodePayload };
}

export function verifyOAuthAccessToken(token: string, req: NextRequest): { ok: boolean; reason?: string; payload?: Record<string, unknown> } {
  const decoded = decodeSignedPayload(token);
  if (!decoded.ok || !decoded.payload) return decoded;
  const payload = decoded.payload;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return { ok: false, reason: "expired_token" };
  if (payload.iss !== oauthIssuer(req)) return { ok: false, reason: "bad_issuer" };
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(oauthResourceUrl(req))) return { ok: false, reason: "bad_audience" };
  return { ok: true, payload };
}

function validRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch {
    return false;
  }
}

function isRedirectAllowed(clientId: string, redirectUri: string): boolean {
  if (!validRedirectUri(redirectUri)) return false;
  const registered = registeredClients.get(clientId);
  if (registered?.redirect_uris.includes(redirectUri)) return true;
  if (clientId === defaultClientId()) {
    const allowed = allowedRedirectUris();
    if (allowed.length > 0) return allowed.includes(redirectUri);
    return redirectUri.startsWith("https://chatgpt.com/connector/oauth/");
  }
  return false;
}

export function validateAuthorizeParams(params: URLSearchParams, req: NextRequest): string {
  const responseType = params.get("response_type");
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const codeChallenge = params.get("code_challenge") || "";
  const codeChallengeMethod = params.get("code_challenge_method") || "";
  const resource = params.get("resource") || "";
  const requestedScope = normalizeRequestedOauthScope(params.get("scope") || "");
  if (responseType !== "code") return "response_type must be code";
  if (!clientId) return "client_id is required";
  if (!redirectUri) return "redirect_uri is required";
  if (!isRedirectAllowed(clientId, redirectUri)) return "redirect_uri is not allowed for this client_id";
  if (!codeChallenge) return "code_challenge is required";
  if (codeChallengeMethod !== "S256") return "code_challenge_method must be S256";
  if (!resource) return "resource is required";
  if (resource !== oauthResourceUrl(req)) return "resource does not match this MCP server";
  if (!requestedScope.ok) return requestedScope.reason || "invalid scope";
  return "";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderAuthorizePage(params: URLSearchParams, req: NextRequest, error = ""): string {
  const fields = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"];
  const hidden = fields.map((key) => `<input type="hidden" name="${key}" value="${escapeHtml(params.get(key) || "")}">`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Purr Verify MCP OAuth</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#09090b;color:#fafafa;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}main{width:min(440px,100%);background:#18181b;border:1px solid #3f3f46;border-radius:18px;padding:24px;box-shadow:0 18px 60px #0008}h1{font-size:20px;margin:0 0 8px}p{color:#d4d4d8;line-height:1.5}code{color:#fbbf24;word-break:break-all}input,button{width:100%;box-sizing:border-box;border-radius:10px;border:1px solid #52525b;background:#09090b;color:#fafafa;padding:12px;font-size:15px}button{margin-top:12px;background:#22c55e;border:0;font-weight:700;cursor:pointer}.err{color:#fca5a5}.muted{font-size:13px;color:#a1a1aa}</style></head><body><main><h1>Authorize Purr Verify MCP</h1><p>ChatGPT is requesting access to <code>${escapeHtml(oauthResourceUrl(req))}</code>.</p><p class="muted">Client: <code>${escapeHtml(params.get("client_id") || "")}</code><br>Scopes: <code>${escapeHtml(params.get("scope") || supportedOauthScopes().join(" "))}</code></p>${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}<form method="post" action="/oauth/authorize">${hidden}<label>Owner approval code</label><input type="password" name="owner_code" autocomplete="current-password" required autofocus><button type="submit">Authorize ChatGPT</button></form></main></body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function readOAuthParams(req: NextRequest): Promise<URLSearchParams> {
  const raw = await req.text();
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const json = JSON.parse(raw || "{}");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  return new URLSearchParams(raw);
}

export function oauthAuthorizationServerMetadata(req: NextRequest): Record<string, unknown> {
  const issuer = oauthIssuer(req);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/exchange`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: supportedOauthScopes(),
    resource_indicators_supported: true,
  };
}

export async function handleAuthorize(req: NextRequest): Promise<Response> {
  if (!ownerCode()) return html("<h1>OAuth setup required</h1><p>Set OAUTH_OWNER_CODE before using OAuth.</p>", 500);
  if (req.method === "GET") {
    const url = new URL(req.url);
    const error = validateAuthorizeParams(url.searchParams, req);
    return html(renderAuthorizePage(url.searchParams, req, error), error ? 400 : 200);
  }
  if (req.method !== "POST") return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
  const params = await readOAuthParams(req);
  const error = validateAuthorizeParams(params, req);
  if (error) return html(renderAuthorizePage(params, req, error), 400);
  if (!safeEqual(params.get("owner_code") || "", ownerCode())) {
    return html(renderAuthorizePage(params, req, "Invalid owner approval code."), 401);
  }
  const normalizedScope = normalizeRequestedOauthScope(params.get("scope") || "");
  if (!normalizedScope.ok || !normalizedScope.scope) return html(renderAuthorizePage(params, req, normalizedScope.reason || "Invalid scope"), 400);
  const now = Math.floor(Date.now() / 1000);
  const code = signAuthorizationCode({
    typ: "oauth_code",
    client_id: params.get("client_id") || "",
    redirect_uri: params.get("redirect_uri") || "",
    scope: normalizedScope.scope,
    resource: params.get("resource") || "",
    code_challenge: params.get("code_challenge") || "",
    jti: randomBytes(16).toString("base64url"),
    iat: now,
    exp: now + 5 * 60,
  });
  const callback = new URL(params.get("redirect_uri") || "");
  callback.searchParams.set("code", code);
  const state = params.get("state");
  if (state) callback.searchParams.set("state", state);
  return NextResponse.redirect(callback.toString(), 303);
}

export async function handleToken(req: NextRequest): Promise<Response> {
  if (req.method !== "POST") return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
  const params = await readOAuthParams(req);
  if (params.get("grant_type") !== "authorization_code") return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  const rawCode = params.get("code") || "";
  const verifiedCode = verifyAuthorizationCode(rawCode);
  if (!verifiedCode.ok || !verifiedCode.payload) {
    return NextResponse.json({ error: "invalid_grant", error_description: verifiedCode.reason || "Invalid code" }, { status: 400 });
  }
  const entry = verifiedCode.payload;
  const codeKey = createHash("sha256").update(rawCode).digest("hex");
  if (consumedAuthorizationCodes.has(codeKey)) {
    return NextResponse.json({ error: "invalid_grant", error_description: "Authorization code has already been used" }, { status: 400 });
  }
  const requestClientId = params.get("client_id") || entry.client_id;
  const requestRedirectUri = params.get("redirect_uri") || entry.redirect_uri;
  if (requestClientId !== entry.client_id || requestRedirectUri !== entry.redirect_uri) {
    return NextResponse.json({ error: "invalid_grant", error_description: "Client or redirect URI mismatch" }, { status: 400 });
  }
  const verifier = params.get("code_verifier") || "";
  if (!verifier || sha256Base64url(verifier) !== entry.code_challenge) {
    return NextResponse.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
  }
  const requestResource = params.get("resource") || "";
  if (!requestResource || requestResource !== entry.resource || requestResource !== oauthResourceUrl(req)) {
    return NextResponse.json({ error: "invalid_target", error_description: "resource is required and must match the authorized MCP resource" }, { status: 400 });
  }
  consumedAuthorizationCodes.add(codeKey);
  const now = Math.floor(Date.now() / 1000);
  const ttl = tokenTtlSeconds();
  const accessToken = signPayload({
    iss: oauthIssuer(req),
    sub: subject(),
    aud: entry.resource,
    client_id: entry.client_id,
    scope: entry.scope,
    jti: randomBytes(16).toString("base64url"),
    iat: now,
    exp: now + ttl,
  });
  return NextResponse.json(
    { access_token: accessToken, token_type: "Bearer", expires_in: ttl, scope: entry.scope },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

export async function handleRegister(req: NextRequest): Promise<Response> {
  if (req.method !== "POST") return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
  let body: { redirect_uris?: unknown } = {};
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? [...new Set(body.redirect_uris.filter((uri): uri is string => typeof uri === "string" && validRedirectUri(uri)))]
    : [];
  if (redirectUris.length === 0) return NextResponse.json({ error: "invalid_redirect_uri" }, { status: 400 });
  const clientId = `chatgpt-${randomBytes(12).toString("base64url")}`;
  registeredClients.set(clientId, { redirect_uris: redirectUris, created_at: Date.now() });
  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
