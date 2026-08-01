import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const ORIGIN = "https://verify.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://www.notion.so/mcp/oauth/callback";
const TEST_ROOT = path.join(
  os.tmpdir(),
  `purr-oauth-dynamic-client-tests-${process.pid}`
);

function request(pathname: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    `${ORIGIN}${pathname}`,
    init ? { ...init, signal: undefined } : undefined
  );
}

async function loadOAuthServer(label: string) {
  return import(`./oauth-server.ts?${label}-${crypto.randomUUID()}`);
}

beforeEach(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  process.env.VERIFY_DATA_DIR = TEST_ROOT;
  process.env.OAUTH_STORAGE_MODE = "json";
  process.env.PUBLIC_BASE_URL = ORIGIN;
  process.env.OAUTH_ISSUER = ORIGIN;
  process.env.OAUTH_RESOURCE_URL = RESOURCE;
  process.env.OAUTH_CLIENT_ID = "chatgpt-purr-verify";
  process.env.OAUTH_OWNER_CODE = "x";
  process.env.OAUTH_SCOPES_SUPPORTED =
    "verify:read verify:run verify:share repo read:user user:email offline_access";
});

afterAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("OAuth dynamic client registration", () => {
  test("survives a fresh server module and preserves the exact redirect URI", async () => {
    const registrationServer = await loadOAuthServer("registration-process");
    const registration = await registrationServer.handleRegister(
      request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      })
    );
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as {
      client_id: string;
      redirect_uris: string[];
    };
    expect(registered.client_id.startsWith("chatgpt-")).toBe(true);
    expect(registered.redirect_uris).toEqual([REDIRECT]);

    const authorizeServer = await loadOAuthServer("fresh-server-process");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: REDIRECT,
      scope:
        "verify:run verify:read repo read:user user:email offline_access",
      state: "notion-state",
      code_challenge: "notion-pkce-challenge",
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    const authorize = await authorizeServer.handleAuthorize(
      request(`/oauth/authorize?${params.toString()}`)
    );
    expect(authorize.status).toBe(200);
    const page = await authorize.text();
    expect(page).not.toContain(
      "redirect_uri is not allowed for this client_id"
    );
    expect(page).toContain("An MCP client is requesting access");
    expect(page).toContain("Authorize MCP Client");
    expect(page).not.toContain("ChatGPT is requesting access");
  });

  test("continues to reject a redirect URI that was not registered", async () => {
    const server = await loadOAuthServer("redirect-mismatch");
    const registration = await server.handleRegister(
      request("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      })
    );
    const registered = (await registration.json()) as { client_id: string };
    const params = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: "https://attacker.example.test/oauth/callback",
      scope: "verify:read",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: RESOURCE,
    });

    const authorize = await server.handleAuthorize(
      request(`/oauth/authorize?${params.toString()}`)
    );
    expect(authorize.status).toBe(400);
    expect(await authorize.text()).toContain(
      "redirect_uri is not allowed for this client_id"
    );
  });
});