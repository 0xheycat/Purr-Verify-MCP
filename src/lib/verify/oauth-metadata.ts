import { NextRequest } from "next/server";
import {
  oauthIssuer,
  oauthPublicBaseUrl,
  oauthResourceUrl,
  splitOAuthList,
  supportedOauthScopes,
} from "./oauth-crypto";

function headerSafe(value: string): string {
  return value.replace(/["\\\r\n]/g, "");
}

export function mcpResourceUrl(req: NextRequest): string {
  return oauthResourceUrl(req);
}

export function oauthResourceMetadataUrl(req: NextRequest): string {
  const resource = new URL(mcpResourceUrl(req));
  const path = resource.pathname === "/" ? "" : resource.pathname;
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

export function oauthProtectedResourceMetadata(
  req: NextRequest
): Record<string, unknown> {
  const authorizationServers = splitOAuthList(
    process.env.OAUTH_AUTHORIZATION_SERVERS || oauthIssuer(req)
  );

  return {
    resource: mcpResourceUrl(req),
    resource_name: process.env.OAUTH_RESOURCE_NAME || "Purr Verify MCP",
    bearer_methods_supported: ["header"],
    scopes_supported: supportedOauthScopes(),
    authorization_servers: authorizationServers,
    resource_documentation: `${oauthPublicBaseUrl(req)}/`,
  };
}

export interface OAuthChallengeOptions {
  error?: "invalid_token" | "insufficient_scope";
  reason?: string;
  scope?: string;
}

export function oauthAuthenticateHeaders(
  req: NextRequest,
  challenge?: string | OAuthChallengeOptions
): Headers {
  const realm = process.env.OAUTH_REALM || "purr-verify-mcp";
  const options: OAuthChallengeOptions =
    typeof challenge === "string"
      ? { error: "invalid_token", reason: challenge }
      : challenge || {};
  const parts = [
    `Bearer realm="${headerSafe(realm)}"`,
    `resource_metadata="${headerSafe(oauthResourceMetadataUrl(req))}"`,
  ];

  if (options.error) {
    parts.push(`error="${options.error}"`);
  }
  if (options.reason) {
    parts.push(`error_description="${headerSafe(options.reason)}"`);
  }
  if (options.scope) {
    parts.push(`scope="${headerSafe(options.scope)}"`);
  }

  return new Headers({
    "WWW-Authenticate": parts.join(", "),
  });
}
