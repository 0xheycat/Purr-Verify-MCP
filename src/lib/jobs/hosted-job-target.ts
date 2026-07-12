import { getHostedPrismaClient } from "../database/hosted-prisma-client";
import { TenantAccessError, assertCanCreateTenantResource } from "../tenancy/authorization";
import type { HostedRequestPrincipal } from "../tenancy/request-principal";

interface InstalledRepositoryRecord {
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

interface InstalledRepositoryDelegate {
  findUnique(args: {
    where: { fullName: string };
    include: { installation: true };
  }): Promise<InstalledRepositoryRecord | null>;
}

interface HostedJobTargetPrismaClient {
  installedRepository: InstalledRepositoryDelegate;
  $disconnect(): Promise<void>;
}

export interface HostedJobTarget {
  tenantId: string;
  repositoryId: string;
  installationId: string;
  fullName: string;
  defaultBranch: string;
}

export async function resolveHostedJobTarget(
  principal: HostedRequestPrincipal,
  repositoryFullName: string,
  client?: HostedJobTargetPrismaClient,
): Promise<HostedJobTarget> {
  const fullName = repositoryFullName.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    throw new TenantAccessError();
  }

  const prisma = client ?? await getHostedPrismaClient<HostedJobTargetPrismaClient>();
  const repository = await prisma.installedRepository.findUnique({
    where: { fullName },
    include: { installation: true },
  });

  if (
    !repository ||
    repository.tenantId !== repository.installation.tenantId ||
    repository.installationId !== repository.installation.id ||
    repository.installation.suspendedAt
  ) {
    throw new TenantAccessError();
  }

  assertCanCreateTenantResource(principal, repository.tenantId);

  return {
    tenantId: repository.tenantId,
    repositoryId: repository.id,
    installationId: repository.installationId,
    fullName: repository.fullName,
    defaultBranch: repository.defaultBranch,
  };
}
