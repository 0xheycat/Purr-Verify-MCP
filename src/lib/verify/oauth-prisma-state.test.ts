import {
  afterAll,
  beforeAll,
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
import { resetOAuthStateForTests } from "./oauth-state";
import { handleAuthorize, handleRevoke, handleToken } from "./oauth-server";

const ORIGIN = "https://verify.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://chatgpt.com/connector/oauth/prisma-callback";
const CLIENT_ID = "chatgpt-purr-verify";
const VERIFIER = "test-verifier";
const CHALLENGE = createHash("sha256")
  .update(VERIFIER)
  .digest("base64url");
const TEST_ROOT = path.join(
  os.tmpdir(),
  `purr-oauth-prisma-tests-${process.pid}`
);
const DATABASE_URL = `file:${path.join(TEST_ROOT, "oauth-prisma.db")}`;

interface OAuthTokenBody {
  access_token?: string;
  refresh_token?: string;
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

function authorizeParams(): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "verify:read verify:run",
    state: "test-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
}

async function prismaDb(): Promise<{
  oAuthAuthorizationCode: {
    count(): Promise<number>;
  };
  oAuthRefreshGrant: {
    count(): Promise<number>;
    findMany(): Promise<unknown[]>;
  };
  $disconnect(): Promise<void>;
}> {
  const { db } = await import("../db");
  return db as unknown as Awaited<ReturnType<typeof prismaDb>>;
}

async function pushPrismaSchema(): Promise<void> {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  process.env.DATABASE_URL = DATABASE_URL;
  const proc = Bun.spawn(["bunx", "prisma", "db", "push", "--skip-generate"], {
    env: { ...process.env, DATABASE_URL },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`prisma db push failed\n${stdout}\n${stderr}`);
  }
}

async function issueAuthorizationCode(): Promise<string> {
  const params = authorizeParams();
  params.set("owner_code", "x");
  const response = await handleAuthorize(
    request("/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })
  );
  expect(response.status).toBe(303);
  const location = response.headers.get("location");
  expect(location).toBeTruthy();
  return new URL(location!).searchParams.get("code")!;
}

async function exchangeAuthorizationCode(code?: string): Promise<Response> {
  return handleToken(
    formRequest("/oauth/exchange", {
      grant_type: "authorization_code",
      code: code || (await issueAuthorizationCode()),
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    })
  );
}

async function issueTokens(): Promise<OAuthTokenBody> {
  const response = await exchangeAuthorizationCode();
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

beforeAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  process.env.DATABASE_URL = DATABASE_URL;
  await pushPrismaSchema();
});

beforeEach(async () => {
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.OAUTH_STORAGE_MODE = "prisma";
  process.env.VERIFY_DATA_DIR = TEST_ROOT;
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
  try {
    await (await prismaDb()).$disconnect();
  } catch {
    // The client may never have been created when setup fails early.
  }
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("OAuth Prisma state store", () => {
  test("persists authorization-code consumption and hashed refresh grants", async () => {
    const code = await issueAuthorizationCode();
    const first = await exchangeAuthorizationCode(code);
    expect(first.status).toBe(200);
    const body = (await first.json()) as OAuthTokenBody;
    expect(body.refresh_token).toBeTruthy();

    const replay = await exchangeAuthorizationCode(code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Authorization code has already been used",
    });

    const db = await prismaDb();
    expect(await db.oAuthAuthorizationCode.count()).toBe(1);
    expect(await db.oAuthRefreshGrant.count()).toBe(1);
    const stored = JSON.stringify(await db.oAuthRefreshGrant.findMany());
    expect(stored).not.toContain(body.refresh_token!);
    expect(stored).toContain("credentialHash");
  });

  test("rotates refresh credentials and revokes descendants on replay", async () => {
    const initial = await issueTokens();
    const rotatedResponse = await refresh(initial.refresh_token!);
    expect(rotatedResponse.status).toBe(200);
    const rotated = (await rotatedResponse.json()) as OAuthTokenBody;
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);

    const replay = await refresh(initial.refresh_token!);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    const descendant = await refresh(rotated.refresh_token!);
    expect(descendant.status).toBe(400);
    expect(await descendant.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Refresh grant revoked",
    });
  });

  test("handles simultaneous refresh attempts without issuing two valid descendants", async () => {
    const initial = await issueTokens();
    const responses = await Promise.all([
      refresh(initial.refresh_token!),
      refresh(initial.refresh_token!),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 400]);

    const success = responses.find((response) => response.status === 200)!;
    const failure = responses.find((response) => response.status === 400)!;
    const rotated = (await success.json()) as OAuthTokenBody;
    expect(rotated.refresh_token).toBeTruthy();
    expect(await failure.json()).toMatchObject({ error: "invalid_grant" });

    const descendant = await refresh(rotated.refresh_token!);
    expect(descendant.status).toBe(400);
    expect(await descendant.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Refresh grant revoked",
    });
  });

  test("explicit revocation invalidates the complete Prisma family", async () => {
    const initial = await issueTokens();
    const rotatedResponse = await refresh(initial.refresh_token!);
    const rotated = (await rotatedResponse.json()) as OAuthTokenBody;
    expect(rotated.refresh_token).toBeTruthy();

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
});
