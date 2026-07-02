# Purr Verify MCP

Private live-verification runner for coding agents.

When an agent can edit code through GitHub MCP but cannot install dependencies,
access the internet, or run `bun test`, this service becomes the missing runtime:
it clones a GitHub branch fresh, runs an allowlisted command set, captures logs,
returns results through REST or MCP, then deletes the workspace.

> Not a general shell executor. Commands are allowlisted and executed with
> `spawn(..., { shell: false })`.

## What It Solves

- Agent sandbox has no internet or `node_modules`.
- GitHub Actions is unavailable, disabled, or billing-blocked.
- You need live proof for `bun install`, `bun test`, `bun run build`,
  `bunx prisma generate`, or a project-specific smoke script.
- You want a MCP tool that Notion/agents can call directly.

```text
Agent / Notion
  -> Purr-github-MCP       read/write repo, PRs, commits
  -> Purr Verify MCP       clone branch, install deps, run checks, return logs
```

## Features

- REST API and MCP-style JSON-RPC endpoint at `/mcp`
- `sync` mode for one-call verification
- `async` queue mode with polling
- GitHub private repo support through GitHub PAT passthrough
- Optional server-side `GITHUB_TOKEN` mode
- unrestricted repo mode for personal use, still github.com-only
- per-job fresh workspace
- automatic cleanup
- command timeout and job timeout
- log truncation
- secret redaction
- dashboard with jobs, logs, share links, annotations, and health

## Tech Stack

- Next.js 16 App Router
- React 19
- TypeScript 5 strict mode
- Bun runtime/package manager
- Tailwind CSS 4 + shadcn-style UI
- JSON file persistence for finished jobs

## Quick Deploy On Render

Render supports Bun and full Next.js web services. Use **Web Service**, not
Static Site.

Recommended Render settings:

```bash
Build Command:
bun install --frozen-lockfile && bun run build

Start Command:
bun run start
```

Required env for easiest private-repo usage:

```bash
AUTH_MODE=github_passthrough
ALLOWED_REPOS=*
ALLOW_ALL_REPOS=true
VERIFY_TOKEN=unused-in-github-passthrough
WORKDIR_BASE=.verify-workspaces
VERIFY_DATA_DIR=.verify-data
MAX_LOG_BYTES=500000
COMMAND_TIMEOUT_MS=600000
JOB_TIMEOUT_MS=1800000
MAX_CONCURRENT_JOBS=1
CLEANUP_AFTER_MS=3600000
```

Then connect your MCP client:

```text
MCP URL:
https://<your-render-app>.onrender.com/mcp

Auth:
Bearer token

Token:
<your GitHub PAT>
```

In `AUTH_MODE=github_passthrough`, the bearer token is validated against the
GitHub API and reused only in memory to clone private repos.

## Render Blueprint

This repo includes `render.yaml`.

If using Render Blueprint, connect the repo and let Render read:

```yaml
render.yaml
```

The blueprint defaults to:

- `AUTH_MODE=github_passthrough`
- `ALLOWED_REPOS=*`
- `ALLOW_ALL_REPOS=true`
- `MAX_CONCURRENT_JOBS=1`

## Local Development

```bash
cp .env.example .env
bun install
bun run dev
```

Open:

```text
http://localhost:3000
```

Check everything:

```bash
bun run check
```

Individual checks:

```bash
bun run typecheck
bun run lint
bun run build
```

## Environment Variables

| Var | Default | Notes |
| --- | --- | --- |
| `AUTH_MODE` | `server_token` | `server_token` or `github_passthrough` |
| `VERIFY_TOKEN` | empty | Required only in `server_token` mode |
| `GITHUB_TOKEN` | empty | Optional clone token in `server_token` mode |
| `ALLOWED_REPOS` | empty | Empty or `*` means unrestricted safe `owner/repo` mode |
| `ALLOW_ALL_REPOS` | `false` | Force unrestricted safe repo mode |
| `WORKDIR_BASE` | `.verify-workspaces` | Fresh per-job clone directory |
| `VERIFY_DATA_DIR` | `.verify-data` | Finished job JSON persistence |
| `MAX_LOG_BYTES` | `500000` | Per command stdout/stderr cap |
| `COMMAND_TIMEOUT_MS` | `600000` | Per command timeout |
| `JOB_TIMEOUT_MS` | `1800000` | Whole job timeout |
| `MAX_CONCURRENT_JOBS` | `1` | Keep `1` on free hosts |
| `CLEANUP_AFTER_MS` | `3600000` | Cleanup hint |

## Auth Modes

### `github_passthrough`

Best for Notion/agent usage with private GitHub repos.

```bash
AUTH_MODE=github_passthrough
ALLOWED_REPOS=*
ALLOW_ALL_REPOS=true
```

Client sends:

```text
Authorization: Bearer <GitHub PAT>
```

The server:

- validates the PAT with `GET https://api.github.com/user`
- caches validation by token hash for 5 minutes
- uses the PAT in memory for `git clone`
- never persists the token
- redacts token patterns from logs/errors

### `server_token`

Best for stable private deployments where env vars are easy to set.

```bash
AUTH_MODE=server_token
VERIFY_TOKEN=<random service token>
GITHUB_TOKEN=<optional GitHub PAT for private clone>
```

Client sends:

```text
Authorization: Bearer <VERIFY_TOKEN>
```

## REST API

### Health

```bash
curl https://<host>/api/health
```

### Diagnostics

```bash
curl -H "Authorization: Bearer $TOKEN" https://<host>/api/smoke
```

Reports auth mode, repo mode, runtime tools, command allowlist, and sample
validations. It does not execute repo commands.

### Sync Verification

Use sync mode when an agent wants one call and the final result.

```bash
curl -X POST "https://<host>/api/verify?mode=sync" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo":"0xheycat/Purr-github-MCP",
    "ref":"main",
    "commands":["bun install"],
    "metadata":{"purpose":"smoke"}
  }'
```

Response is the full final job:

```json
{
  "status": "success",
  "cleanupStatus": "done",
  "commands": [
    {
      "command": "bun install",
      "status": "success",
      "exitCode": 0
    }
  ]
}
```

### Async Verification

```bash
curl -X POST "https://<host>/api/verify" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"0xheycat/Purr-github-MCP","ref":"main","commands":["bun install"]}'
```

Then poll:

```bash
curl -H "Authorization: Bearer $TOKEN" https://<host>/api/verify/<jobId>
```

## MCP Endpoint

URL:

```text
https://<host>/mcp
```

Methods:

- `initialize`
- `tools/list`
- `tools/call`

Tools:

| Tool | Purpose | Read-only |
| --- | --- | --- |
| `create_verification_job` | create sync/async verification job | no |
| `get_verification_job` | fetch job result | yes |
| `list_verification_jobs` | list recent jobs | yes |
| `cancel_verification_job` | cancel queued/running job | no |
| `health_check` | health/config summary | yes |
| `create_share_link` | public read-only result link | no |
| `list_share_links` | list share links for a job | yes |
| `revoke_share_links` | revoke links | no |

### MCP Sync Example

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_verification_job",
    "arguments": {
      "repo": "0xheycat/Purr-github-MCP",
      "ref": "main",
      "mode": "sync",
      "commands": ["bun install"],
      "metadata": {
        "purpose": "live verification"
      }
    }
  }
}
```

## Agent Instructions

Give this to agents:

```text
Use Purr Verify MCP when you need live verification.

Prefer:
create_verification_job with mode:"sync"

For long jobs:
create_verification_job with mode:"async", then poll get_verification_job.

Treat status:"success" plus cleanupStatus:"done" as verified.
Report each command's exitCode/stdout/stderr.
Do not send arbitrary shell commands. Only allowlisted commands work.
```

## Command Allowlist

Allowed grammars:

```text
bun install
bun install --frozen-lockfile
bunx prisma generate
bun run <script>
bun test
bun test <path>
npm ci
npm run <script>
pnpm install --frozen-lockfile
pnpm run <script>
npx prisma generate
node <safe-relative-path>
cat reports/<file>.json
cat reports/<file>.txt
ENV_MODE=mock bun run scripts/manage.ts <safe-flags>
```

Rejected everywhere:

```text
; && || | > < ` $() .. \ " '
curl wget rm mv cp sudo chmod chown ssh scp docker powershell nc mkfs dd
absolute paths
arbitrary git URLs
```

## Security Model

- Bearer auth on protected endpoints and MCP tool calls
- GitHub PAT passthrough supported for private repos
- raw GitHub tokens are never persisted
- repo input is only `owner/repo`, never arbitrary URLs
- clone target is always `https://github.com/<owner>/<repo>.git`
- no shell execution
- fresh workspace per job
- cleanup in `finally`
- max one concurrent job by default
- stdout/stderr redaction for common secret/token patterns

## Operational Notes

- Free hosts may sleep. The first request can cold start.
- Keep `MAX_CONCURRENT_JOBS=1` on Render Free.
- Use `mode:"sync"` for short/medium jobs.
- Use async mode only when the host reliably keeps background work alive.
- Finished job state is persisted best-effort under `.verify-data`.
- Workspaces are deleted after each job; do not rely on cache.

## License

MIT
