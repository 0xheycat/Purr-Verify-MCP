import { describe, expect, test } from "bun:test";

import { TenantAccessError, type TenantPrincipal } from "../tenancy/authorization";
import {
  HostedJobRepository,
  type CreateHostedJobInput,
  type HostedJobStatus,
  type HostedJobStore,
  type HostedVerificationJob,
} from "./hosted-job-repository";

class MemoryHostedJobStore implements HostedJobStore {
  private readonly jobs = new Map<string, HostedVerificationJob>();
  private sequence = 0;

  async insert(input: CreateHostedJobInput): Promise<HostedVerificationJob> {
    const now = new Date();
    const job: HostedVerificationJob = {
      ...input,
      id: `job-${++this.sequence}`,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async findById(id: string): Promise<HostedVerificationJob | null> {
    return this.jobs.get(id) ?? null;
  }

  async listByTenantIds(tenantIds: readonly string[]): Promise<HostedVerificationJob[]> {
    const allowed = new Set(tenantIds);
    return [...this.jobs.values()].filter((job) => allowed.has(job.tenantId));
  }

  async updateStatus(id: string, status: HostedJobStatus): Promise<HostedVerificationJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const updated = { ...job, status, updatedAt: new Date() };
    this.jobs.set(id, updated);
    return updated;
  }

  async deleteById(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }
}

function principal(
  userId: string,
  tenantId: string,
  role: "viewer" | "member" | "admin" = "member",
): TenantPrincipal {
  return {
    userId,
    tenantIds: new Set([tenantId]),
    rolesByTenant: new Map([[tenantId, role]]),
  };
}

const input = (tenantId: string) => ({
  tenantId,
  repositoryId: `repo-${tenantId}`,
  installationId: `installation-${tenantId}`,
  ref: "main",
  workflow: { steps: [{ run: "bun test" }] },
});

describe("HostedJobRepository", () => {
  test("lists only jobs from principal tenants", async () => {
    const repository = new HostedJobRepository(new MemoryHostedJobStore());
    const userA = principal("user-a", "tenant-a");
    const userB = principal("user-b", "tenant-b");

    await repository.create(userA, input("tenant-a"));
    await repository.create(userB, input("tenant-b"));

    const jobs = await repository.list(userA);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.tenantId).toBe("tenant-a");
  });

  test("returns a non-enumerating error for cross-tenant job ids", async () => {
    const repository = new HostedJobRepository(new MemoryHostedJobStore());
    const job = await repository.create(principal("user-a", "tenant-a"), input("tenant-a"));

    await expect(repository.get(principal("user-b", "tenant-b"), job.id)).rejects.toBeInstanceOf(
      TenantAccessError,
    );
  });

  test("prevents tenant viewers from creating jobs", async () => {
    const repository = new HostedJobRepository(new MemoryHostedJobStore());

    await expect(
      repository.create(principal("viewer-a", "tenant-a", "viewer"), input("tenant-a")),
    ).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("prevents members mutating another user's job", async () => {
    const repository = new HostedJobRepository(new MemoryHostedJobStore());
    const owner = principal("user-a", "tenant-a");
    const peer = principal("user-b", "tenant-a");
    const job = await repository.create(owner, input("tenant-a"));

    await expect(repository.cancel(peer, job.id)).rejects.toBeInstanceOf(TenantAccessError);
    await expect(repository.delete(peer, job.id)).rejects.toBeInstanceOf(TenantAccessError);
  });

  test("allows tenant admins to cancel another user's job", async () => {
    const repository = new HostedJobRepository(new MemoryHostedJobStore());
    const job = await repository.create(principal("user-a", "tenant-a"), input("tenant-a"));

    const cancelled = await repository.cancel(principal("admin-a", "tenant-a", "admin"), job.id);
    expect(cancelled.status).toBe("cancelled");
  });
});
