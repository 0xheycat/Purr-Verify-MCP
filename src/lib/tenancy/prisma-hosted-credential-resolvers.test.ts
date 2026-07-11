import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  createPrismaHostedCredentialResolvers,
  type HostedCredentialPrismaClient,
} from "./prisma-hosted-credential-resolvers";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function client(input: {
  session?: unknown;
  accessToken?: unknown;
  onSessionQuery?: (args: unknown) => void;
  onAccessTokenQuery?: (args: unknown) => void;
}): HostedCredentialPrismaClient {
  return {
    userSession: {
      async findUnique(args) {
        input.onSessionQuery?.(args);
        return (input.session ?? null) as never;
      },
    },
    oauthAccessToken: {
      async findUnique(args) {
        input.onAccessTokenQuery?.(args);
        return (input.accessToken ?? null) as never;
      },
    },
  };
}

const user = {
  id: "user-a",
  githubLogin: "octocat",
  memberships: [
    { tenantId: "tenant-a", role: "OWNER" },
    { tenantId: "tenant-b", role: "VIEWER" },
  ],
};

const activeUntil = new Date("2030-01-01T00:00:00.000Z");
const fixedNow = () => new Date("2029-01-01T00:00:00.000Z");

describe("createPrismaHostedCredentialResolvers", () => {
  test("queries sessions by digest and maps memberships", async () => {
    let query: unknown;
    const resolvers = createPrismaHostedCredentialResolvers(
      client({
        session: { expiresAt: activeUntil, revokedAt: null, user },
        onSessionQuery: (args) => {
          query = args;
        },
      }),
      { audience: "https://verify.example/mcp", now: fixedNow },
    );

    const identity = await resolvers.resolveSession("raw-session-secret");

    expect(query).toEqual({
      where: { tokenHash: digest("raw-session-secret") },
      include: { user: { include: { memberships: true } } },
    });
    expect(identity).toEqual({
      userId: "user-a",
      githubLogin: "octocat",
      memberships: [
        { tenantId: "tenant-a", role: "owner" },
        { tenantId: "tenant-b", role: "viewer" },
      ],
      clientId: undefined,
    });
  });

  test("rejects expired and revoked sessions", async () => {
    const expired = createPrismaHostedCredentialResolvers(
      client({
        session: {
          expiresAt: new Date("2028-01-01T00:00:00.000Z"),
          revokedAt: null,
          user,
        },
      }),
      { audience: "https://verify.example/mcp", now: fixedNow },
    );
    const revoked = createPrismaHostedCredentialResolvers(
      client({
        session: { expiresAt: activeUntil, revokedAt: fixedNow(), user },
      }),
      { audience: "https://verify.example/mcp", now: fixedNow },
    );

    expect(await expired.resolveSession("expired")).toBeNull();
    expect(await revoked.resolveSession("revoked")).toBeNull();
  });

  test("enforces bearer audience and required scopes", async () => {
    const token = {
      expiresAt: activeUntil,
      revokedAt: null,
      audience: "https://verify.example/mcp",
      scopes: ["verify:read", "verify:run"],
      clientId: "chatgpt-client",
      user,
    };
    const resolvers = createPrismaHostedCredentialResolvers(client({ accessToken: token }), {
      audience: "https://verify.example/mcp",
      requiredBearerScopes: ["verify:read"],
      now: fixedNow,
    });

    const identity = await resolvers.resolveBearer("raw-access-token");

    expect(identity?.clientId).toBe("chatgpt-client");
    expect(identity?.userId).toBe("user-a");
  });

  test("rejects wrong audience, insufficient scopes, expiry, and revocation", async () => {
    const base = {
      expiresAt: activeUntil,
      revokedAt: null,
      audience: "https://verify.example/mcp",
      scopes: ["verify:read"],
      clientId: "client-a",
      user,
    };

    const resolve = async (accessToken: unknown) =>
      createPrismaHostedCredentialResolvers(client({ accessToken }), {
        audience: "https://verify.example/mcp",
        requiredBearerScopes: ["verify:run"],
        now: fixedNow,
      }).resolveBearer("token");

    expect(await resolve({ ...base, audience: "https://other.example/mcp" })).toBeNull();
    expect(await resolve(base)).toBeNull();
    expect(
      await resolve({ ...base, scopes: ["verify:run"], expiresAt: new Date("2028-01-01") }),
    ).toBeNull();
    expect(await resolve({ ...base, scopes: ["verify:run"], revokedAt: fixedNow() })).toBeNull();
  });

  test("requires a non-empty configured audience", () => {
    expect(() =>
      createPrismaHostedCredentialResolvers(client({}), { audience: "   " }),
    ).toThrow("Hosted OAuth audience is required.");
  });
});
