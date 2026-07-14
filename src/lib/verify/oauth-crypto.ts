import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { NextRequest } from "next/server";
import { isRefreshFamilyRevoked } from "./oauth-store";

const DEFAULT_SCOPES = ["verify:read", "verify:run", "verify:share"];

export interface OAuthAccessTokenClaims extends Record<string, unknown> {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  scope: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  fid: string;
}

interface OAuthKeyMaterial {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
}

export function splitOAuthList(raw = ""): string[] {
  return raw
    .split(/[ ,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNoTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function requestOrigin(req: NextRequest): string {
  return new URL(req.url).origin;
}

export function oauthPublicBaseUrl(req: NextRequest): string {
  return normalizeNoTrailingSlash(process.env.PUBLIC_BASE_URL || requestOrigin(req));
}

export function oauthIssuer(req: NextRequest): string {
  return normalizeNoTrailingSlash(process.env.OAUTH_ISSUER || oauthPublicBaseUrl(req));
}

export function oauthResourceUrl(req: NextRequest): string {
  return process.env.OAUTH_RESOURCE_URL || `${oauthPublicBaseUrl(req)}/mcp`;
}

export function supportedOauthScopes(): string[] {
  const configured = splitOAuthList(
    process.env.OAUTH_SCOPES_SUPPORTED || DEFAULT_SCOPES.join(" ")
  );
  return [...new Set(configured.length > 0 ? configured : DEFAULT_SCOPES)];
}

export function oauthTokenTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.OAUTH_TOKEN_TTL_SECONDS || "900", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900;
}

export function oauthRefreshTokenTtlSeconds(): number {
  const parsed = Number.parseInt(
    process.env.OAUTH_REFRESH_TOKEN_TTL_SECONDS || "2592000",
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_592_000;
}

export function oauthSubject(): string {
  return process.env.OAUTH_SUBJECT || "self-hosted-owner";
}

function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function keyMaterial():
  | { ok: true; value: OAuthKeyMaterial }
  | { ok: false; reason: string } {
  const pem = process.env.OAUTH_PRIVATE_KEY_PEM || "";
  if (!pem.trim()) {
    return { ok: false, reason: "OAUTH_PRIVATE_KEY_PEM is required" };
  }
  try {
    const privateKey = createPrivateKey(normalizePem(pem));
    if (
      privateKey.asymmetricKeyType !== "rsa" &&
      privateKey.asymmetricKeyType !== "rsa-pss"
    ) {
      return {
        ok: false,
        reason: "OAUTH_PRIVATE_KEY_PEM must contain an RSA private key",
      };
    }
    const publicKey = createPublicKey(privateKey);
    const fingerprint = createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("base64url")
      .slice(0, 16);
    return {
      ok: true,
      value: {
        privateKey,
        publicKey,
        kid: process.env.OAUTH_KEY_ID || `purr-${fingerprint}`,
      },
    };
  } catch {
    return {
      ok: false,
      reason: "OAUTH_PRIVATE_KEY_PEM is not a valid RSA private key",
    };
  }
}

function validHttpsUrl(value: string): boolean {
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

export function oauthConfigurationStatus(
  req: NextRequest
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (process.env.NODE_ENV === "production" && !process.env.PUBLIC_BASE_URL) {
    reasons.push("PUBLIC_BASE_URL is required in production");
  }
  if (process.env.NODE_ENV === "production" && !process.env.OAUTH_ISSUER) {
    reasons.push("OAUTH_ISSUER is required in production");
  }
  if (process.env.NODE_ENV === "production" && !process.env.OAUTH_RESOURCE_URL) {
    reasons.push("OAUTH_RESOURCE_URL is required in production");
  }
  if (!validHttpsUrl(oauthIssuer(req))) {
    reasons.push("OAUTH_ISSUER must be an absolute HTTPS URL");
  }
  if (!validHttpsUrl(oauthResourceUrl(req))) {
    reasons.push("OAUTH_RESOURCE_URL must be an absolute HTTPS URL");
  }
  const ownerCode =
    process.env.OAUTH_OWNER_CODE || process.env.OAUTH_ADMIN_CODE || "";
  if (ownerCode.length < 16) {
    reasons.push("OAUTH_OWNER_CODE must contain at least 16 characters");
  }
  const keys = keyMaterial();
  if (!keys.ok) reasons.push(keys.reason);
  return { ok: reasons.length === 0, reasons };
}

function jsonBase64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJsonPart(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function signOAuthAccessToken(
  payload: OAuthAccessTokenClaims
): string {
  const keys = keyMaterial();
  if (!keys.ok) throw new Error(keys.reason);
  const header = { alg: "RS256", typ: "at+jwt", kid: keys.value.kid };
  const unsigned = `${jsonBase64url(header)}.${jsonBase64url(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer
    .sign(keys.value.privateKey)
    .toString("base64url")}`;
}

export async function verifyOAuthAccessToken(
  token: string,
  req: NextRequest
): Promise<{
  ok: boolean;
  reason?: string;
  payload?: OAuthAccessTokenClaims;
  scopes?: string[];
  subject?: string;
  clientId?: string;
}> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_token" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart(encodedHeader);
  const payload = decodeJsonPart(
    encodedPayload
  ) as OAuthAccessTokenClaims | null;
  if (!header || !payload) {
    return { ok: false, reason: "invalid_token_json" };
  }
  if (header.alg !== "RS256" || header.typ !== "at+jwt") {
    return { ok: false, reason: "unsupported_token" };
  }

  const keys = keyMaterial();
  if (!keys.ok) {
    return { ok: false, reason: "oauth_signing_key_unavailable" };
  }
  if (header.kid !== keys.value.kid) {
    return { ok: false, reason: "unknown_key" };
  }

  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    const valid = verifier.verify(
      keys.value.publicKey,
      Buffer.from(encodedSignature, "base64url")
    );
    if (!valid) return { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== oauthIssuer(req)) {
    return { ok: false, reason: "bad_issuer" };
  }
  if (payload.aud !== oauthResourceUrl(req)) {
    return { ok: false, reason: "bad_audience" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return { ok: false, reason: "expired_token" };
  }
  if (typeof payload.nbf !== "number" || payload.nbf > now + 30) {
    return { ok: false, reason: "token_not_active" };
  }
  if (typeof payload.iat !== "number" || payload.iat > now + 30) {
    return { ok: false, reason: "bad_issued_at" };
  }
  if (
    !payload.sub ||
    !payload.client_id ||
    !payload.jti ||
    !payload.fid
  ) {
    return { ok: false, reason: "missing_claims" };
  }
  if (await isRefreshFamilyRevoked(payload.fid)) {
    return { ok: false, reason: "token_family_revoked" };
  }

  const scopes = splitOAuthList(
    typeof payload.scope === "string" ? payload.scope : ""
  );
  return {
    ok: true,
    payload,
    scopes,
    subject: payload.sub,
    clientId: payload.client_id,
  };
}

export function oauthJwks(): { keys: Record<string, unknown>[] } {
  const keys = keyMaterial();
  if (!keys.ok) throw new Error(keys.reason);
  const jwk = keys.value.publicKey.export({
    format: "jwk",
  }) as Record<string, unknown>;
  return {
    keys: [
      {
        ...jwk,
        kid: keys.value.kid,
        use: "sig",
        alg: "RS256",
      },
    ],
  };
}

export function createAccessTokenClaims(input: {
  req: NextRequest;
  clientId: string;
  scope: string;
  resource: string;
  subject: string;
  familyId: string;
}): OAuthAccessTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: oauthIssuer(input.req),
    sub: input.subject,
    aud: input.resource,
    client_id: input.clientId,
    scope: input.scope,
    iat: now,
    nbf: now - 5,
    exp: now + oauthTokenTtlSeconds(),
    jti: randomUUID(),
    fid: input.familyId,
  };
}