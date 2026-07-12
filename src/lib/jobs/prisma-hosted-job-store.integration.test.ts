import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { PrismaClient } from "../../../prisma/generated/hosted-client";
import { PrismaHostedJobStore } from "./prisma-hosted-job-store";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for prisma-hosted-job-store.integration.test.ts",
  );
}

const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const tenantAId = `tenant-a-${suffix}`;
const tenantBId = `tenant-b-${suffix}`;
const userAId = `user-a-${suffix}`;
const userBId = `user-b-${suffix}`;
const installationAId = `installation-a-${suffix}`;
const installationBId = `installation-b-${suffix}`;
const repositoryAId = `repository-a-${suffix}`;
const repositoryBId = `repository-b-${suffix}`;

async function seedTenant(input: {
  tenantId: string;
  userId: string;
  installationId: string;
  repositoryId: string;
  ordinal: bigint;
}) {
  await prisma.user.create({
    data: {
      id: input.userId,
      githubUserId: input.ordinal,
      githubLogin: `verify-user-${input.ordinal}-${suffix}`,
    },
  });
  await prisma.tenant.create({
    data: {
      id: input.tenantId,
      type: "PERSONAL",
      slug: `verify-tenant-${input.ordinal}-${suffix}`,
      displayName: `Verify tenant ${input.ordinal}`,
      memberships: {
        create: { userId: input.userId, role: "OWNER" },
      },
    },
  });
  await prisma.gitHubInstallation.create({
    data: {
      id: input.installationId,
      githubInstallationId: input.ordinal,
      githubAccountId: input.ordinal,
      githubAccountLogin: `verify-account-${input.ordinal}-${suffix}`,
      tenantId: input.tenantId,
    },
  });
  await prisma.installedRepository.create({
    data: {
      id: input.repositoryId,
      githubRepositoryId: input.ordinal,
      ownerLogin: `verify-owner-${input.ordinal}`,
      name: `verify-repo-${input.ordinal}`,
      fullName: `verify-owner-${input.ordinal}/verify-repo-${suffix}`,
      defaultBranch: "main",
      private: true,
      tenantId: input.tenantId,
      installationId: input.installationId,
    },
  });
}

async function cleanup() {
  await prisma.verificationJob.deleteMany({
    where: { tenantId: { in: [tenantAId, tenantBId] } },
  });
  await prisma.installedRepository.deleteMany({
    where: { id: { in: [repositoryAId, repositoryBId] } },
  });
  await prisma.gitHubInstallation.deleteMany({
    where: { id: { in: [installationAId, installationBId] } },
  });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: { in: [tenantAId, tenantBId] } },
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [userAId, userBId] } },
  });
}

describe("PrismaHostedJobStore PostgreSQL integration", () => {
  beforeAll(async () => {
    await cleanup();
    await seedTenant({
      tenantId: tenantAId,
      userId: userAId,
      installationId: installationAId,
      repositoryId: repositoryAId,
      ordinal: BigInt(Date.now()),
    });
    await seedTenant({
      tenantId: tenantBId,
      userId: userBId,
      installationId: installationBId,
      repositoryId: repositoryBId,
      ordinal: BigInt(Date.now() + 1),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test("persists jobs and enforces tenant-scoped listing", async () => {
    const store = new PrismaHostedJobStore(prisma);
    const jobA = await store.insert({
      tenantId: tenantAId,
      ownerUserId: userAId,
      repositoryId: repositoryAId,
      installationId: installationAId,
      ref: "main",
      workflow: { steps: [{ run: "bun test" }] },
    });
    await store.insert({
      tenantId: tenantBId,
      ownerUserId: userBId,
      repositoryId: repositoryBId,
      installationId: installationBId,
      ref: "main",
      workflow: { steps: [{ run: "bun run build" }] },
    });

    expect((await store.findById(jobA.id))?.tenantId).toBe(tenantAId);
    expect((await store.listByTenantIds([tenantAId])).map((job) => job.tenantId)).toEqual([
      tenantAId,
    ]);
    expect((await store.listByTenantIds([tenantBId])).map((job) => job.tenantId)).toEqual([
      tenantBId,
    ]);

    expect((await store.updateStatus(jobA.id, "running"))?.status).toBe("running");
    expect((await store.updateStatus(jobA.id, "succeeded"))?.status).toBe("succeeded");
    expect(await store.deleteById(jobA.id)).toBe(true);
    expect(await store.findById(jobA.id)).toBeNull();
  });
});
