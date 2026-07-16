# Long-Run Operations

Purr Verify is not a general shell, but long verification is a first-class developer workflow. Smoke, soak, fork, and live-observation jobs may run for 8–9 hours when the operator explicitly enables `long_run` and supplies timeout values within the server cap.

The operational command grammar stays narrow and predictable without weakening valid developer work:

- `git clone https://github.com/txtx/surfpool.git` and `git clone https://github.com/solana-foundation/surfpool.git` are domain and repo locked. In production, prefer the baked `surfpool` binary and skip clone.
- `cargo surfpool-install` is accepted as that exact cargo subcommand.
- `rustup-init -y` is accepted for runner bootstrap when Rust is absent.
- `surfpool start` is handled as a detached background process. It does not require shell `&`, and the runner terminates its process tree during cleanup.
- `curl -s http://127.0.0.1:8899 -X POST --data-base64 <base64url-json>` is loopback only. The payload must decode to a JSON object under 8 KiB; the executor converts it to `curl -H "Content-Type: application/json" --data-binary <json>` without a shell.
- `curl -s http://127.0.0.1:8899` is loopback only and exists as a local RPC smoke check.
- `bun run scripts/<script>.ts <safe --key=value args>` is restricted to the repo `scripts/` tree and safe flag values.
- `sleep <seconds>` supports long-run observation and is capped at 32,400 seconds, matching the current 9-hour operator timeout cap.

## Eight-to-nine-hour job

A 9-hour PurrLiquid smoke or soak job uses the existing execution capability directly:

```json
{
  "repo": "0xheycat/Purrliquid",
  "ref": "pre-launch",
  "mode": "async",
  "long_run": true,
  "command_timeout_ms": 32400000,
  "job_timeout_ms": 32400000,
  "commands": [
    "bun install --frozen-lockfile",
    "bun run scripts/live-smoke.ts --hours=9"
  ],
  "tags": ["purrliquid", "live-smoke", "nine-hour"]
}
```

The exact smoke script must already exist in the repository and match the allowed `scripts/` command grammar. Purr Verify does not silently shorten the job, convert it into a smaller test, or reject it merely because it runs for hours.

For a pure observation window after earlier commands:

```json
{
  "repo": "0xheycat/Purrliquid",
  "ref": "pre-launch",
  "mode": "async",
  "long_run": true,
  "command_timeout_ms": 32400000,
  "job_timeout_ms": 32400000,
  "commands": ["sleep 32400"]
}
```

Normal CI requests keep the configured default timeouts. Timeout overrides require `long_run=true`; the maximum operator-supported value is reported by `health_check.maxLongRunTimeoutMs`.

## Durable state during long runs

Queued and running jobs are never removed by terminal-history retention. The runner persists lifecycle checkpoints separately from the disposable workspace:

```text
queued
→ running progress
→ terminal result
→ cleanup evidence
```

A process restart may classify an interrupted in-flight job as failed, but the record itself remains durable and searchable instead of disappearing.

Use these tools while or after a long job:

- `get_verification_job` for the complete current job state.
- `get_verification_summary` for compact status and command evidence.
- `get_job_log_chunk` to read bounded stdout/stderr segments.
- `search_job_logs` to locate specific progress or failure text.
- `search_verification_history` and `get_latest_verification` after the workspace has been deleted.

Full stored evidence remains accessible. Summary and chunk tools reduce agent context usage; they do not reduce runner capability.

## Surfpool RPC

For a Surfpool RPC body, base64url-encode compact JSON before sending it:

```json
{"jsonrpc":"2.0","id":1,"method":"surfnet_setAccount","params":[]}
```

Then call:

```text
curl -s http://127.0.0.1:8899 -X POST --data-base64 <encoded-json>
```

`health_check` reports `runnerTools.surfpool`. Fork jobs should depend on `surfpool start` only when that field reports `available: true`.
