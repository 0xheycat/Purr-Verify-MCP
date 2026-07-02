# Purr Verify MCP

A **private verification runner** that coding agents can call via REST or
MCP-style JSON-RPC to verify GitHub branches when GitHub Actions is unavailable.

The service clones a repo/branch **fresh** into a throwaway workspace, runs an
**allowlisted** set of commands (e.g. `bun install`, `bun test`, `bun run build`),
captures logs, returns status/results, and **auto-cleans** the workspace.

> This is **not** a general shell executor. It is an allowlisted verification
> runner for your own repos and agents. Every command must match a fixed
> grammar; dangerous tokens (`; && || | > < \` $()`, `rm`, `sudo`, `curl|sh`,
> absolute paths, …) are rejected.

---

## Why

Coding agents often run in sandboxes with **no internet** and **no
`node_modules`**, so they can edit code through the GitHub MCP but cannot
live-verify builds/tests. **Purr Verify MCP** is the verification execution
environment: it has outbound internet for `git clone` + package install, runs
the allowlisted commands, and hands the logs back to the agent.

---

## Tech stack

- **Next.js 16** (App Router) + **TypeScript 5**
- **Bun** runtime (dev) — also used as the verified package manager
- **Tailwind CSS 4** + **shadcn/ui** for the dashboard
- In-memory job store with lightweight JSON-file persistence (`.verify-data/`)
- `child_process.spawn` with `shell: false` for safe command execution

---

## Quick start

```bash
# 1. Configure env (copy the template, then edit values)
cp .env.example .env

# 2. Install deps
bun install

# 3. Run the dev server
bun run dev          # http://localhost:3000

# 4. Open the dashboard.
```

The dev server runs on port **3000**. Set your bearer token in the dashboard
header (`Set API token`). In the default `server_token` mode this is the
`VERIFY_TOKEN` value from `.env` — the example value is
`change-me-to-a-long-random-string`; replace it for any non-dev use.

---

## Environment variables

Copy `.env.example` to `.env` and adjust. None of these are committed.

| Var | Required | Default | Description |
| --- | --- | --- | --- |
| `AUTH_MODE` | ❌ | `server_token` | `server_token` (bearer must equal `VERIFY_TOKEN`) or `github_passthrough` (bearer is a GitHub PAT, validated against the GitHub API). |
| `VERIFY_TOKEN` | ✅ (server_token) | — | Bearer token clients send as `Authorization: Bearer <token>`. Required in `server_token` mode; ignored in `github_passthrough`. |
| `GITHUB_TOKEN` | ❌ | — | Used to clone **private** repos in `server_token` mode. Not needed in `github_passthrough` (the per-request PAT is used). Never logged. |
| `ALLOWED_REPOS` | ✅ | — | Comma-separated `owner/repo` allowlist, e.g. `0xheycat/Purr-github-MCP,0xheycat/Purrliquid`. Set to `*` / empty / unset, or `ALLOW_ALL_REPOS=true`, for unrestricted mode (any repo matching the safe slug regex). |
| `ALLOW_ALL_REPOS` | ❌ | `false` | Force unrestricted mode regardless of `ALLOWED_REPOS`. |
| `WORKDIR_BASE` | ❌ | `.verify-workspaces` | Base dir for fresh per-job workspaces. |
| `MAX_LOG_BYTES` | ❌ | `500000` | Max captured stdout/stderr per command (bytes). |
| `COMMAND_TIMEOUT_MS` | ❌ | `600000` (10m) | Per-command timeout. |
| `JOB_TIMEOUT_MS` | ❌ | `1800000` (30m) | Per-job overall timeout. |
| `MAX_CONCURRENT_JOBS` | ❌ | `1` | Max jobs running at once (extras queue). |
| `CLEANUP_AFTER_MS` | ❌ | `3600000` (1h) | Reserved auto-cleanup hint. |

### Authentication modes

**`server_token`** (default) — the bearer token must equal `VERIFY_TOKEN`
(constant-time compare). Cloning private repos uses the server's `GITHUB_TOKEN`
if set. Good for stable, single-tenant deployments.

**`github_passthrough`** — the bearer token is a GitHub PAT. The server
validates it by calling `GET https://api.github.com/user`; on HTTP 200 the
request is authenticated and the **same** PAT is used to clone private repos
via an `x-access-token:` clone URL. This lets MCP clients paste a GitHub PAT
directly as the bearer, with no `GITHUB_TOKEN` in env. Validation results are
cached for 5 minutes (keyed by token hash, so the raw token is never stored).

The active `authMode` and `githubTokenSource` (`bearer` / `env` / `none`) are
exposed by `GET /api/health` and `GET /api/smoke` — never the token value.

---

## REST API

All endpoints except `GET /api/health` require `Authorization: Bearer <VERIFY_TOKEN>`.

### `GET /api/health`  (public)

```json
{
  "status": "ok",
  "service": "purr-verify-mcp",
  "time": "2026-07-01T20:45:46.054Z",
  "activeJobs": 0,
  "queuedJobs": 0,
  "totalJobs": 0,
  "version": "1.0.0",
  "allowedRepos": ["0xheycat/Purr-github-MCP", "0xheycat/Purrliquid"],
  "configured": true
}
```

### `POST /api/verify`  (auth)

Create a verification job. Runs **asynchronously**; returns immediately.

```jsonc
// Request
{
  "repo": "0xheycat/Purrliquid",
  "ref": "feat/auto-1-scheduler",
  "expected_head": "f067361",
  "commands": [
    "bun install",
    "bunx prisma generate",
    "bun run ci:check",
    "bun test",
    "bun test scripts/__tests__/auto-1-scheduler.test.ts",
    "ENV_MODE=mock bun run scripts/manage.ts --duration=8 --poll-interval=30 --manage-interval=60 --heartbeat-interval=5",
    "cat reports/agent-loop-report.json"
  ],
  "continue_on_error": false,
  "metadata": { "pr": 1, "purpose": "AUTO-1 live verification" }
}

// Response (202)
{
  "jobId": "c3a472cf-a1e1-45d9-b986-e699f7db5b04",
  "status": "queued",
  "statusUrl": "/api/verify/c3a472cf-a1e1-45d9-b986-e699f7db5b04"
}
```

Behavior:
- Validates the repo is in `ALLOWED_REPOS` and every command matches the allowlist.
- Clones fresh: `git clone --depth=1 --branch <ref> https://github.com/<repo>.git <workdir>`
  (uses `https://x-access-token:<GITHUB_TOKEN>@…` for private repos when `GITHUB_TOKEN` is set).
- If `expected_head` is provided, verifies `git rev-parse HEAD` starts with it (short) or matches exactly (full SHA).
- Runs commands sequentially. Stops on first non-zero exit unless `continue_on_error: true`.
- Captures stdout/stderr per command (redacted, size-capped), exit code, start/end time.
- Cleans up the workspace on success, failure, timeout, and cancel.

### `GET /api/verify/:jobId`  (auth)

Full job result (see the `Job` shape below). Use `?format=markdown` for a
PR-comment-ready summary:

```
GET /api/verify/<jobId>?format=markdown  ->  { "jobId": "...", "markdown": "## Verification\n..." }
```

### `POST /api/verify/:jobId/cancel`  (auth)

Request cancellation of a running or queued job. Returns
`{ jobId, canceled, status }`.

### `GET /api/jobs?limit=50`  (auth)

List recent jobs (most recent first).

### `GET /api/smoke`  (auth)

Diagnostics: config readiness, allowlist patterns, and sample command
validations. Does **not** execute anything.

### `GET /api/verify`  (auth)

Alias of `GET /api/jobs`.

---

## MCP endpoint — `POST /mcp`

JSON-RPC 2.0. `initialize` and `tools/list` are open; `tools/call` requires the
bearer token.

### Methods

- `initialize` → `{ protocolVersion, capabilities, serverInfo }`
- `tools/list` → `{ tools: [...] }`
- `tools/call` → `{ name, arguments }` → `{ content: [{type:"text", text}], isError }`

### Tools

| Tool | Annotations (readOnly / destructive / idempotent) |
| --- | --- |
| `create_verification_job` | `false / false / false` |
| `get_verification_job` | `true / false / true` |
| `list_verification_jobs` | `true / false / true` |
| `cancel_verification_job` | `false / true / false` |
| `health_check` | `true / false / true` |

---

## Sample curl commands

```bash
TOKEN="your-VERIFY_TOKEN-or-github-PAT"

# Health (public)
curl http://localhost:3000/api/health

# Smoke / diagnostics
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/smoke

# Create a verification job
curl -X POST http://localhost:3000/api/verify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"0xheycat/Purr-github-MCP","ref":"main",
       "commands":["bun install","bun test"]}'

# Poll a job
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/verify/<jobId>

# PR-ready markdown
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/verify/<jobId>?format=markdown"

# Cancel
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/verify/<jobId>/cancel

# List recent jobs
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/jobs
```

### MCP examples

```bash
# initialize
curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# tools/list
curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# tools/call — create_verification_job (auth required)
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"create_verification_job",
                 "arguments":{"repo":"0xheycat/Purr-github-MCP","ref":"main",
                              "commands":["bun install","bun test"]}}}'

# tools/call — health_check
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call",
       "params":{"name":"health_check","arguments":{}}}'
```

---

## Command allowlist

Only these grammars are accepted (matched as full-command regexes):

```
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
node <safe relative path>
cat reports/<file>.json
cat reports/<file>.txt
ENV_MODE=mock bun run scripts/manage.ts <safe flags>
```

Safe flags (for the manage script) only allow:
`--duration=<n>`, `--poll-interval=<n>`, `--manage-interval=<n>`,
`--heartbeat-interval=<n>`, `--mode=<word>`, `--iterations=<n>`,
`--interval=<n>`, `--execute=false`.

**Rejected everywhere:** `; && || | > < \` $() .. \ " '` absolute paths,
`curl`, `wget`, `rm`, `mv`, `cp` (outside workdir), `sudo`, `chmod`, `chown`,
`ssh`, `scp`, `docker`, `powershell`, `nc`, `mkfs`, `dd`.

`cat reports/<file>` is executed by reading the file directly (no `cat`
process), which is safer and avoids path issues.

---

## Security model

- **Bearer auth** on every mutating/reading endpoint. In `server_token` mode
  the bearer must equal `VERIFY_TOKEN` (constant-time compare). In
  `github_passthrough` mode the bearer is a GitHub PAT validated live against
  the GitHub API.
- **Repo allowlist** — only `owner/repo` entries in `ALLOWED_REPOS`, or
  unrestricted mode (`*` / empty / `ALLOW_ALL_REPOS=true`) which still enforces
  the safe slug regex and github.com-only cloning.
- **Command allowlist** — no arbitrary shell. `spawn(..., { shell: false })`.
- **Fresh workspace** per job under `WORKDIR_BASE/<jobId>-<rand>`.
- **Always cleanup** the workspace in a `finally` block (success, failure,
  timeout, cancel).
- **Timeouts**: per-command (`COMMAND_TIMEOUT_MS`) and per-job
  (`JOB_TIMEOUT_MS`). Both kill the child process.
- **Log caps**: `MAX_LOG_BYTES` per command stream; oversized output is
  truncated and flagged `truncated: true`.
- **Secret redaction**: the `GITHUB_TOKEN`, `VERIFY_TOKEN`, GitHub PAT patterns
  (`gh[pousr]_…`, `github_pat_…`), `x-access-token:…@` URL creds,
  `Authorization: Bearer …`, and common `password=/secret=/api_key=`
  assignments are scrubbed from all captured logs and error messages. The
  clone URL (which may embed the token) is never printed. The per-request PAT
  in `github_passthrough` mode lives only in memory and is nulled after the
  job completes — it is never persisted to disk.
- **Concurrency cap** via `MAX_CONCURRENT_JOBS`; excess jobs queue.

---

## Job result shape

```jsonc
{
  "jobId": "c3a472cf-…",
  "repo": "0xheycat/Purr-github-MCP",
  "ref": "main",
  "expected_head": "f067361",
  "actual_head": "f067361abc…",
  "status": "success|failed|running|queued|canceled|timeout",
  "startedAt": "2026-07-01T20:51:39.689Z",
  "finishedAt": "2026-07-01T20:51:40.759Z",
  "durationMs": 1070,
  "continue_on_error": false,
  "metadata": { "pr": 1, "purpose": "AUTO-1 live verification" },
  "error": null,
  "cleanupStatus": "done",
  "commands": [
    {
      "command": "bun test",
      "status": "success|failed|timeout|skipped|running|pending",
      "exitCode": 0,
      "durationMs": 48,
      "stdout": "…",
      "stderr": "…",
      "startedAt": "…",
      "finishedAt": "…",
      "truncated": false
    }
  ],
  "summary": { "passed": true, "failedCommand": null }
}
```

---

## Dashboard (`/`)

- Header with live health badge + active/queued counts.
- **Set API token** dialog (stored in `localStorage`, sent as `Bearer`).
- Submit form: repo (from allowlist), ref, expected head, commands (one per
  line, with quick-add chips), `continue_on_error`, PR/purpose metadata.
- Jobs table with status badges, exit codes, durations, per-row View / Copy-MD
  / Cancel. Auto-polls while jobs are active.
- Job detail view (`?job=<id>`): summary stats, collapsible command logs
  (stdout/stderr), copy-as-Markdown, raw JSON, cancel.
- Sticky footer.

---

## Limitations (MVP)

- Job state is held **in memory** with best-effort JSON persistence to
  `.verify-data/jobs/`. On a server restart, in-flight (running/queued) jobs
  are marked `failed` with an interruption note; finished jobs are reloaded.
- In Next.js **dev** mode, hot-reload of server modules resets in-memory state
  (finished jobs are reloaded from disk on next request). Production (`next
  start`) holds state for the process lifetime.
- `MAX_CONCURRENT_JOBS=1` by default — jobs run one at a time, others queue.
- `GITHUB_TOKEN` is needed for private repos (e.g. `0xheycat/Purrliquid`).
  Public repos (e.g. `0xheycat/Purr-github-MCP`) work without it.
- No database is required for the MVP.

---

## Project layout

```
src/
  app/
    page.tsx                     # Dashboard (single user-visible route)
    layout.tsx                   # Metadata + toasters
    mcp/route.ts                 # POST /mcp JSON-RPC
    api/
      health/route.ts            # GET /api/health (public)
      verify/route.ts            # POST /api/verify, GET (alias /api/jobs)
      verify/[jobId]/route.ts    # GET job (+ ?format=markdown)
      verify/[jobId]/cancel/     # POST cancel
      jobs/route.ts              # GET /api/jobs
      smoke/route.ts             # GET diagnostics
  lib/verify/
    config.ts                    # env config + repo/ref/head validators
    auth.ts                      # bearer auth helpers
    allowlist.ts                 # command allowlist validator
    parse.ts                     # validated command -> safe spawn args
    redact.ts                    # secret redaction
    store.ts                     # in-memory + JSON file job store
    executor.ts                  # clone, run, capture, timeout, cleanup
    mcp.ts                       # JSON-RPC handler + tool defs
    markdown.ts                  # PR-comment markdown generator
    client.ts                    # browser API client
    types.ts                     # shared types
  components/verify/             # dashboard UI components
```
