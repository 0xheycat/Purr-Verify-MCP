import { describe, expect, test } from "bun:test";

import { TenantAccessError } from "../tenancy/authorization";
import { createHostedPrincipal, type HostedRequestPrincipal } from "../tenancy/request-principal";
import { resolveHostedJobTarget } from "./hosted-job-target";

interface RepositoryRecord {
  id: string;
  tenantId: string;
  installationId: string;
  fullName: string;
  defaultBranch: string;
  installation: {
    id: string;
    tenantId: string;
    suspendedAt: Date | null;
  };
}

function principal(
  tenantId: string,
  role: "viewer" | "member" | "admin" = "member",
): HostedRequestPrincipal {
  return createHostedPrincipal({
    userId: `user-${tenantId}`,
    memberships: [{ tenantId, role }],
    githubLogin: "octocat",
    clientId: "client-test",
  });
}

function repository(overrides: Partial<RepositoryRecord> = {}): RepositoryRecord {
  return {
    id: "repo-1",
    tenantId: "tenant-a",
    installationId: "installation-1",
    fullName: "0xheycat/Purr-Verify-MCP",
    defaultBranch: "main",
    installation: {
      id: "installation-1",
      tenantId: "tenant-a",
      suspendedAt: null,
    },
    ...overrides,
  };
}

function client(record: RepositoryRecord | null) {
  return {
    installedRepository: {
      async findUnique() {
        return record;
      },
    },
    async $disconnect() {},
  };
}

describe("resolveHostedJobTarget", () => {
  test("resolves an authorized installed repository", async () => {
    const target = await resolveHostedJobTarget(
      principal("tenant-a"),
      " 0xheycat/Purr-Verify-MCP ",
      client(repository()),
    );

    expect(target).toEqual({
      tenantId: "tenant-a",
      repositoryId: "repo-1",
      installationId: "installation-1",
      fullName: "0xheycat/Purr-Verify-MCP",
      defaultBranch: "main",
    });
  });

  test("hides an unknown repository", async () => {
    await expect(
      resolveHostedJobTarget(principal("tenant-a"), "0xheycat/missing", client(null)),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("rejects malformed repository names before lookup", async () => {
    let lookups = 0;
    const lookupClient = {
      installedRepository: {
        async findUnique() {
          lookups += 1;
          return repository();
        },
      },
      async $disconnect() {},
    };

    await expect(
      resolveHostedJobTarget(principal("tenant-a"), "not-a-repository", lookupClient),
    ).rejects.toBeInstanceOf(TenantAccessError);
    expect(lookups).toBe(0);
  });

  test("prevents cross-tenant repository access", async () => {
    await expect(
      resolveHostedJobTarget(principal("tenant-b"), repository().fullName, client(repository())),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("prevents viewers from creating jobs", async () => {
    await expect(
      resolveHostedJobTarget(
        principal("tenant-a", "viewer"),
        repository().fullName,
        client(repository()),
      ),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("rejects repository and installation tenant mismatches", async () => {
    const mismatched = repository({
      installation: {
        id: "installation-1",
        tenantId: "tenant-b",
        suspendedAt: null,
      },
    });

    await expect(
      resolveHostedJobTarget(principal("tenant-a"), mismatched.fullName, client(mismatched)),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("rejects installation id mismatches", async () => {
    const mismatched = repository({ installationId: "installation-other" });

    await expect(
      resolveHostedJobTarget(principal("tenant-a"), mismatched.fullName, client(mismatched)),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("rejects suspended installations", async () => {
    const suspended = repository({
      installation: {
        id: "installation-1",
        tenantId: "tenant-a",
        suspendedAt: new Date("2026-07-12T00:00:00Z"),
      },
    });

    await expect(
      resolveHostedJobTarget(principal("tenant-a"), suspended.fullName, client(suspended)),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });
});
