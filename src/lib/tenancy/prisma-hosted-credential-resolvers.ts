import { createHash } from "node:crypto";

import type {
  HostedCredentialResolvers,
  HostedIdentityRecord,
} from "./hosted-principal-resolver";
import type { PrincipalMembership } from "./request-principal";
import type { TenantRole } from "./authorization";

interface MembershipRow {
  tenantId: string;
  role: string;
}

interface UserRow {
  id: string;
  githubLogin: string;
  memberships: MembershipRow[];
}

interface SessionRow {
  expiresAt: Date;
  revokedAt: Date | null;
  user: UserRow;
}

interface AccessTokenRow {
  expiresAt: Date;
  revokedAt: Date | null;
  audience: string;
  scopes: string[];
  clientId: string;
  user: UserRow;
}

export interface HostedCredentialPrismaClient {
  userSession: {
    findUnique(args: unknown): Promise<SessionRow | null>;
  };
  oauthAccessToken: {
    findUnique(args: unknown): Promise<AccessTokenRow | null>;
  };
}

export interface PrismaHostedCredentialResolverOptions {
  audience: string;
  requiredBearerScopes?: readonly string[];
  now?: () => Date;
}

function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mapRole(role: string): TenantRole {
  switch (role) {
    case "OWNER":
      return "owner";
    case "ADMIN":
      return "admin";
    case "MEMBER":
      return "member";
    case "VIEWER":
      return "viewer";
    default:
      throw new Error(`Unsupported hosted tenant role: ${role}`);
  }
}

function mapMemberships(rows: MembershipRow[]): PrincipalMembership[] {
  return rows.map((membership) => ({
    tenantId: membership.tenantId,
    role: mapRole(membership.role),
  }));
}

function isActive(expiresAt: Date, revokedAt: Date | null, now: Date): boolean {
  return revokedAt === null && expiresAt.getTime() > now.getTime();
}

function hasRequiredScopes(actual: readonly string[], required: readonly string[]): boolean {
  const granted = new Set(actual);
  return required.every((scope) => granted.has(scope));
}

function toIdentity(user: UserRow, clientId?: string): HostedIdentityRecord {
  return {
    userId: user.id,
    githubLogin: user.githubLogin,
    memberships: mapMemberships(user.memberships),
    clientId,
  };
}

/**
 * Creates database-backed credential resolvers for the shared hosted HTTP/MCP
 * principal boundary. Only SHA-256 token digests are queried; raw session and
 * OAuth bearer values are never persisted or returned by this adapter.
 */
export function createPrismaHostedCredentialResolvers(
  prisma: HostedCredentialPrismaClient,
  options: PrismaHostedCredentialResolverOptions,
): HostedCredentialResolvers {
  const audience = options.audience.trim();
  if (!audience) throw new Error("Hosted OAuth audience is required.");

  const requiredScopes = [...(options.requiredBearerScopes ?? [])];
  const now = options.now ?? (() => new Date());

  return {
    async resolveSession(sessionToken): Promise<HostedIdentityRecord | null> {
      const session = await prisma.userSession.findUnique({
        where: { tokenHash: hashOpaqueToken(sessionToken) },
        include: {
          user: {
            include: { memberships: true },
          },
        },
      });

      if (!session || !isActive(session.expiresAt, session.revokedAt, now())) {
        return null;
      }

      return toIdentity(session.user);
    },

    async resolveBearer(accessToken): Promise<HostedIdentityRecord | null> {
      const token = await prisma.oauthAccessToken.findUnique({
        where: { tokenHash: hashOpaqueToken(accessToken) },
        include: {
          user: {
            include: { memberships: true },
          },
        },
      });

      if (!token || !isActive(token.expiresAt, token.revokedAt, now())) {
        return null;
      }
      if (token.audience !== audience) return null;
      if (!hasRequiredScopes(token.scopes, requiredScopes)) return null;

      return toIdentity(token.user, token.clientId);
    },
  };
}
