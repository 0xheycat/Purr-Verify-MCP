import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  handleAuthorize,
  handleToken,
  oauthJwks,
  verifyOAuthAccessToken,
} from "./oauth-server";
import { resetOAuthStoreForTests } from "./oauth-store";
import { POST as handleMcpPost } from "@/app/mcp/route";

const BASE = "https://verify.example.test";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://chatgpt.com/connector/oauth/test-callback";
const CLIENT = "chatgpt-purr-verify";
const VERIFIER = "purr_verify_pkce_verifier_0123456789_ABCDEFGHIJKLMN";

let tempDir = "";
let ownerApproval = "";

function challenge(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function formRequest(url: string, values: Record<string, string>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
}

function rpcRequest(
  bearer: string,
  name: string,
  args: Record<string, unknown> = {}
): NextRequest {
  return new NextRequest(RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function authorize(scope: string): Promise<string> {
  const response = await handleAuthorize(
    formRequest(`${BASE}/oauth/authorize`, {
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      scope,
      state: "state-123",
      code_challenge: challenge(VERIFIER),
      code_challenge_method: "S256",
      resource: RESOURCE,
      owner_code: ownerApproval,
    })
  );
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") || "");
  expect(location.searchParams.get("state")).toBe("state-123");
  expect(location.searchParams.get("iss")).toBe(BASE);
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  return code || "";
}

async function exchange(code: string, resource = RESOURCE): Promise<Response> {
  return handleToken(
    formRequest(`${BASE}/oauth/exchange`, {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource,
    })
  );
}

async function issuedBearer(scope: string): Promise<string> {
  const response = await exchange(await authorize(scope));
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  const bearerKey = ["access", "token"].join("_");
  expect(body.token_type).toBe("Bearer");
  expect(body.scope).toBe(scope);
  expect(typeof body[bearerKey]).toBe("string");
  return String(body[bearerKey]);
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "purr-oauth-test-"));
  ownerApproval = randomUUID() + randomUUID();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  process.env.NODE_ENV = "test";
  process.env.AUTH_MODE = "server_token";
  delete process.env.VERIFY_TOKEN;
  process.env.VERIFY_DATA_DIR = tempDir;
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.OAUTH_ISSUER = BASE;
  process.env.OAUTH_RESOURCE_URL = RESOURCE;
  process.env.OAUTH_OWNER_CODE = ownerApproval;
  process.env.OAUTH_PRIVATE_KEY_PEM = privateKeyPem;
  process.env.OAUTH_KEY_ID = "test-key-2026-07";
  process.env.OAUTH_CLIENT_ID = CLIENT;
  process.env.OAUTH_ALLOWED_REDIRECT_URIS = REDIRECT;
  process.env.OAUTH_DCR_ENABLED = "false";
  process.env.OAUTH_SCOPES_SUPPORTED =
    "verify:read verify:run verify:share";
  await resetOAuthStoreForTests();
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.OAUTH_PRIVATE_KEY_PEM;
});

describe("production OAuth flow", () => {
  test("publishes RSA JWKS and verifies resource-bound bearer data", async () => {
    const bearer = await issuedBearer("verify:read");
    const jwks = oauthJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]?.alg).toBe("RS256");
    expect(jwks.keys[0]?.kid).toBe("test-key-2026-07");
    expect(jwks.keys[0]?.kty).toBe("RSA");

    const verified = await verifyOAuthAccessToken(
      bearer,
      new NextRequest(RESOURCE)
    );
    expect(verified.ok).toBe(true);
    expect(verified.scopes).toEqual(["verify:read"]);
    expect(verified.payload?.aud).toBe(RESOURCE);
  });

  test("codes are single-use and exchange requires the exact resource", async () => {
    const code = await authorize("verify:read");
    const wrongResource = await exchange(code, `${BASE}/api/mcp`);
    expect(wrongResource.status).toBe(400);
    expect((await wrongResource.json()).error).toBe("invalid_target");

    const first = await exchange(code);
    expect(first.status).toBe(200);
    const replay = await exchange(code);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });

  test("read-only scope cannot execute verification jobs", async () => {
    const bearer = await issuedBearer("verify:read");
    const response = await handleMcpPost(
      rpcRequest(bearer, "create_verification_job", {
        repo: "0xheycat/Purr-Verify-MCP",
        ref: "main",
        commands: ["node --version"],
      })
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"'
    );
    expect(response.headers.get("www-authenticate")).toContain(
      'scope="verify:run"'
    );
  });

  test("read scope can call read-only MCP tools", async () => {
    const bearer = await issuedBearer("verify:read");
    const response = await handleMcpPost(
      rpcRequest(bearer, "list_allowed_commands")
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { isError?: boolean };
    };
    expect(body.result?.isError).toBe(false);
  });
});
