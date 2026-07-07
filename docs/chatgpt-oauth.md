# ChatGPT OAuth / Remote MCP Setup

This repo supports one-domain OAuth setup for ChatGPT:

```txt
verify.pursr.xyz -> MCP endpoint + OAuth authorization server
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
https://verify.pursr.xyz/oauth/register
https://verify.pursr.xyz/oauth/keys
```

## Required env

```bash
AUTH_MODE=server_token
VERIFY_TOKEN=<long-random-verify-token>
GITHUB_TOKEN=<optional-github-token-for-private-repos>

PUBLIC_BASE_URL=https://verify.pursr.xyz
OAUTH_RESOURCE_URL=https://verify.pursr.xyz/mcp
OAUTH_AUTHORIZATION_SERVERS=https://verify.pursr.xyz
OAUTH_RESOURCE_NAME="Purr Verify MCP"
OAUTH_REALM=purr-verify-mcp
OAUTH_SCOPES_SUPPORTED="verify:run verify:read repo read:user user:email"

OAUTH_ISSUER=https://verify.pursr.xyz
OAUTH_CLIENT_ID=chatgpt-purr-verify
OAUTH_OWNER_CODE=<private-owner-code>
OAUTH_JWT_SECRET=<long-random-secret>
OAUTH_TOKEN_TTL_SECONDS=3600
OAUTH_SUBJECT=0xheycat
```

## ChatGPT app settings

```txt
Name: MCP verify
Server URL: https://verify.pursr.xyz/mcp
Authentication: OAuth
Registration method: User-Defined OAuth Client
OAuth Client ID: chatgpt-purr-verify
OAuth Client Secret: empty
Token endpoint auth method: none
Scopes: verify:run verify:read repo read:user user:email
```

After connecting, the authorize page asks for `OAUTH_OWNER_CODE`.

## Tests

```powershell
Invoke-RestMethod "https://verify.pursr.xyz/.well-known/oauth-protected-resource/mcp" | ConvertTo-Json -Depth 10
Invoke-RestMethod "https://verify.pursr.xyz/.well-known/oauth-authorization-server" | ConvertTo-Json -Depth 10
```

Keep `OAUTH_OWNER_CODE`, `VERIFY_TOKEN`, `GITHUB_TOKEN`, and `OAUTH_JWT_SECRET` private.
