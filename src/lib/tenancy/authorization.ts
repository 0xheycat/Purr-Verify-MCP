export type TenantRole = "owner" | "admin" | "member" | "viewer";

export interface TenantPrincipal {
  userId: string;
  tenantIds: ReadonlySet<string>;
  rolesByTenant?: ReadonlyMap<string, TenantRole>;
}

export interface TenantOwnedResource {
  tenantId: string;
  ownerUserId?: string | null;
}

export class TenantAccessError extends Error {
  readonly code = "TENANT_ACCESS_DENIED";

  constructor() {
    super("Resource not found or access denied.");
    this.name = "TenantAccessError";
  }
}

export function canAccessTenant(
  principal: TenantPrincipal,
  tenantId: string,
): boolean {
  return principal.tenantIds.has(tenantId);
}

export function canReadTenantResource(
  principal: TenantPrincipal,
  resource: TenantOwnedResource,
): boolean {
  return canAccessTenant(principal, resource.tenantId);
}

export function canCreateTenantResource(
  principal: TenantPrincipal,
  tenantId: string,
): boolean {
  if (!canAccessTenant(principal, tenantId)) {
    return false;
  }

  const role = principal.rolesByTenant?.get(tenantId);
  return role !== "viewer";
}

export function canMutateTenantResource(
  principal: TenantPrincipal,
  resource: TenantOwnedResource,
): boolean {
  if (!canAccessTenant(principal, resource.tenantId)) {
    return false;
  }

  if (resource.ownerUserId === principal.userId) {
    return true;
  }

  const role = principal.rolesByTenant?.get(resource.tenantId);
  return role === "owner" || role === "admin";
}

export function assertCanReadTenantResource(
  principal: TenantPrincipal,
  resource: TenantOwnedResource,
): void {
  if (!canReadTenantResource(principal, resource)) {
    throw new TenantAccessError();
  }
}

export function assertCanCreateTenantResource(
  principal: TenantPrincipal,
  tenantId: string,
): void {
  if (!canCreateTenantResource(principal, tenantId)) {
    throw new TenantAccessError();
  }
}

export function assertCanMutateTenantResource(
  principal: TenantPrincipal,
  resource: TenantOwnedResource,
): void {
  if (!canMutateTenantResource(principal, resource)) {
    throw new TenantAccessError();
  }
}

export function filterTenantResources<T extends TenantOwnedResource>(
  principal: TenantPrincipal,
  resources: readonly T[],
): T[] {
  return resources.filter((resource) => canReadTenantResource(principal, resource));
}
