# Purr Verify MCP Product Specification

## Current product boundary

Purr Verify MCP is a self-hosted verification runner. It exposes an MCP JSON-RPC endpoint, protected REST endpoints, and an optional embedded OAuth authorization server for clients such as ChatGPT.

This branch hardens the embedded OAuth flow for production-grade single-owner/self-hosted deployments. It does not turn the current process-local runner into the hosted multi-tenant product described by `docs/public/*`.

## OAuth requirements

- Advertise protected-resource and authorization-server metadata for the exact `/mcp` resource.
- Require authorization code flow with PKCE S256.
- Require and bind the RFC 8707 `resource` value at authorization and token exchange.
- Match redirect URIs exactly.
- Reject unsupported scopes and enforce granted scopes on every MCP tool call.
- Treat authorization codes as single-use during the lifetime of the running instance.
- Never accept bearer tokens from URL query parameters.
- Do not advertise a JWKS endpoint while access tokens use symmetric HS256 signing.
- Return OAuth-compatible `WWW-Authenticate` challenges for protected MCP calls.
- Keep service secrets server-side and redact them from logs.

## Scope mapping

- `verify:read`: health, allowlist, job reads, and share-link reads.
- `verify:run`: create and cancel verification jobs.
- `verify:share`: create and revoke share links.

Legacy `VERIFY_TOKEN` and `github_passthrough` credentials retain their existing full-access behavior in explicitly selected self-hosted modes.

## Production limitations

Process-local dynamic clients and consumed-code tracking do not survive restarts or horizontal scaling. A hosted public deployment requires persistent clients, consent, one-time codes, refresh-token rotation, asymmetric signing/JWKS, tenant ownership, GitHub App repository authorization, rate limits, audit records, and isolated workers. Those requirements remain tracked by the public architecture work.

## Acceptance checks

- Typecheck, lint, tests, and production build pass.
- OAuth unit tests cover scope validation, resource binding, one-time code rejection, and redirect validation.
- MCP tool calls reject OAuth tokens missing the required tool scope.
- Existing server-token verification behavior remains backward compatible.
