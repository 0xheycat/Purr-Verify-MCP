import type { NextRequest } from "next/server";

import { getHostedPrismaClient } from "../database/hosted-prisma-client";
import { isHostedMode } from "../runtime/deployment-mode";
import { createPrismaHostedCredentialResolvers, type HostedCredentialPrismaClient } from "./prisma-hosted-credential-resolvers";
import { resolveHostedRequestPrincipal } from "./hosted-principal-resolver";
import type { HostedRequestPrincipal } from "./request-principal";

export const DEFAULT_HOSTED_SESSION_COOKIE = "purr_verify_session";

function hostedSessionCookieName(): string {
  return process.env.HOSTED_SESSION_COOKIE_NAME?.trim() || DEFAULT_HOSTED_SESSION_COOKIE;
}

function hostedOAuthAudience(): string {
  const audience = process.env.OAUTH_RESOURCE_URL?.trim();
  if (!audience) throw new Error("OAUTH_RESOURCE_URL is required in hosted mode.");
  return audience.replace(/\/+$/, "");
}

export async function resolveHostedPrincipalFromRequest(
  req: NextRequest,
): Promise<HostedRequestPrincipal | null> {
  if (!isHostedMode()) return null;

  const prisma = await getHostedPrismaClient<HostedCredentialPrismaClient & { $disconnect(): Promise<void> }>();
  const resolvers = createPrismaHostedCredentialResolvers(prisma, {
    audience: hostedOAuthAudience(),
    requiredBearerScopes: ["verify:read"],
  });

  return resolveHostedRequestPrincipal(
    {
      sessionToken: req.cookies.get(hostedSessionCookieName())?.value,
      authorization: req.headers.get("authorization"),
    },
    resolvers,
  );
}
