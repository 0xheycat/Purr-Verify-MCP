import { describe, expect, test } from "bun:test";

import type { HostedJobStatus } from "./hosted-job-repository";
import {
  PrismaHostedJobStore,
  type HostedPrismaClient,
} from "./prisma-hosted-job-store";

type RecordShape = Awaited<ReturnType<HostedPrismaClient["verificationJob"]["create"]>>;

function createFakeClient() {
  const rows = new Map<string, RecordShape>();
  let sequence = 0;

  const client: HostedPrismaClient = {
    verificationJob: {
      async create({ data }) {
        const now = new Date();
        const row = {
          id: `job-${++sequence}`,
          tenantId: String(data.tenantId),
          ownerUserId: String(data.ownerUserId),
          repositoryId: String(data.repositoryId),
          installationId: String(data.installationId),
          ref: String(data.ref),
          status: data.status as RecordShape["status"],
          workflow: data.workflow,
          environmentName: (data.environmentName as string | null | undefined) ?? null,
          createdByClientId: (data.createdByClientId as string | null | undefined) ?? null,
          createdAt: now,
          updatedAt: now,
        };
        rows.set(row.id, row);
        return row;
      },
      async findUnique({ where }) {
        return rows.get(where.id) ?? null;
      },
      async findMany({ where }) {
        const allowed = new Set(where.tenantId.in);
        return [...rows.values()]
          .filter((row) => allowed.has(row.tenantId))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async update({ where, data }) {
        const row = rows.get(where.id);
        if (!row) throw Object.assign(new Error("missing"), { code: "P2025" });
        const updated = { ...row, status: data.status, updatedAt: new Date() };
        rows.set(where.id, updated);
        return updated;
      },
      async delete({ where }) {
        const row = rows.get(where.id);
        if (!row) throw Object.assign(new Error("missing"), { code: "P2025" });
        rows.delete(where.id);
        return row;
      },
    },
  };

  return { client, rows };
}

const input = (tenantId = "tenant-a") => ({
  tenantId,
  ownerUserId: "user-a",
  repositoryId: "repo-a",
  installationId: "installation-a",
  ref: "main",
  workflow: { steps: [{ run: "bun test" }] },
});

describe("PrismaHostedJobStore", () => {
  test("maps database statuses and scopes list queries by tenant", async () => {
    const { client } = createFakeClient();
    const store = new PrismaHostedJobStore(client);

    const first = await store.insert(input("tenant-a"));
    await store.insert(input("tenant-b"));
    expect(first.status).toBe("queued");

    const listed = await store.listByTenantIds(["tenant-a"]);
    expect(listed.map((job) => job.tenantId)).toEqual(["tenant-a"]);
  });

  test("returns null or false for Prisma record-not-found errors", async () => {
    const { client } = createFakeClient();
    const store = new PrismaHostedJobStore(client);

    expect(await store.updateStatus("missing", "cancelled")).toBeNull();
    expect(await store.deleteById("missing")).toBe(false);
  });

  test("persists every supported hosted status", async () => {
    const { client, rows } = createFakeClient();
    const store = new PrismaHostedJobStore(client);
    const job = await store.insert(input());

    for (const status of ["running", "succeeded", "failed", "cancelled"] satisfies HostedJobStatus[]) {
      const updated = await store.updateStatus(job.id, status);
      expect(updated?.status).toBe(status);
    }

    expect(rows.get(job.id)?.status).toBe("CANCELLED");
  });
});
