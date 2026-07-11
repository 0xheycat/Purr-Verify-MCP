import { isHostedMode } from "../runtime/deployment-mode";
import {
  PrincipalContextError,
  createHostedPrincipal,
  type HostedRequestPrincipal,
  type PrincipalMembership,
} from "./request-principal";

export interface HostedIdentityRecord {
  userId: string;
  memberships: readonly PrincipalMembership[];
  githubLogin?: string;
  clientId?: string;
}

export interface HostedCredentialResolvers {
  resolveSession(sessionToken: string): Promise<HostedIdentityRecord | null>;
  resolveBearer(accessToken: string): Promise<HostedIdentityRecord | null>;
}

export interface HostedRequestCredentials {
  sessionToken?: string | null;
  authorization?: string | null;
}

export class InvalidHostedCredentialError extends PrincipalContextError {
  readonly code = "INVALID_CREDENTIAL";

  constructor(message = "The hosted authentication credential is invalid.") {
    super(message);
    this.name = "InvalidHostedCredentialError";
  }
}

function parseBearerToken(authorization?: string | null): string | null {
  const value = authorization?.trim();
  if (!value) return null;

  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  if (!match?.[1]) {
    throw new InvalidHostedCredentialError("Authorization must use a single Bearer token.");
  }

  return match[1];
}

function toPrincipal(identity: HostedIdentityRecord): HostedRequestPrincipal {
  return createHostedPrincipal({
    userId: identity.userId,
    memberships: identity.memberships,
    githubLogin: identity.githubLogin,
    clientId: identity.clientId,
  });
}

/**
 * Resolves the authenticated user at the HTTP/MCP boundary.
 *
 * Self-hosted mode deliberately returns null so existing VERIFY_TOKEN and
 * GitHub-passthrough flows remain owned by their legacy authentication path.
 * Hosted mode accepts either the browser session cookie or an MCP OAuth Bearer
 * token. When both are present they must resolve to the same user, preventing a
 * confused-deputy request from silently selecting one identity over another.
 */
export async function resolveHostedRequestPrincipal(
  credentials: HostedRequestCredentials,
  resolvers: HostedCredentialResolvers,
): Promise<HostedRequestPrincipal | null> {
  if (!isHostedMode()) return null;

  const sessionToken = credentials.sessionToken?.trim() || null;
  const bearerToken = parseBearerToken(credentials.authorization);

  if (!sessionToken && !bearerToken) {
    throw new PrincipalContextError();
  }

  const [sessionIdentity, bearerIdentity] = await Promise.all([
    sessionToken ? resolvers.resolveSession(sessionToken) : Promise.resolve(null),
    bearerToken ? resolvers.resolveBearer(bearerToken) : Promise.resolve(null),
  ]);

  if (sessionToken && !sessionIdentity) {
    throw new InvalidHostedCredentialError("The hosted session is invalid or expired.");
  }
  if (bearerToken && !bearerIdentity) {
    throw new InvalidHostedCredentialError("The OAuth access token is invalid or expired.");
  }
  if (sessionIdentity && bearerIdentity && sessionIdentity.userId !== bearerIdentity.userId) {
    throw new InvalidHostedCredentialError("Session and Bearer credentials resolve to different users.");
  }

  return toPrincipal(sessionIdentity ?? bearerIdentity!);
}
