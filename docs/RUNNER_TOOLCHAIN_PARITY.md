# Runner Toolchain Parity Runbook

This runbook verifies the runner-side fix for false-negative build/test failures caused by dependency resolution or mismatched Node/Bun toolchains.

## What Changed

- Each job detects the cloned repo's declared toolchain from `.nvmrc`, `.node-version`, `.tool-versions`, `.bun-version`, and `package.json` (`volta`, `packageManager`, `engines`).
- The job PATH is prefixed with the selected Node/Bun binaries before install, build, and test commands run.
- `bun install` is promoted to `bun install --frozen-lockfile` when `bun.lock` or `bun.lockb` exists.
- Job results include additive diagnostics:
  - `toolchain.declared`
  - `toolchain.nodeVersion`
  - `toolchain.bunVersion`
  - `toolchain.warnings`
  - `installStrategies`
  - per-command `effectiveCommand`
  - optional `resolutionProbe`
- `health_check` and `/api/health` include `toolchainCacheRoot`.

## Local Self-Test

```bash
bun install --frozen-lockfile
bun run selftest:runner
bun run typecheck
bun run lint
bun run build
```

Expected:

- `selftest:runner` reports `ok: true`.
- `bun install` is reported as `effectiveCommand: "bun install --frozen-lockfile"`.
- `lockfileHonored: true`.

## Deploy Health Check

After deploy:

```bash
curl https://verify.pursr.xyz/api/health
```

Expected:

- `workspaceRoot` is under the OS temp directory, for example `/tmp/purr-verify-workspaces`.
- `toolchainCacheRoot` is under a writable temp/cache directory, for example `/tmp/purr-verify-toolchains`.
- `nodeVersion` and `bunVersion` describe the server process only. Per-job effective versions are reported on each job as `toolchain.nodeVersion` and `toolchain.bunVersion`.

## Calibration Job

Use async mode for heavy jobs because sync mode can exceed the MCP transport window.

```json
{
  "repo": "0xheycat/Purrliquid",
  "ref": "pre-launch",
  "expected_head": "399d150",
  "commands": [
    "bun install",
    "bunx prisma generate",
    "bun run ci:check",
    "bun test"
  ],
  "continue_on_error": true,
  "mode": "async",
  "resolution_probe": ["@solana/web3.js", "next", "prisma"]
}
```

Poll with `get_verification_job` until terminal.

Expected:

- `toolchain.nodeVersion` and `toolchain.bunVersion` match the repo's declared versions.
- First command keeps `command: "bun install"` but reports `effectiveCommand: "bun install --frozen-lockfile"`.
- `installStrategies[0].lockfileHonored` is `true`.
- `resolutionProbe` does not show unexpected CJS entries for ESM-only imports.
- `bun run ci:check` succeeds.
- `bun test` succeeds with `0` fail and `0` load errors.

## OPS-1c Regression Job

```json
{
  "repo": "0xheycat/Purrliquid",
  "ref": "feat/ops-1c-control",
  "expected_head": "8b16fc4c198da152bfcaff47a45b53e9a8c6cbd2",
  "commands": [
    "bun install",
    "bunx prisma generate",
    "bun run ci:check",
    "bun test"
  ],
  "continue_on_error": true,
  "mode": "async",
  "resolution_probe": ["@solana/web3.js", "next", "prisma"]
}
```

Expected:

- Same parity diagnostics as calibration.
- OPS-1c tests remain green.
- Build/test failures, if any, include full Node source maps and uncaught stack traces via runner-provided diagnostics env.

## Notes

- The repo under test is never modified.
- Caller-provided `PATH`, `NODE_PATH`, and `NODE_OPTIONS` remain blocked.
- The runner may set its own clean `PATH` and build diagnostics `NODE_OPTIONS`; inherited host values are still stripped.
- `bunx` is executed as `bun x` internally so downloaded Bun archives do not require a separate `bunx` shim.
- Package manager caches for job commands are redirected into the per-job workspace (`.purr-cache`) so dependency artifacts are removed with the workspace cleanup.
