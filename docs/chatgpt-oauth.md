# ChatGPT OAuth / Remote MCP Setup

Purr Verify supports a single-owner, self-hosted OAuth deployment where the MCP resource and embedded authorization server share one stable HTTPS origin.

```txt
https://verify.pursr.xyz/mcp
```

This setup is production-ready for one active application instance. It is not the hosted multi-tenant architecture described by the separate hosted-platform work.

## Endpoints

```txt
MCP resource
https://verify.pursr.xyz/mcp

Protected-resource metadata
https://verify.pursr.xyz/.well-known/oauth-protected-resource/mcp

Authorization-server metadata
https://verify.pursr.xyz/.well-known/oauth-authorization-server

Authorization endpoint
https://verify.pursr.xyz/oauth/authorize

Token endpoint
https://verify.pursr.xyz/oauth/exchange

JWKS
https://verify.pursr.xyz/oauth/keys
```

`/oauth/register` is advertised only when `OAUTH_DCR_ENABLED=true`. Keep DCR disabled for the predefined ChatGPT client unless dynamic registration is specifically required.

## Security model

- OAuth 2.1 authorization-code flow with PKCE `S256`.
- Exact redirect URI matching; wildcard or prefix matching is not used.
- The MCP `resource` parameter is required during authorization and token exchange.
- Authorization codes are opaque, hashed at rest, expire after five minutes, and can be consumed only once.
- Access credentials are RS256 JWTs with a stable `kid` and public JWKS.
- Issuer, audience, expiry, activation time, client, signature, and scopes are checked on every protected MCP call.
- OAuth credentials are valid only at the canonical `/mcp` resource, not `/api/mcp` or REST endpoints.
- Bearer credentials are accepted only from the `Authorization` header, never query parameters.
- `verify:read`, `verify:run`, and `verify:share` are enforced as real authorization boundaries.
- GitHub access stays server-side through `GITHUB_TOKEN`; OAuth credentials are not GitHub credentials.

## Generate the RSA signing key

Generate the key once and keep the private key stable across deploys:

```bash
openssl genpkey \
  -algorithm RSA \
  -pkeyopt rsa_keygen_bits:3072 \
  -out oauth-private.pem
```

Store the complete PEM contents in the deployment secret named `OAUTH_PRIVATE_KEY_PEM`. Do not commit the key. Changing the key invalidates existing access credentials and requires reconnecting ChatGPT.

## Required production environment

```bash
AUTH_MODE=server_token
VERIFY_TOKEN=<long-random-service-value>
GITHUB_TOKEN=<server-side-github-token>

PUBLIC_BASE_URL=https://verify.pursr.xyz
OAUTH_ISSUER=https://verify.pursr.xyz
OAUTH_RESOURCE_URL=https://verify.pursr.xyz/mcp
OAUTH_AUTHORIZATION_SERVERS=https://verify.pursr.xyz
OAUTH_RESOURCE_NAME="Purr Verify MCP"
OAUTH_REALM=purr-verify-mcp

OAUTH_CLIENT_ID=chatgpt-purr-verify
OAUTH_ALLOWED_REDIRECT_URIS=<exact-chatgpt-callback-uri>
OAUTH_OWNER_CODE=<strong-owner-approval-value>
OAUTH_PRIVATE_KEY_PEM=<complete-rsa-private-key-pem>
OAUTH_KEY_ID=purr-verify-2026-07
OAUTH_TOKEN_TTL_SECONDS=3600
OAUTH_SUBJECT=0xheycat
OAUTH_SCOPES_SUPPORTED="verify:read verify:run verify:share"
OAUTH_DCR_ENABLED=false
```

Copy the exact callback URI shown by ChatGPT into `OAUTH_ALLOWED_REDIRECT_URIS`. Do not use a domain prefix or wildcard. Multiple exact callback URIs can be separated by spaces or commas.

Restrict `GITHUB_TOKEN` to only the repositories and permissions required by the verification runner. `VERIFY_TOKEN` remains available for legacy server-to-server REST access and must not be exposed to ChatGPT.

## ChatGPT configuration

```txt
Name: Purr Verify MCP
Server URL: https://verify.pursr.xyz/mcp
Authentication: OAuth
Registration method: User-Defined OAuth Client
OAuth Client ID: chatgpt-purr-verify
OAuth Client Secret: empty
Token endpoint auth method: none
Scopes: verify:read verify:run verify:share
```

After connection, the authorization page displays the callback hostname and asks for `OAUTH_OWNER_CODE`. Approve only when the displayed redirect destination is expected.

The current embedded server issues one-hour access credentials and does not advertise a refresh grant. ChatGPT must reconnect after expiry. This avoids claiming refresh support before durable rotation and revocation are implemented.

## Validation

Check discovery and JWKS:

```bash
curl -fsS https://verify.pursr.xyz/.well-known/oauth-protected-resource/mcp
curl -fsS https://verify.pursr.xyz/.well-known/oauth-authorization-server
curl -fsS https://verify.pursr.xyz/oauth/keys
```

Expected results:

- protected-resource metadata reports the exact `/mcp` resource;
- authorization-server metadata reports `authorization_code`, PKCE `S256`, and `none` client authentication;
- JWKS contains one RSA signing key with the configured `kid`;
- an unauthenticated protected tool call returns `401` with `resource_metadata` in `WWW-Authenticate`;
- a `verify:read` credential calling a run tool returns `403 insufficient_scope`;
- replaying an authorization code returns `invalid_grant`.

## Deployment boundary

OAuth clients and authorization-code state are stored under `VERIFY_DATA_DIR/oauth`. Use one active application instance and persistent storage. A restart during an authorization flow invalidates an in-flight code if the storage is ephemeral.

Do not horizontally scale this embedded authorization server until OAuth state is moved to transactional shared persistence. The hosted multi-tenant product also requires tenant ownership, GitHub App identity, and isolated workers before it can be called production-ready.

Keep `OAUTH_OWNER_CODE`, `OAUTH_PRIVATE_KEY_PEM`, `VERIFY_TOKEN`, and `GITHUB_TOKEN` private.
