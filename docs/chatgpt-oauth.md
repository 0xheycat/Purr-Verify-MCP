# ChatGPT OAuth / Remote MCP Setup

This deployment keeps the existing Bearer-token MCP behavior and adds OAuth protected-resource discovery so ChatGPT Apps and other remote MCP clients can discover how to authenticate.

## Public endpoints

```txt
POST /mcp or POST /api/mcp depending on your proxy
GET  /mcp or GET  /api/mcp depending on your proxy
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-protected-resource/mcp
```

For the public endpoint `https://verify.pursr.xyz/mcp`, the protected resource metadata URL should be:

```txt
https://verify.pursr.xyz/.well-known/oauth-protected-resource/mcp
```

## Required production env

```bash
PUBLIC_BASE_URL=https://verify.pursr.xyz
OAUTH_RESOURCE_URL=https://verify.pursr.xyz/mcp
OAUTH_RESOURCE_NAME="Purr Verify MCP"
OAUTH_REALM=purr-verify-mcp
OAUTH_SCOPES_SUPPORTED=repo,read:user,user:email
```

## OAuth authorization server

Set this when you have an OAuth issuer that can mint access tokens accepted by this server:

```bash
OAUTH_AUTHORIZATION_SERVERS=https://auth.pursr.xyz
```

Until a real authorization server is deployed, clients can still call the MCP endpoint with the existing bearer modes:

```bash
AUTH_MODE=server_token
VERIFY_TOKEN=<client-facing-secret>
GITHUB_TOKEN=<optional_github_pat_for_private_repo_clone>
# Authorization: Bearer <VERIFY_TOKEN>
```

or:

```bash
AUTH_MODE=github_passthrough
# Authorization: Bearer <GitHub PAT>
```

## ChatGPT connector target

Use this as the MCP server URL if your reverse proxy maps `/mcp` to the Next route:

```txt
https://verify.pursr.xyz/mcp
```

If you expose the raw Next route directly, use:

```txt
https://verify.pursr.xyz/api/mcp
```

Make sure `OAUTH_RESOURCE_URL` matches the exact public URL that ChatGPT receives.

## Security notes

- Verification jobs can execute allowlisted commands, so keep tool calls behind approval.
- Prefer `AUTH_MODE=server_token` for a single trusted ChatGPT connector install.
- Prefer a real OAuth authorization server for multi-user public installs.
- Keep `ALLOWED_REPOS` narrow for production whenever possible.
