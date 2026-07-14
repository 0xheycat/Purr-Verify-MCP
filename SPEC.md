# Purr Verify MCP OAuth Production Hardening

## Status

Implementation specification for the single-owner, self-hosted Purr Verify deployment mode.

This change makes the existing remote MCP OAuth flow durable, audience-bound, scope-enforced, replay-resistant, and compatible with ChatGPT's OAuth 2.1 MCP flow. It does not declare the hosted multi-tenant architecture production-ready.

## Product boundary

- MCP resource: the exact configured `OAUTH_RESOURCE_URL`, normally `https://<host>/mcp`.
- Authorization server: embedded in the same deployment and configured with a stable HTTPS issuer.
- Resource owner: one self-hosted owner authenticated by a strong `OAUTH_OWNER_CODE`.
- GitHub repository access: server-side `GITHUB_TOKEN` in `AUTH_MODE=server_token`; OAuth access tokens are never used as GitHub credentials.
- Runtime topology: one active application instance using durable local storage under `VERIFY_DATA_DIR`.

Multi-instance, multi-tenant, public hosted operation remains governed by the separate hosted architecture work and requires shared transactional persistence, GitHub App identity, tenant ownership, and isolated workers.

## Required OAuth behavior

- OAuth 2.1 authorization-code flow with PKCE `S256`.
- Protected-resource and authorization-server discovery metadata.
- Exact configured issuer, resource, redirect URI, client ID, and PKCE validation.
- `resource` required and matched in authorization and token requests.
- Persistent dynamic clients when DCR is explicitly enabled.
- Opaque, hashed, five-minute authorization codes with atomic one-time consumption.
- RS256 access tokens with stable `kid`, public JWKS, issuer, subject, audience, client, scopes, `iat`, `nbf`, `exp`, `jti`, and refresh-family claims.
- Rotating opaque refresh tokens stored only as hashes; refresh replay revokes the complete token family.
- Scope enforcement on MCP tools with `401` for invalid tokens and `403 insufficient_scope` for insufficient permissions.
- OAuth access tokens accepted only at the canonical MCP resource path.
- Bearer tokens never accepted from query strings.
- Rate limits and no-store security headers on authorization endpoints.

## Scope model

- `verify:read`: health, allowlist, job reads, job lists, and share-link reads.
- `verify:run`: create and cancel verification jobs.
- `verify:share`: create and revoke public share links.

Legacy `server_token` and `github_passthrough` requests retain full access for self-hosted backward compatibility. GitHub scopes such as `repo`, `read:user`, and `user:email` are not MCP authorization scopes.

## Production configuration

Required for embedded OAuth:

- `PUBLIC_BASE_URL`
- `OAUTH_ISSUER`
- `OAUTH_RESOURCE_URL`
- `OAUTH_OWNER_CODE` with at least 16 characters
- `OAUTH_PRIVATE_KEY_PEM` containing a stable RSA private key
- `OAUTH_ALLOWED_REDIRECT_URIS` for a predefined client, or explicitly enabled DCR

Recommended:

- `OAUTH_CLIENT_ID=chatgpt-purr-verify`
- `OAUTH_KEY_ID` set to an operational key version
- `OAUTH_TOKEN_TTL_SECONDS=900`
- `OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000`
- `OAUTH_DCR_ENABLED=false` unless dynamic registration is needed
- `AUTH_MODE=server_token`
- a server-side `GITHUB_TOKEN` restricted to the required repositories

## Acceptance gates

- Clean install, typecheck, lint, test, and production build pass.
- OAuth metadata advertises only implemented capabilities.
- JWKS contains the active RSA public key and matching `kid`.
- Authorization-code replay fails.
- Wrong issuer, audience, resource, redirect URI, client, PKCE verifier, expired token, and refresh replay fail closed.
- Read-only tokens cannot create/cancel jobs or create/revoke share links.
- OAuth tokens cannot authenticate non-canonical REST or MCP aliases.
- Existing server-token verification remains functional.

## Rollout

1. Generate and configure the RSA signing key and exact ChatGPT redirect URI.
2. Deploy with DCR disabled and reconnect the ChatGPT app using the predefined client.
3. Validate discovery, authorization, token exchange, scoped tool calls, refresh rotation, and reconnect behavior.
4. Keep the previous release available for rollback; rolling back invalidates newly issued RS256 tokens and requires reconnecting.
5. Do not scale above one application instance until OAuth state moves to transactional shared persistence.
