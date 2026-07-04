# Long-Run Operations

Purr Verify is still not a general shell. Fork and soak jobs use a small
operational allowlist with explicit safety bounds:

- `git clone https://github.com/txtx/surfpool.git` is domain and repo locked.
- `cargo surfpool-install` is only accepted as that exact cargo subcommand.
- `rustup-init -y` is accepted for runner bootstrap when Rust is absent.
- `surfpool start` is handled by the runner as a detached background process;
  it never requires shell `&`, and the runner terminates it on job cleanup.
- `curl -s http://127.0.0.1:8899 -X POST --data-base64 <base64url-json>` is
  loopback only. The payload must decode to a JSON object under 8 KiB; the
  executor converts it to `curl -H "Content-Type: application/json"
  --data-binary <json>` without a shell.
- `bun run scripts/<script>.ts <safe --key=value args>` is restricted to the
  repo `scripts/` tree and alphanumeric/delimited flag values.
- `sleep <seconds>` is capped at 32400 seconds for long-run smoke tests.

Long jobs must opt in:

```json
{
  "repo": "0xheycat/Purrliquid",
  "ref": "pre-launch",
  "mode": "async",
  "long_run": true,
  "command_timeout_ms": 32400000,
  "job_timeout_ms": 32400000,
  "commands": ["sleep 10800"]
}
```

Normal CI requests keep the configured default timeouts. Timeout overrides are
rejected unless `long_run` is `true`, and the hard cap is reported by
`health_check` as `maxLongRunTimeoutMs`.

For a Surfpool RPC body, base64url-encode compact JSON before sending it:

```json
{"jsonrpc":"2.0","id":1,"method":"surfnet_setAccount","params":[]}
```

Then call:

```text
curl -s http://127.0.0.1:8899 -X POST --data-base64 <encoded-json>
```

Poll `get_verification_job` while the job is running. Command stdout/stderr are
persisted incrementally, so callers can tail progress without waiting for a
6-8 hour job to finish.
