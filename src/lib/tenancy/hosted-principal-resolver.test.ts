import { afterEach, describe, expect, test } from "bun:test";

import {
  InvalidHostedCredentialError,
  resolveHostedRequestPrincipal,
  type HostedCredentialResolvers,
  type HostedIdentityRecord,
} from "./hosted-principal-resolver";
import { PrincipalContextError } from "./request-principal";

const originalDeploymentMode = process.env.DEPLOYMENT_MODE;

function identity(userId: string, clientId?: string): HostedIdentityRecord {
  return {
    userId,
    githubLogin: userId,
    clientId,
    memberships: [{ tenantId: `tenant-${userId}`, role: "member" }],
  };
}

function resolvers(input: {
  sessions?: Record<string, HostedIdentityRecord>;
  bearers?: Record<string, HostedIdentityRecord>;
} = {}): HostedCredentialResolvers {
  return {
    async resolveSession(token) {
      return input.sessions?.[token] ?? null;
    },
    async resolveBearer(token) {
      return input.bearers?.[token] ?? null;
    },
  };
}

afterEach(() => {
  if (originalDeploymentMode === undefined) {
    delete process.env.DEPLOYMENT_MODE;
  } else {
    process.env.DEPLOYMENT_MODE = originalDeploymentMode;
  }
});

describe("resolveHostedRequestPrincipal", () => {
  test("does not intercept legacy self-hosted authentication", async () => {
    process.env.DEPLOYMENT_MODE = "self_hosted";

    const principal = await resolveHostedRequestPrincipal(
      { sessionToken: "legacy-token" },
      resolvers(),
    );

    expect(principal).toBeNull();
  });

  test("requires a credential in hosted mode", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";

    await expect(resolveHostedRequestPrincipal({}, resolvers())).rejects.toBeInstanceOf(
      PrincipalContextError,
    );
  });

  test("resolves a browser session into tenant memberships", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";

    const principal = await resolveHostedRequestPrincipal(
      { sessionToken: "session-a" },
      resolvers({ sessions: { "session-a": identity("user-a") } }),
    );

    expect(principal?.userId).toBe("user-a");
    expect(principal?.tenantIds.has("tenant-user-a")).toBe(true);
  });

  test("resolves an MCP OAuth bearer and preserves client id", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";

    const principal = await resolveHostedRequestPrincipal(
      { authorization: "Bearer oauth-a" },
      resolvers({ bearers: { "oauth-a": identity("user-a", "mcp-client-a") } }),
    );

    expect(principal?.clientId).toBe("mcp-client-a");
  });

  test("rejects malformed authorization instead of falling back", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";

    await expect(
      resolveHostedRequestPrincipal(
        { authorization: "Basic abc" },
        resolvers(),
      ),
    ).rejects.toBeInstanceOf(InvalidHostedCredentialError);
  });

  test("rejects expired session and bearer credentials", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";

    await expect(
      resolveHostedRequestPrincipal({ sessionToken: "expired" }, resolvers()),
    ).rejects.toBeInstanceOf(InvalidHostedCredentialError);

    await expect(
      resolveHostedRequestPrincipal({ authorization: "Bearer expired" }, resolvers()),
    ).rejects.toBeInstanceOf(InvalidHostedCredentialError);
  });

  test("rejects mixed credentials belonging to different users", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";

    await expect(
      resolveHostedRequestPrincipal(
        { sessionToken: "session-a", authorization: "Bearer oauth-b" },
        resolvers({
          sessions: { "session-a": identity("user-a") },
          bearers: { "oauth-b": identity("user-b", "mcp-client-b") },
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidHostedCredentialError);
  });

  test("allows matching session and bearer credentials", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";

    const principal = await resolveHostedRequestPrincipal(
      { sessionToken: "session-a", authorization: "Bearer oauth-a" },
      resolvers({
        sessions: { "session-a": identity("user-a") },
        bearers: { "oauth-a": identity("user-a", "mcp-client-a") },
      }),
    );

    expect(principal?.userId).toBe("user-a");
  });
});
