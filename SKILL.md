# Skill: Live code verification with Purr Verify MCP

**Name:** `purr-verify`
**Summary:** Run real builds/tests for a GitHub branch in an isolated runner and get trustworthy pass/fail logs — without a local sandbox, `node_modules`, or CI.

Use this skill whenever you have edited code (e.g. via a GitHub MCP) and need to *prove* it compiles and passes tests before reporting success or opening/merging a PR.

---

## When to use

Reach for Purr Verify when **any** of these is true:

- Your sandbox has no internet or dependencies and you can't run `bun install` / `bun test` yourself.
- GitHub Actions is unavailable, disabled, or billing-blocked.
- You need live evidence for a build, test suite, Prisma generate, or a project smoke script.
- You are about to claim a change is "verified" or "green" and want proof with logs.

**Do not** use it as a general shell. Only allowlisted commands run; anything else is rejected before the job starts.

---

## Setup

- **Transport:** MCP JSON-RPC at `POST /mcp` (methods: `initialize`, `tools/list`, `tools/call`), or REST under `/api`.
- **Auth:** `Authorization: Bearer <token>`.
  - `github_passthrough` mode → the token IS your GitHub PAT (used in-memory to clone private repos, never persisted).
  - `server_token` mode → the token is the server's `VERIFY_TOKEN`.
- `initialize` / `tools/list` are open; **every `tools/call` needs the bearer token.**

---

## Core loop

1. **Orient (once per session):** call `health_check` and `list_allowed_commands`.
   - Confirm `workspaceRoot` is under the OS temp dir (NOT `.next/...`) and `nodeVersion`/`bunVersion` are populated.
   - Confirm the commands you plan to run are in the allowlist.
2. **Choose a mode:**
   - Short/medium job (single install or quick test) → `mode: "sync"` for a one-call result.
   - Heavy job (install + build + full test suite) → `mode: "async"`, then poll `get_verification_job`.
3. **Create the job** with `create_verification_job`.
4. **Interpret:** treat `status: "success"` **and** `cleanupStatus: "done"` as verified. Otherwise read each command's `exitCode` / `stdout` / `stderr`.
5. **Report** per-command results back to the user. Never claim green without a successful job.

---

## Recipes

### Quick smoke (sync)

```json
{ "name": "create_verification_job", "arguments": {
  "repo": "owner/repo", "ref": "main", "mode": "sync",
  "commands": ["bun install"] } }
```

### Full verification of a Prisma + Bun project (async)

```json
{ "name": "create_verification_job", "arguments": {
  "repo": "owner/repo", "ref": "feature-branch", "mode": "async",
  "expected_head": "399d150",
  "commands": ["bun install", "bunx prisma generate", "bun run ci:check", "bun test"],
  "continue_on_error": false } }
```

Then poll:

```json
{ "name": "get_verification_job", "arguments": { "jobId": "<jobId>" } }
```

### Verification that needs env vars / secrets

```json
{ "name": "create_verification_job", "arguments": {
  "repo": "owner/repo", "ref": "main",
  "commands": ["bun install", "bun test"],
  "env": { "APP_BASE_URL": "https://staging.example.com", "SOME_TOKEN": "…" } } }
```

`env` values are injected into every command, redacted from all output, and never persisted. Reserved keys (`PATH`, `NODE_PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`) are rejected.

### Share a result (read-only)

```json
{ "name": "create_share_link", "arguments": { "jobId": "<jobId>", "ttlHours": 24, "note": "PR review" } }
```

---

## Rules & guardrails

- **Only allowlisted commands.** If unsure, call `list_allowed_commands` first. Never send shell metacharacters, absolute paths, or arbitrary git URLs.
- **Order matters.** For Prisma projects, run `bunx prisma generate` after `bun install` and before build/test.
- **Prefer async for heavy jobs.** Sync calls are bounded by the ~60s MCP transport window even though the job keeps running server-side.
- **`repo` is `owner/repo` only.** Cloning is always from `https://github.com/<owner>/<repo>.git`.
- **Verification, not modification.** This runner clones and runs checks; it does not push commits. Use your GitHub MCP for edits/PRs.
- **Report honestly.** If a job fails, surface the failing command and its logs rather than guessing.

---

## Interpreting results

| Field | Meaning |
|---|---|
| `status` | Terminal job status: `success` / `failed` / `canceled` / `error` |
| `cleanupStatus` | `done` means the workspace was cleaned up |
| `commands[].exitCode` | `0` = that command passed |
| `commands[].stdout` / `stderr` | Captured, secret-redacted logs (capped by `MAX_LOG_BYTES`) |
| `expected_head` mismatch | The checked-out HEAD didn't match the SHA you asserted — investigate before trusting results |

**Verified =** `status: "success"` and `cleanupStatus: "done"` and every command `exitCode: 0`.
