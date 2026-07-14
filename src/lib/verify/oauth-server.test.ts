import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { getOAuthJwks } from "./oauth-jwks";
import { resetOAuthStateForTests } from "./oauth-state";
import {
  handleAuthorize,
  handleRevoke,
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
const CHALLENGE = createHash("sha256")
  .update(VERIFIER)
  .digest("base64url");
const TEST_DATA_DIR = path.join(
  os.tmpdir(),
  `purr-oauth-tests-${process.pid}`
);

interface OAuthTokenBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function request(pathname: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    `${ORIGIN}${pathname}`,
    init ? { ...init, signal: undefined } : undefined
  );
}

function formRequest(
  pathname: string,
  values: Record<string, string>
): NextRequest {
  return request(pathname, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

function authorizeParams(
  overrides: Record<string, string> = {}
): URLSearchParams {
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

async function issueAuthorizationCode(
  scope = "verify:read verify:run"
): Promise<string> {
  const authorizeBody = authorizeParams({ scope });
  authorizeBody.set("owner_code", "x");
  const response = await handleAuthorize(
    request("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authorizeBody.toString(),
    })
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  return new URL(location!).searchParams.get("code")!;
}

async function exchangeAuthorizationCode(
  scope = "verify:read verify:run"
): Promise<OAuthTokenBody> {
  const code = await issueAuthorizationCode(scope);
  const response = await handleToken(
    formRequest("/oauth/exchange", {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    })
  );
  expect(response.status).toBe(200);
  return (await response.json()) as OAuthTokenBody;
}

async function refresh(
  credential: string,
  overrides: Record<string, string> = {}
): Promise<Response> {
  return handleToken(
    formRequest("/oauth/exchange", {
      grant_type: "refresh_token",
      refresh_token: credential,
      client_id: CLIENT_ID,
      resource: RESOURCE,
      ...overrides,
    })
  );
}

beforeEach(async () => {
  process.env.VERIFY_DATA_DIR = TEST_DATA_DIR;
  process.env.PUBLIC_BASE_URL = ORIGIN;
  process.env.OAUTH_ISSUER = ORIGIN;
  process.env.OAUTH_RESOURCE_URL = RESOURCE;
  process.env.OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.OAUTH_OWNER_CODE = "x";
  process.env.OAUTH_SCOPES_SUPPORTED =
    "verify:read verify:run verify:share";
  process.env.OAUTH_ACTIVE_KEY_ID = "test-ed25519-key";
  process.env.OAUTH_ALLOW_EPHEMERAL_KEYS = "true";
  process.env.OAUTH_TOKEN_TTL_SECONDS = "900";
  process.env.OAUTH_REFRESH_TOKEN_TTL_SECONDS = "2592000";
  delete process.env.OAUTH_PRIVATE_KEY;
  delete process.env.OAUTH_PUBLIC_KEY;
  delete process.env.OAUTH_VERIFICATION_PUBLIC_KEYS;
  delete process.env.OAUTH_JWT_SECRET;
  await resetOAuthStateForTests();
});

afterAll(async () => {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

describe("OAuth request validation", () => {
  test("normalizes and deduplicates supported scopes", () => {
    expect(
      normalizeRequestedOauthScope(
        "verify:run verify:read verify:run"
      )
    ).toEqual({
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
    expect(
      validateAuthorizeParams(
        missing,
        request("/oauth/authorize")
      )
    ).toBe("resource is required");

    const wrong = authorizeParams({ resource: `${ORIGIN}/api/mcp` });
    expect(
      validateAuthorizeParams(wrong, request("/oauth/authorize"))
    ).toBe("resource does not match this MCP server");
  });

  test("advertises refresh rotation and revocation", () => {
    const metadata = oauthAuthorizationServerMetadata(
      request("/.well-known/oauth-authorization-server")
    );
    expect(metadata.scopes_supported).toEqual([
      "verify:read",
      "verify:run",
      "verify:share",
    ]);
    expect(metadata.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(metadata.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
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
    const code = await issueAuthorizationCode();
    const values = {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    };

    const first = await handleToken(
      formRequest("/oauth/exchange", values)
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as OAuthTokenBody;
    expect(firstBody.access_token).toBeTruthy();
    expect(firstBody.refresh_token).toBeTruthy();
    expect(firstBody.scope).toBe("verify:read verify:run");
    expect(firstBody.expires_in).toBe(900);

    const header = JSON.parse(
      Buffer.from(
        firstBody.access_token!.split(".")[0],
        "base64url"
      ).toString("utf8")
    ) as { alg?: string; typ?: string; kid?: string };
    expect(header).toEqual({
      alg: "EdDSA",
      typ: "JWT",
      kid: "test-ed25519-key",
    });
    expect(
      verifyOAuthAccessToken(
        firstBody.access_token!,
        request("/mcp")
      )
    ).toMatchObject({ ok: true });

    const replay = await handleToken(
      formRequest("/oauth/exchange", values)
    );
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Authorization code has already been used",
    });
  });

  test("uses the signed code resource when token exchange omits resource", async () => {
    const code = await issueAuthorizationCode();
    const response = await handleToken(
      formRequest("/oauth/exchange", {
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OAuthTokenBody;
    expect(body.access_token).toBeTruthy();
    expect(
      verifyOAuthAccessToken(body.access_token!, request("/mcp"))
    ).toMatchObject({ ok: true });
  });

  test("rejects tampered signatures and unknown key ids", async () => {
    const issued = await exchangeAuthorizationCode();
    const parts = issued.access_token!.split(".");
    const changed = parts[2][0] === "A" ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${changed}${parts[2].slice(1)}`;
    expect(
      verifyOAuthAccessToken(tampered, request("/mcp"))
    ).toMatchObject({
      ok: false,
      reason: "bad_signature_or_unknown_kid",
    });

    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8")
    ) as Record<string, unknown>;
    header.kid = "unknown-key";
    const unknownHeader = Buffer.from(JSON.stringify(header)).toString(
      "base64url"
    );
    const unknownKid = `${unknownHeader}.${parts[1]}.${parts[2]}`;
    expect(
      verifyOAuthAccessToken(unknownKid, request("/mcp"))
    ).toMatchObject({
      ok: false,
      reason: "bad_signature_or_unknown_kid",
    });
  });
});

describe("OAuth refresh grants", () => {
  test("rotates credentials and revokes the family on replay", async () => {
    const initial = await exchangeAuthorizationCode();
    const firstRefresh = await refresh(initial.refresh_token!);
    expect(firstRefresh.status).toBe(200);
    const rotated = (await firstRefresh.json()) as OAuthTokenBody;
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);
    expect(rotated.access_token).toBeTruthy();

    const replay = await refresh(initial.refresh_token!);
    expect(replay.status).toBe(400);
    const replayBody = (await replay.json()) as OAuthTokenBody;
    expect(replayBody.error).toBe("invalid_grant");
    expect(replayBody.error_description).toContain("replay detected");

    const descendant = await refresh(rotated.refresh_token!);
    expect(descendant.status).toBe(400);
    expect(await descendant.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Refresh grant revoked",
    });
  });

  test("rejects a wrong resource without consuming the grant", async () => {
    const initial = await exchangeAuthorizationCode();
    const wrong = await refresh(initial.refresh_token!, {
      resource: `${ORIGIN}/api/mcp`,
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({
      error: "invalid_target",
    });

    const correct = await refresh(initial.refresh_token!);
    expect(correct.status).toBe(200);
  });

  test("allows scope narrowing and rejects later escalation", async () => {
    const initial = await exchangeAuthorizationCode(
      "verify:read verify:run"
    );
    const narrowedResponse = await refresh(initial.refresh_token!, {
      scope: "verify:read",
    });
    expect(narrowedResponse.status).toBe(200);
    const narrowed = (await narrowedResponse.json()) as OAuthTokenBody;
    expect(narrowed.scope).toBe("verify:read");

    const escalation = await refresh(narrowed.refresh_token!, {
      scope: "verify:read verify:run",
    });
    expect(escalation.status).toBe(400);
    expect(await escalation.json()).toMatchObject({
      error: "invalid_scope",
    });

    const validRetry = await refresh(narrowed.refresh_token!, {
      scope: "verify:read",
    });
    expect(validRetry.status).toBe(200);
  });

  test("explicit revocation invalidates the complete family", async () => {
    const initial = await exchangeAuthorizationCode();
    const rotatedResponse = await refresh(initial.refresh_token!);
    const rotated = (await rotatedResponse.json()) as OAuthTokenBody;

    const revoke = await handleRevoke(
      formRequest("/oauth/revoke", {
        token: rotated.refresh_token!,
        token_type_hint: "refresh_token",
      })
    );
    expect(revoke.status).toBe(200);

    const rejected = await refresh(rotated.refresh_token!);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Refresh grant revoked",
    });
  });

  test("persists only hashes of refresh credentials", async () => {
    const issued = await exchangeAuthorizationCode();
    const state = await fs.readFile(
      path.join(TEST_DATA_DIR, "oauth", "state.json"),
      "utf8"
    );
    expect(state).not.toContain(issued.refresh_token!);
    expect(state).toContain("credentialHash");
  });
});
