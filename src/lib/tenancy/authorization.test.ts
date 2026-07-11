import { describe, expect, test } from "bun:test";

import {
  TenantAccessError,
  assertCanMutateTenantResource,
  assertCanReadTenantResource,
  canMutateTenantResource,
  filterTenantResources,
  type TenantPrincipal,
} from "./authorization";

const principal: TenantPrincipal = {
  userId: "user-a",
  tenantIds: new Set(["tenant-a"]),
  rolesByTenant: new Map([["tenant-a", "member"]]),
};

describe("tenant authorization", () => {
  test("filters resources outside the principal tenant set", () => {
    const resources = [
      { id: "job-a", tenantId: "tenant-a", ownerUserId: "user-a" },
      { id: "job-b", tenantId: "tenant-b", ownerUserId: "user-b" },
    ];

    expect(filterTenantResources(principal, resources)).toEqual([resources[0]]);
  });

  test("returns the same not-found style error for cross-tenant reads", () => {
    expect(() =>
      assertCanReadTenantResource(principal, {
        tenantId: "tenant-b",
        ownerUserId: "user-b",
      }),
    ).toThrow(TenantAccessError);
  });

  test("allows a member to mutate their own resource", () => {
    expect(
      canMutateTenantResource(principal, {
        tenantId: "tenant-a",
        ownerUserId: "user-a",
      }),
    ).toBe(true);
  });

  test("denies a member mutating another user's resource", () => {
    expect(() =>
      assertCanMutateTenantResource(principal, {
        tenantId: "tenant-a",
        ownerUserId: "user-c",
      }),
    ).toThrow(TenantAccessError);
  });

  test("allows tenant admins to mutate tenant-owned resources", () => {
    const admin: TenantPrincipal = {
      userId: "admin-a",
      tenantIds: new Set(["tenant-a"]),
      rolesByTenant: new Map([["tenant-a", "admin"]]),
    };

    expect(
      canMutateTenantResource(admin, {
        tenantId: "tenant-a",
        ownerUserId: "user-c",
      }),
    ).toBe(true);
  });
});
