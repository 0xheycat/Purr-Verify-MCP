# Purr Verify MCP Product Specification

## Current product boundary

Purr Verify MCP is a self-hosted verification runner. It exposes an MCP JSON-RPC endpoint, protected REST endpoints, and an optional embedded OAuth authorization server for clients such as ChatGPT.

This branch hardens the embedded OAuth flow for production-grade single-owner, single-instance deployments. It does not turn the current runner into the hosted multi-tenant product described by `docs/public/*`.

## OAuth requirements

- Advertise protected-resource and authorization-server metadata for the exact `/mcp` resource.
- Require authorization-code flow with PKCE S256.
- Require and bind the RFC 8707 `resource` value at authorization, code exchange, and refresh exchange.
- Match redirect URIs exactly.
- Reject unsupported scopes and enforce granted scopes on every MCP tool call.
- Persist authorization-code consumption so codes remain single-use across process restarts.
- Issue short-lived EdDSA access tokens with a stable `kid` and public JWKS.
- Issue opaque refresh credentials, persist only their SHA-256 hashes, and rotate them on every use.
- Revoke the complete refresh family when an already-rotated credential is replayed.
- Allow refresh scope narrowing, but never scope escalation.
- Expose a refresh-family revocation endpoint.
- Never accept bearer credentials from URL query parameters.
- Return OAuth-compatible `WWW-Authenticate` challenges for protected MCP calls.
- Keep service secrets and private signing keys server-side and redact them from logs.

## Scope mapping

- `verify:read`: health, allowlist, job reads, and share-link reads.
- `verify:run`: create and cancel verification jobs.
- `verify:share`: create and revoke share links.

Legacy `VERIFY_TOKEN` and `github_passthrough` credentials retain their existing full-access behavior in explicitly selected self-hosted modes.

## Token lifecycle

- Authorization code lifetime: five minutes.
- Default access-token lifetime: 900 seconds, configurable with `OAUTH_TOKEN_TTL_SECONDS`.
- Default refresh lifetime: 30 days, configurable with `OAUTH_REFRESH_TOKEN_TTL_SECONDS`.
- Access tokens are signed with Ed25519/EdDSA and include issuer, subject, audience, client, scope, `jti`, `iat`, and `exp`.
- Refresh credentials are opaque random values. Raw values are returned to the client once and are never written to disk.
- Refresh rotation and replay-family revocation are serialized and persisted under `VERIFY_DATA_DIR/oauth/state.json`.

## Production configuration

A production deployment requires:

- Stable HTTPS values for `PUBLIC_BASE_URL`, `OAUTH_ISSUER`, and `OAUTH_RESOURCE_URL`.
- A strong private `OAUTH_OWNER_CODE`.
- A stable Ed25519 private key in `OAUTH_PRIVATE_KEY`.
- A stable `OAUTH_ACTIVE_KEY_ID`.
- Exact redirect URIs in `OAUTH_ALLOWED_REDIRECT_URIS` for the predefined client.
- A persistent writable `VERIFY_DATA_DIR` volume.

`OAUTH_PUBLIC_KEY` may be supplied as an integrity check. Previous public keys can remain available during key rotation through `OAUTH_VERIFICATION_PUBLIC_KEYS`.

## Production limitations

The current durable OAuth state uses a local JSON file and a process-level serialization gate. It supports one active application instance with a persistent local volume. It is not safe for multiple application instances sharing the same file without an external transactional lock.

Dynamic client registration remains process-local. A hosted public deployment still requires shared transactional persistence, tenant ownership, durable dynamic clients and consent, GitHub App repository authorization, rate limits, audit records, and isolated workers.

## Acceptance checks

- Typecheck, lint, full tests, and production build pass.
- OAuth tests cover scope validation, resource binding, one-time code rejection, EdDSA/JWKS verification, refresh rotation, replay-family revocation, explicit revocation, scope narrowing, and hash-only persistence.
- MCP tool calls reject OAuth credentials missing the required tool scope.
- Existing server-token verification behavior remains backward compatible.
