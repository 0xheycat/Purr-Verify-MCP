import { assertHostedConfiguration, isHostedMode } from "../runtime/deployment-mode";

export interface DisconnectableHostedPrismaClient {
  $disconnect(): Promise<void>;
}

export type HostedPrismaClientFactory<T extends DisconnectableHostedPrismaClient> = () => T;

const globalHostedPrisma = globalThis as typeof globalThis & {
  __purrVerifyHostedPrisma?: DisconnectableHostedPrismaClient;
};

async function loadGeneratedClient(): Promise<DisconnectableHostedPrismaClient> {
  const generatedClientPath = "../../../prisma/generated/hosted-client";
  const generated = await import(generatedClientPath) as {
    PrismaClient: new () => DisconnectableHostedPrismaClient;
  };
  return new generated.PrismaClient();
}

export async function getHostedPrismaClient<T extends DisconnectableHostedPrismaClient = DisconnectableHostedPrismaClient>(
  factory?: HostedPrismaClientFactory<T>,
): Promise<T> {
  if (!isHostedMode()) {
    throw new Error("Hosted Prisma client is unavailable in self-hosted mode.");
  }

  assertHostedConfiguration();

  if (!globalHostedPrisma.__purrVerifyHostedPrisma) {
    globalHostedPrisma.__purrVerifyHostedPrisma = factory
      ? factory()
      : await loadGeneratedClient();
  }

  return globalHostedPrisma.__purrVerifyHostedPrisma as T;
}

export async function disconnectHostedPrismaClient(): Promise<void> {
  const client = globalHostedPrisma.__purrVerifyHostedPrisma;
  if (!client) return;

  delete globalHostedPrisma.__purrVerifyHostedPrisma;
  await client.$disconnect();
}

export function resetHostedPrismaClientForTests(): void {
  delete globalHostedPrisma.__purrVerifyHostedPrisma;
}
