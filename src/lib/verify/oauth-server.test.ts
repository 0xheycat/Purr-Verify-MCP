import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import {
  handleAuthorize,
  handleToken,
  normalizeRequestedOauthScope,
  oauthAuthorizationServerMetadata,
  validateAuthorizeParams,
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

beforeEach(() => {
  process.env.PUBLIC_BASE_URL = ORIGIN;
  process.env.OAUTH_ISSUER = ORIGIN;
  process.env.OAUTH_RESOURCE_URL = RESOURCE;
  process.env.OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.OAUTH_OWNER_CODE = "x";
  process.env.OAUTH_JWT_SECRET = "x";
  process.env.OAUTH_SCOPES_SUPPORTED = "verify:read verify:run verify:share";
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

  test("does not advertise JWKS while using symmetric tokens", () => {
    const metadata = oauthAuthorizationServerMetadata(request("/.well-known/oauth-authorization-server"));
    expect(metadata.jwks_uri).toBeUndefined();
    expect(metadata.scopes_supported).toEqual(["verify:read", "verify:run", "verify:share"]);
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
});
