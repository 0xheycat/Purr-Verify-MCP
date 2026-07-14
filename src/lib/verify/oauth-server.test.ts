import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { getOAuthJwks } from "./oauth-jwks";
import {
  handleAuthorize,
  handleToken,
  normalizeRequestedOauthScope,
  oauthAuthorizationServerMetadata,
  validateAuthorizeParams,
  verifyOAuthAccessToken,
} from "./oauth-server";

const ORIGIN = "https://verify.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://chatgpt.com/connector/oauth/test-callback";
const CLIENT_ID = "chatgpt-purr-verify";
const VERIFIER = "test-verifier";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, init ? { ...init, signal: undefined } : undefined);
}

function authorizeParams(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "verify:read verify:run",
    state: "test-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  });
}

async function issueAccessToken(): Promise<string> {
  const authorizeBody = authorizeParams();
  authorizeBody.set("owner_code", "x");
  const authorizeResponse = await handleAuthorize(
    request("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authorizeBody.toString(),
    })
  );
  const code = new URL(authorizeResponse.headers.get("location")!).searchParams.get("code")!;
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
  });
  const response = await handleToken(
    request("/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    })
  );
  const body = (await response.json()) as { access_token?: string };
  return body.access_token!;
}

beforeEach(() => {
  process.env.PUBLIC_BASE_URL = ORIGIN;
  process.env.OAUTH_ISSUER = ORIGIN;
  process.env.OAUTH_RESOURCE_URL = RESOURCE;
  process.env.OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.OAUTH_OWNER_CODE = "x";
  process.env.OAUTH_SCOPES_SUPPORTED = "verify:read verify:run verify:share";
  process.env.OAUTH_ACTIVE_KEY_ID = "test-ed25519-key";
  process.env.OAUTH_ALLOW_EPHEMERAL_KEYS = "true";
  delete process.env.OAUTH_PRIVATE_KEY;
  delete process.env.OAUTH_PUBLIC_KEY;
  delete process.env.OAUTH_VERIFICATION_PUBLIC_KEYS;
  delete process.env.OAUTH_JWT_SECRET;
});

describe("OAuth request validation", () => {
  test("normalizes and deduplicates supported scopes", () => {
    expect(normalizeRequestedOauthScope("verify:run verify:read verify:run")).toEqual({
      ok: true,
      scope: "verify:run verify:read",
    });
  });

  test("rejects unsupported scopes", () => {
    expect(normalizeRequestedOauthScope("verify:read repo")).toEqual({
      ok: false,
      reason: "unsupported scope: repo",
    });
  });

  test("requires the exact MCP resource", () => {
    const missing = authorizeParams();
    missing.delete("resource");
    expect(validateAuthorizeParams(missing, request("/oauth/authorize"))).toBe("resource is required");

    const wrong = authorizeParams({ resource: `${ORIGIN}/api/mcp` });
    expect(validateAuthorizeParams(wrong, request("/oauth/authorize"))).toBe(
      "resource does not match this MCP server"
    );
  });

  test("advertises supported Purr Verify scopes", () => {
    const metadata = oauthAuthorizationServerMetadata(request("/.well-known/oauth-authorization-server"));
    expect(metadata.scopes_supported).toEqual(["verify:read", "verify:run", "verify:share"]);
  });

  test("publishes the active Ed25519 public key as JWKS", () => {
    const jwks = getOAuthJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      use: "sig",
      kid: "test-ed25519-key",
    });
    expect(jwks.keys[0].d).toBeUndefined();
  });
});

describe("OAuth authorization-code flow", () => {
  test("binds resource and rejects authorization-code replay", async () => {
    const authorizeBody = authorizeParams();
    authorizeBody.set("owner_code", "x");
    const authorizeResponse = await handleAuthorize(
      request("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: authorizeBody.toString(),
      })
    );

    expect(authorizeResponse.status).toBe(303);
    const location = authorizeResponse.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    });

    const first = await handleToken(
      request("/oauth/exchange", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      })
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { access_token?: string; scope?: string };
    expect(firstBody.access_token).toBeTruthy();
    expect(firstBody.scope).toBe("verify:read verify:run");

    const header = JSON.parse(
      Buffer.from(firstBody.access_token!.split(".")[0], "base64url").toString("utf8")
    ) as { alg?: string; typ?: string; kid?: string };
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT", kid: "test-ed25519-key" });
    expect(verifyOAuthAccessToken(firstBody.access_token!, request("/mcp"))).toMatchObject({ ok: true });

    const replay = await handleToken(
      request("/oauth/exchange", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      })
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Authorization code has already been used",
    });
  });

  test("rejects a missing resource at token exchange", async () => {
    const authorizeBody = authorizeParams();
    authorizeBody.set("owner_code", "x");
    const authorizeResponse = await handleAuthorize(
      request("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: authorizeBody.toString(),
      })
    );
    const code = new URL(authorizeResponse.headers.get("location")!).searchParams.get("code")!;
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    const response = await handleToken(
      request("/oauth/exchange", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody.toString(),
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  test("rejects tampered signatures and unknown key ids", async () => {
    const token = await issueAccessToken();
    const parts = token.split(".");
    const changed = parts[2][0] === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${changed}${parts[2].slice(1)}`;
    expect(verifyOAuthAccessToken(tampered, request("/mcp"))).toMatchObject({
      ok: false,
      reason: "bad_signature_or_unknown_kid",
    });

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    header.kid = "unknown-key";
    const unknownHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const unknownKid = `${unknownHeader}.${parts[1]}.${parts[2]}`;
    expect(verifyOAuthAccessToken(unknownKid, request("/mcp"))).toMatchObject({
      ok: false,
      reason: "bad_signature_or_unknown_kid",
    });
  });
});
