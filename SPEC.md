# Production MCP OAuth 2.1

## Status

Implementation plan for the hosted Purr Verify MCP authorization boundary. This specification applies to `DEPLOYMENT_MODE=hosted` with `HOSTED_AUTH_ENABLED=true`. Legacy self-hosted bearer authentication remains a separate compatibility path.

## Goals

- Connect ChatGPT/Codex through MCP OAuth without exposing `VERIFY_TOKEN` or GitHub credentials.
- Persist clients, consents, authorization codes, access tokens, and refresh-token families in PostgreSQL.
- Enforce PKCE S256, exact redirect matching, exact MCP resource audience, short token lifetimes, one-time authorization codes, rotating refresh tokens, and replay-family revocation.
- Advertise per-tool OAuth scopes and return `mcp/www_authenticate` challenges that trigger account linking.
- Keep hosted identity, tenant authorization, repository installation authorization, and GitHub clone credentials separate.

## Non-goals

- This change does not implement GitHub App login/session creation, installation webhooks, or disposable workers.
- This change does not make the legacy direct child-process runner safe for public multi-tenant compute.
- Client ID Metadata Documents are not fetched by this patch. Persistent dynamic client registration and predefined clients remain supported.

## Protocol

- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token` (`/oauth/exchange` remains an alias)
- Dynamic registration endpoint: `/oauth/register`
- Revocation endpoint: `/oauth/revoke`
- Protected-resource metadata: `/.well-known/oauth-protected-resource/mcp`
- Authorization-server metadata: `/.well-known/oauth-authorization-server`
- Authorization code TTL: 5 minutes
- Access token TTL: 15 minutes by default
- Refresh token TTL: 30 days by default
- Token format: opaque random bearer values; only SHA-256 digests are persisted

## Scopes

- `verify:read`: health, command policy, owned job list/read
- `verify:run`: create and cancel owned verification jobs
- `verify:share`: reserved for hosted share-link management

GitHub scopes are never advertised as Purr Verify scopes.

## Security invariants

1. Bearer tokens are accepted only from the `Authorization` header.
2. Authorization requests require a valid hosted browser session.
3. Redirect URIs match a registered string exactly.
4. Only PKCE `S256` is accepted.
5. `resource` is required at authorization and token endpoints and must equal the configured MCP resource.
6. Authorization codes are random, hashed, expire in five minutes, and are atomically consumed once.
7. Access and refresh tokens are random and stored only as hashes.
8. Refresh tokens rotate on every use. Reuse of a consumed refresh token revokes its entire family.
9. Client status, token expiry/revocation, audience, and required scopes are checked for every hosted MCP request.
10. Hosted mode never falls back to `VERIFY_TOKEN`, GitHub PAT passthrough, query-string tokens, or the legacy global job store.
11. Authorization, token, registration, and revocation endpoints are rate-limited with PostgreSQL-backed counters.
12. OAuth responses use `Cache-Control: no-store` and avoid logging raw credentials.

## Release gates

- Unit tests cover redirect validation, scope validation, PKCE, challenge generation, and hosted credential scope errors.
- PostgreSQL integration proves code replay and refresh replay rejection.
- Browser authorization and refresh flow pass end to end using a real hosted session.
- ChatGPT receives tool `securitySchemes` and a runtime `mcp/www_authenticate` challenge.
- Wrong audience, redirect mismatch, missing PKCE, insufficient scope, query token, revoked token, and expired token are rejected.
- GitHub App login/session provisioning is merged before enabling external hosted users.
- Disposable isolated workers are merged before enabling public multi-tenant verification jobs.
