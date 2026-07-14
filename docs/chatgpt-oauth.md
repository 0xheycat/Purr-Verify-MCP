# ChatGPT OAuth / Remote MCP Setup

This repo supports a single-domain, single-owner OAuth deployment for ChatGPT:

```txt
verify.pursr.xyz -> MCP endpoint + embedded OAuth authorization server
```

Use this MCP server URL in ChatGPT:

```txt
https://verify.pursr.xyz/mcp
```

## Discovery endpoints

```txt
https://verify.pursr.xyz/.well-known/oauth-protected-resource/mcp
https://verify.pursr.xyz/.well-known/oauth-authorization-server
```

## OAuth endpoints

```txt
https://verify.pursr.xyz/oauth/authorize
https://verify.pursr.xyz/oauth/exchange
https://verify.pursr.xyz/oauth/revoke
https://verify.pursr.xyz/oauth/register
https://verify.pursr.xyz/oauth/keys
```

## Generate a stable Ed25519 signing key

```bash
openssl genpkey -algorithm Ed25519 -out oauth-private.pem
openssl pkey -in oauth-private.pem -pubout -out oauth-public.pem
```

Store the private PEM only in the server secret manager. `OAUTH_PRIVATE_KEY` and `OAUTH_PUBLIC_KEY` accept PEM text with escaped `\n` line breaks.

## Required environment

```bash
AUTH_MODE=server_token
VERIFY_TOKEN=<long-random-verify-token>
GITHUB_TOKEN=<optional-server-side-token-for-private-repos>
VERIFY_DATA_DIR=/var/lib/purr-verify

PUBLIC_BASE_URL=https://verify.pursr.xyz
OAUTH_ISSUER=https://verify.pursr.xyz
OAUTH_RESOURCE_URL=https://verify.pursr.xyz/mcp
OAUTH_AUTHORIZATION_SERVERS=https://verify.pursr.xyz
OAUTH_RESOURCE_NAME="Purr Verify MCP"
OAUTH_REALM=purr-verify-mcp

OAUTH_CLIENT_ID=chatgpt-purr-verify
OAUTH_ALLOWED_REDIRECT_URIS=https://chatgpt.com/connector/oauth/<exact-callback>
OAUTH_OWNER_CODE=<private-owner-approval-code>
OAUTH_SCOPES_SUPPORTED="verify:read verify:run verify:share"
OAUTH_SUBJECT=0xheycat

OAUTH_PRIVATE_KEY=<ed25519-private-key-pem>
OAUTH_PUBLIC_KEY=<matching-ed25519-public-key-pem>
OAUTH_ACTIVE_KEY_ID=purr-verify-2026-07

OAUTH_TOKEN_TTL_SECONDS=900
OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
```

Production fails closed when `OAUTH_PRIVATE_KEY` is missing. Ephemeral keys are intended only for development and tests.

`VERIFY_DATA_DIR` must be backed by a persistent writable volume. Authorization-code consumption and hashed refresh state are stored under `VERIFY_DATA_DIR/oauth/state.json` with restrictive file permissions. Raw refresh credentials are not written to disk.

## ChatGPT app settings

```txt
Name: MCP verify
Server URL: https://verify.pursr.xyz/mcp
Authentication: OAuth
Registration method: User-Defined OAuth Client
OAuth Client ID: chatgpt-purr-verify
OAuth Client Secret: empty
Token endpoint auth method: none
Scopes: verify:read verify:run verify:share
```

After connecting, the authorization page asks for `OAUTH_OWNER_CODE`.

The access credential defaults to a 15-minute lifetime. The refresh credential is rotated on every refresh request. Reusing an older rotated credential revokes the complete refresh family and requires reconnecting the ChatGPT app.

## Key rotation

Set a new `OAUTH_PRIVATE_KEY`, matching `OAUTH_PUBLIC_KEY`, and new `OAUTH_ACTIVE_KEY_ID`. Keep previous public keys available temporarily through `OAUTH_VERIFICATION_PUBLIC_KEYS`:

```json
[
  {
    "kid": "previous-key-id",
    "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  }
]
```

New credentials use the active key. Existing access credentials continue to verify while their previous public key remains configured.

## Discovery checks

```powershell
Invoke-RestMethod "https://verify.pursr.xyz/.well-known/oauth-protected-resource/mcp" | ConvertTo-Json -Depth 10
Invoke-RestMethod "https://verify.pursr.xyz/.well-known/oauth-authorization-server" | ConvertTo-Json -Depth 10
Invoke-RestMethod "https://verify.pursr.xyz/oauth/keys" | ConvertTo-Json -Depth 10
```

Keep `OAUTH_OWNER_CODE`, `VERIFY_TOKEN`, `GITHUB_TOKEN`, and `OAUTH_PRIVATE_KEY` private.

## Deployment boundary

This implementation supports one active application instance with durable local storage. Do not horizontally scale the embedded authorization server until OAuth state is moved to shared transactional persistence. Dynamic client registrations are also currently process-local; use the predefined client configuration for production.
