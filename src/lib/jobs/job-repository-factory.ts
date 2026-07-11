import { isHostedMode } from "../runtime/deployment-mode";
import { getHostedPrismaClient, type DisconnectableHostedPrismaClient } from "../database/hosted-prisma-client";
import { HostedJobRepository } from "./hosted-job-repository";
import { PrismaHostedJobStore, type HostedPrismaClient } from "./prisma-hosted-job-store";

export type HostedJobRepositoryFactory = () => Promise<HostedJobRepository>;

export async function createHostedJobRepository(
  client?: HostedPrismaClient & DisconnectableHostedPrismaClient,
): Promise<HostedJobRepository> {
  if (!isHostedMode()) {
    throw new Error("Hosted job repository is unavailable in self-hosted mode.");
  }

  const prisma = client ?? await getHostedPrismaClient<HostedPrismaClient & DisconnectableHostedPrismaClient>();
  return new HostedJobRepository(new PrismaHostedJobStore(prisma));
}

export interface DeploymentJobRepositories<TSelfHosted> {
  mode: "self_hosted";
  repository: TSelfHosted;
}

export interface HostedDeploymentJobRepositories {
  mode: "hosted";
  repository: HostedJobRepository;
}

export async function resolveDeploymentJobRepository<TSelfHosted>(options: {
  selfHosted: () => TSelfHosted;
  hosted?: HostedJobRepositoryFactory;
}): Promise<DeploymentJobRepositories<TSelfHosted> | HostedDeploymentJobRepositories> {
  if (!isHostedMode()) {
    return { mode: "self_hosted", repository: options.selfHosted() };
  }

  return {
    mode: "hosted",
    repository: await (options.hosted ?? createHostedJobRepository)(),
  };
}
