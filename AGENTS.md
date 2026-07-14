# AGENTS.md

## Scope

These instructions apply to agents working in this repository and to any ChatGPT/Codex-style workflow that uses this MCP server.

## Role of this server

Purr Verify MCP is for runtime verification only:

- clone an allowlisted GitHub repo/ref in an isolated workspace
- run allowlisted install/build/lint/typecheck/test commands
- return bounded logs and job status
- never edit repository files
- never replace GitHub MCP for repo/PR/file operations
- use Notion only for specs, plans, and project context

## Startup protocol

Before verification work:

1. Call `read_operating_guide`.
2. Call `health_check`.
3. Call `list_allowed_commands`.
4. Confirm the target `repo`, `ref`, and command list.
5. Use `create_verification_job` with `mode: "async"` for install/build/lint/typecheck/test.
6. Poll `get_verification_job` until terminal status.

## Hard rules

- Never run heavy commands in sync mode.
- Heavy commands include install, build, lint, typecheck, test, Prisma generate, Playwright, Cypress, Vitest, Jest, and any long-running CI command.
- Use sync mode only for a short single smoke command that is expected to finish quickly.
- Retry transient read-only MCP transport errors, timeouts, HTTP 429, and HTTP 5xx at most five times in the current run with backoff of 2, 4, 8, 16, and 32 seconds. Use the official GitHub MCP as a read-only fallback when it is available and appropriate.
- Do not submit an identical failed verification job repeatedly. Record the jobId, failing command, status, and failure summary; the next scheduled run must fix the source or test before creating a new job.
- If Verify MCP remains unavailable during the current run, leave verification pending and end only that bounded run gracefully. After two consecutive scheduled turns without Verify MCP, record `VERIFY_SKIPPED`; an implementation commit may proceed with explicit unverified evidence.
- Never disable, pause, or terminate a recurring schedule because Verify MCP is unavailable or a verification job failed. The next scheduled run must resume from fresh repository state.
- Summarize logs by default; provide full logs only when the user asks.
- Do not use this server to mutate GitHub state.

## Preferred workflow

1. Bootstrap: `read_operating_guide`, `health_check`, `list_allowed_commands`.
2. Queue: `create_verification_job` with `mode: "async"`.
3. Poll: `get_verification_job` until `success`, `failed`, `canceled`, or timeout.
4. Report: summarize command results, failed step, relevant log tail, and next action.
