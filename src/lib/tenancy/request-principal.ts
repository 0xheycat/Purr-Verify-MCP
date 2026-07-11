import type { TenantPrincipal, TenantRole } from "./authorization";

export interface PrincipalMembership {
  tenantId: string;
  role: TenantRole;
}

export interface HostedRequestPrincipal extends TenantPrincipal {
  githubLogin?: string;
  clientId?: string;
}

export class PrincipalContextError extends Error {
  readonly code = "UNAUTHENTICATED";

  constructor(message = "Authenticated principal is required.") {
    super(message);
    this.name = "PrincipalContextError";
  }
}

export function createHostedPrincipal(input: {
  userId: string;
  memberships: readonly PrincipalMembership[];
  githubLogin?: string;
  clientId?: string;
}): HostedRequestPrincipal {
  const userId = input.userId.trim();
  if (!userId) {
    throw new PrincipalContextError();
  }

  const tenantIds = new Set<string>();
  const rolesByTenant = new Map<string, TenantRole>();

  for (const membership of input.memberships) {
    const tenantId = membership.tenantId.trim();
    if (!tenantId) continue;
    tenantIds.add(tenantId);
    rolesByTenant.set(tenantId, membership.role);
  }

  return {
    userId,
    tenantIds,
    rolesByTenant,
    githubLogin: input.githubLogin?.trim() || undefined,
    clientId: input.clientId?.trim() || undefined,
  };
}

export function requireHostedPrincipal(
  principal: HostedRequestPrincipal | null | undefined,
): HostedRequestPrincipal {
  if (!principal?.userId) {
    throw new PrincipalContextError();
  }
  return principal;
}
