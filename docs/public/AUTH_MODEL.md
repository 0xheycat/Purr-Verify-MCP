# Hosted Authentication and Authorization Model

## Principle

GitHub identity, GitHub repository access, Purr Verify web sessions, and Purr Verify MCP authorization are separate credentials with separate audiences.

## Credential classes

| Credential | Issuer | Audience | Purpose | Persistence |
|---|---|---|---|---|
| Web session | Purr Verify | Dashboard | Browser authentication | HttpOnly cookie; server-side session record |
| MCP access token | Purr Verify | Exact MCP resource URI | MCP API authorization | Short-lived; token metadata/revocation state persisted |
| MCP refresh token | Purr Verify | OAuth token endpoint | Rotate MCP access | Hashed, rotating, replay-detected |
| GitHub user token | GitHub | GitHub API | Login/account discovery when required | Encrypted and minimized, or avoided after login |
| GitHub installation token | GitHub | Selected installation/repository | JIT clone/read | Memory only; short-lived; removed before workflow steps |
| Purr API key | Purr Verify | REST API | Optional advanced automation | Display once; store hash only |

A GitHub PAT or installation token must never be accepted as an MCP bearer token.

## Web login

- Use GitHub App user authorization with `state` and PKCE where supported.
- Resolve or create a stable user from verified GitHub identity.
- Issue an opaque web session identifier in `HttpOnly; Secure; SameSite=Lax` cookie.
- Rotate the session after authentication and privilege changes.
- Persist expiry, last use, IP/user-agent hints, and revocation state.
- Require CSRF protection for state-changing cookie-authenticated endpoints.

## GitHub installations

- Installation records belong to a user or organization tenant.
- Repository access is derived from active GitHub installation state and synchronized by `installation` and `installation_repositories` webhooks.
- Every job creation rechecks that the installation can access the requested repository.
- Clone credentials are minted just in time, scoped to the target repository, held only in memory, and removed before user commands execute.

## MCP OAuth requirements

The hosted authorization server must provide:

- protected-resource metadata for the exact MCP resource
- authorization-server metadata
- authorization code flow with PKCE S256
- exact redirect URI matching
- persistent clients and consent records
- one-time authorization codes with atomic consumption
- short-lived access tokens with issuer, subject, audience, scope, issued-at, expiry, JWT ID, and key ID
- refresh token rotation and family replay detection
- token revocation and client/session revocation
- asymmetric signing and a public JWKS endpoint
- rate limits for authorize, token, registration, and failed authentication

Recommended defaults:

- authorization code: 5 minutes, single use
- MCP access token: 15 minutes
- refresh token: 30 days, rotating
- required PKCE method: S256

## Scope model

Initial scopes:

- `verify:read` — read owned repositories, jobs, logs, and artifacts
- `verify:run` — validate and create jobs, cancel owned jobs
- `verify:share` — create and revoke share links
- `verify:secrets:read_names` — list environment and secret names only

GitHub scopes such as `repo`, `read:user`, or `user:email` are not Purr Verify MCP scopes and must not be advertised as if they authorize Purr resources.

## Authorization checks

Every protected operation requires all of:

1. valid credential for the expected audience and mode
2. required Purr Verify scope
3. active user and client/session
4. tenant membership
5. object ownership or explicit organization role
6. repository installation authorization when repository access is involved
7. quota and policy approval for compute mutations

For object lookups, return `404` when revealing existence would cross a tenant boundary.

## Removed hosted flows

Hosted public mode must not expose:

- `OAUTH_OWNER_CODE`
- global `OAUTH_SUBJECT`
- pasted `VERIFY_TOKEN`
- pasted GitHub PAT
- `github_passthrough`
- bearer tokens in query strings
- localStorage bearer-token storage
- reusable stateless authorization codes
- in-memory-only dynamic clients

These may remain only inside an explicitly selected legacy self-hosted compatibility path where documented.

## Audit events

Record login, logout, installation changes, authorization consent, client registration, token refresh/replay, API-key lifecycle, job mutation, secret injection, share-link lifecycle, and administrative policy actions. Never record credential or secret plaintext.