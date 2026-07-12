import { afterEach, describe, expect, test } from "bun:test";
import { resetHostedPrismaClientForTests } from "../database/hosted-prisma-client";
import { HostedJobRepository } from "./hosted-job-repository";
import { resolveDeploymentJobRepository } from "./job-repository-factory";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetHostedPrismaClientForTests();
});

describe("resolveDeploymentJobRepository", () => {
  test("preserves the legacy self-hosted repository as the default", async () => {
    delete process.env.DEPLOYMENT_MODE;
    const legacy = { kind: "legacy" as const };

    const resolved = await resolveDeploymentJobRepository({
      selfHosted: () => legacy,
    });

    expect(resolved).toEqual({ mode: "self_hosted", repository: legacy });
  });

  test("selects the hosted repository only in hosted mode", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/purr_verify";
    process.env.SESSION_SECRET = "test-session-secret";

    const hosted = new HostedJobRepository({
      insert: async () => { throw new Error("not used"); },
      findById: async () => null,
      listByTenantIds: async () => [],
      updateStatus: async () => null,
      deleteById: async () => false,
    });

    const resolved = await resolveDeploymentJobRepository({
      selfHosted: () => ({ kind: "legacy" as const }),
      hosted: async () => hosted,
    });

    expect(resolved.mode).toBe("hosted");
    expect(resolved.repository).toBe(hosted);
  });
});
