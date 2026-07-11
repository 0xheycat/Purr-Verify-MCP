import {
  TenantAccessError,
  assertCanMutateTenantResource,
  assertCanReadTenantResource,
  type TenantPrincipal,
} from "../tenancy/authorization";

export type HostedJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface HostedVerificationJob {
  id: string;
  tenantId: string;
  ownerUserId: string;
  repositoryId: string;
  installationId: string;
  ref: string;
  status: HostedJobStatus;
  workflow: unknown;
  environmentName?: string | null;
  createdByClientId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateHostedJobInput {
  tenantId: string;
  ownerUserId: string;
  repositoryId: string;
  installationId: string;
  ref: string;
  workflow: unknown;
  environmentName?: string | null;
  createdByClientId?: string | null;
}

export interface HostedJobStore {
  insert(input: CreateHostedJobInput): Promise<HostedVerificationJob>;
  findById(id: string): Promise<HostedVerificationJob | null>;
  listByTenantIds(tenantIds: readonly string[]): Promise<HostedVerificationJob[]>;
  updateStatus(id: string, status: HostedJobStatus): Promise<HostedVerificationJob | null>;
  deleteById(id: string): Promise<boolean>;
}

export class HostedJobRepository {
  constructor(private readonly store: HostedJobStore) {}

  async create(
    principal: TenantPrincipal,
    input: Omit<CreateHostedJobInput, "ownerUserId">,
  ): Promise<HostedVerificationJob> {
    if (!principal.tenantIds.has(input.tenantId)) {
      throw new TenantAccessError();
    }

    return this.store.insert({ ...input, ownerUserId: principal.userId });
  }

  async get(
    principal: TenantPrincipal,
    jobId: string,
  ): Promise<HostedVerificationJob> {
    const job = await this.store.findById(jobId);
    if (!job) throw new TenantAccessError();
    assertCanReadTenantResource(principal, job);
    return job;
  }

  async list(principal: TenantPrincipal): Promise<HostedVerificationJob[]> {
    return this.store.listByTenantIds([...principal.tenantIds]);
  }

  async cancel(
    principal: TenantPrincipal,
    jobId: string,
  ): Promise<HostedVerificationJob> {
    const job = await this.get(principal, jobId);
    assertCanMutateTenantResource(principal, job);

    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      return job;
    }

    const updated = await this.store.updateStatus(job.id, "cancelled");
    if (!updated) throw new TenantAccessError();
    return updated;
  }

  async delete(principal: TenantPrincipal, jobId: string): Promise<void> {
    const job = await this.get(principal, jobId);
    assertCanMutateTenantResource(principal, job);

    const deleted = await this.store.deleteById(job.id);
    if (!deleted) throw new TenantAccessError();
  }
}
