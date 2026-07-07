import { NextRequest } from "next/server";

function splitCsv(raw = ""): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNoTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function requestOrigin(req: NextRequest): string {
  const parsed = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || parsed.protocol.replace(/:$/, "") || "https";
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || parsed.host;
  return `${proto}://${host}`;
}

function publicBaseUrl(req: NextRequest): string {
  return normalizeNoTrailingSlash(process.env.PUBLIC_BASE_URL || requestOrigin(req));
}

function headerSafe(value: string): string {
  return value.replace(/["\\\r\n]/g, "");
}

export function mcpResourceUrl(req: NextRequest): string {
  return process.env.OAUTH_RESOURCE_URL || `${publicBaseUrl(req)}/mcp`;
}

export function oauthResourceMetadataUrl(req: NextRequest): string {
  const resource = new URL(mcpResourceUrl(req));
  const path = resource.pathname === "/" ? "" : resource.pathname;
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

export function oauthProtectedResourceMetadata(req: NextRequest): Record<string, unknown> {
  const authorizationServers = splitCsv(process.env.OAUTH_AUTHORIZATION_SERVERS || "");
  const scopes = splitCsv(process.env.OAUTH_SCOPES_SUPPORTED || "repo,read:user,user:email");

  const metadata: Record<string, unknown> = {
    resource: mcpResourceUrl(req),
    resource_name: process.env.OAUTH_RESOURCE_NAME || "Purr Verify MCP",
    bearer_methods_supported: ["header"],
    scopes_supported: scopes,
    resource_documentation: `${publicBaseUrl(req)}/`,
  };

  if (authorizationServers.length > 0) {
    metadata.authorization_servers = authorizationServers;
  }

  return metadata;
}

export function oauthAuthenticateHeaders(req: NextRequest, reason?: string): Headers {
  const realm = process.env.OAUTH_REALM || "purr-verify-mcp";
  const parts = [
    `Bearer realm="${headerSafe(realm)}"`,
    `resource_metadata="${headerSafe(oauthResourceMetadataUrl(req))}"`,
  ];

  if (reason) {
    parts.push('error="invalid_token"');
    parts.push(`error_description="${headerSafe(reason)}"`);
  }

  return new Headers({
    "WWW-Authenticate": parts.join(", "),
  });
}
