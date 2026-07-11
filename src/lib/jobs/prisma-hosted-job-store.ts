import type {
  CreateHostedJobInput,
  HostedJobStatus,
  HostedJobStore,
  HostedVerificationJob,
} from "./hosted-job-repository";

const DATABASE_STATUSES = {
  queued: "QUEUED",
  running: "RUNNING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  cancelled: "CANCELLED",
} as const;

type DatabaseJobStatus = (typeof DATABASE_STATUSES)[HostedJobStatus];

interface PrismaVerificationJobRecord {
  id: string;
  tenantId: string;
  ownerUserId: string;
  repositoryId: string;
  installationId: string;
  ref: string;
  status: DatabaseJobStatus;
  workflow: unknown;
  environmentName: string | null;
  createdByClientId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PrismaVerificationJobDelegate {
  create(args: { data: Record<string, unknown> }): Promise<PrismaVerificationJobRecord>;
  findUnique(args: { where: { id: string } }): Promise<PrismaVerificationJobRecord | null>;
  findMany(args: {
    where: { tenantId: { in: readonly string[] } };
    orderBy: { createdAt: "desc" };
  }): Promise<PrismaVerificationJobRecord[]>;
  update(args: {
    where: { id: string };
    data: { status: DatabaseJobStatus; finishedAt?: Date };
  }): Promise<PrismaVerificationJobRecord>;
  delete(args: { where: { id: string } }): Promise<PrismaVerificationJobRecord>;
}

export interface HostedPrismaClient {
  verificationJob: PrismaVerificationJobDelegate;
}

function fromDatabaseStatus(status: DatabaseJobStatus): HostedJobStatus {
  switch (status) {
    case "QUEUED": return "queued";
    case "RUNNING": return "running";
    case "SUCCEEDED": return "succeeded";
    case "FAILED": return "failed";
    case "CANCELLED": return "cancelled";
  }
}

function toHostedJob(record: PrismaVerificationJobRecord): HostedVerificationJob {
  return {
    ...record,
    status: fromDatabaseStatus(record.status),
  };
}

function isRecordNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2025";
}

export class PrismaHostedJobStore implements HostedJobStore {
  constructor(private readonly prisma: HostedPrismaClient) {}

  async insert(input: CreateHostedJobInput): Promise<HostedVerificationJob> {
    const record = await this.prisma.verificationJob.create({
      data: {
        ...input,
        workflow: input.workflow,
        status: DATABASE_STATUSES.queued,
      },
    });
    return toHostedJob(record);
  }

  async findById(id: string): Promise<HostedVerificationJob | null> {
    const record = await this.prisma.verificationJob.findUnique({ where: { id } });
    return record ? toHostedJob(record) : null;
  }

  async listByTenantIds(tenantIds: readonly string[]): Promise<HostedVerificationJob[]> {
    if (tenantIds.length === 0) return [];
    const records = await this.prisma.verificationJob.findMany({
      where: { tenantId: { in: tenantIds } },
      orderBy: { createdAt: "desc" },
    });
    return records.map(toHostedJob);
  }

  async updateStatus(id: string, status: HostedJobStatus): Promise<HostedVerificationJob | null> {
    try {
      const terminal = ["succeeded", "failed", "cancelled"].includes(status);
      const record = await this.prisma.verificationJob.update({
        where: { id },
        data: {
          status: DATABASE_STATUSES[status],
          ...(terminal ? { finishedAt: new Date() } : {}),
        },
      });
      return toHostedJob(record);
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  async deleteById(id: string): Promise<boolean> {
    try {
      await this.prisma.verificationJob.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      throw error;
    }
  }
}
