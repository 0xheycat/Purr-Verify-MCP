# Runner Toolchain Parity Runbook

This runbook verifies the runner-side fix for false-negative build/test failures caused by dependency resolution or mismatched Node/Bun toolchains.

## What Changed

- Each job detects the cloned repo's declared toolchain from `.nvmrc`, `.node-version`, `.tool-versions`, `.bun-version`, and `package.json` (`volta`, `packageManager`, `engines`).
- If a repo does not declare exact versions, the runner can use global defaults from `TOOLCHAIN_DEFAULT_NODE` and `TOOLCHAIN_DEFAULT_BUN`.
- The job PATH is prefixed with the selected Node/Bun binaries before install, build, and test commands run.
- `bun install` is promoted to `bun install --frozen-lockfile` when `bun.lock` or `bun.lockb` exists.
- Command cancellation and command/job timeouts terminate the whole process group so nested build/test children do not keep running.
- Job results include additive diagnostics:
  - `toolchain.declared`
  - `toolchain.nodeVersion`
  - `toolchain.bunVersion`
  - `toolchain.warnings`
  - `toolchain.recommendations`
  - `toolchain.defaults`
  - `installStrategies`
  - per-command `effectiveCommand`
  - optional `resolutionProbe` with CommonJS `require`, ESM dynamic `import`, and static named import checks when available
  - `runnerRecommendations`
- `health_check` and `/api/health` include `toolchainCacheRoot`, `toolchainDefaultNode`, and `toolchainDefaultBun`.

## Recommended Runner Defaults

Set global fallbacks on public runners so repos without exact toolchain metadata do not silently fall back to the host process:

```bash
TOOLCHAIN_DEFAULT_NODE=26.3.0
TOOLCHAIN_DEFAULT_BUN=1.3.14
COMMAND_TIMEOUT_MS=1800000
JOB_TIMEOUT_MS=7200000
```

These are fallbacks only. The best result is still for each repo to commit exact declarations and lockfiles.

## Preferred Heavy-Repo Workflow

For large Next.js or full-stack repos, split checks instead of hiding everything behind one project script:

```json
{
  "commands": [
    "bun install",
    "bunx prisma generate",
    "bun run typecheck",
    "bun run lint",
    "bun run build",
    "bun test"
  ],
  "continue_on_error": true,
  "mode": "async"
}
```

This gives agents separate logs and timings for install, codegen, typecheck, lint, build, and tests. `bun run ci:check` remains supported, but jobs will recommend splitting it for long-running repos.

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
- `toolchainDefaultNode` and `toolchainDefaultBun` are populated when global fallbacks are configured.
- `commandTimeoutMs` is high enough for heavy single commands, for example `1800000`.
- `jobTimeoutMs` is high enough for install + build + full tests, for example `7200000`.
- `nodeVersion` and `bunVersion` describe the server process only. Per-job effective versions are reported on each job as `toolchain.nodeVersion` and `toolchain.bunVersion`.

## Toolchain Cache Cleanup

Do not prune `toolchainCacheRoot` while verification jobs are active or queued. Long builds may spawn nested Node workers after the top-level command starts; deleting the selected Node/Bun directory mid-command can make otherwise valid builds fail with `spawn .../node ENOENT`.

The runner refreshes the selected toolchain directory timestamp whenever a job uses it. External cleanup jobs should still follow both rules:

- Check `/api/health` first and skip toolchain cleanup unless `activeJobs + queuedJobs == 0`.
- Use an age threshold on the toolchain install directory itself, not the archive timestamp inside it.

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
- `runnerRecommendations` is empty or only contains accepted repo-maintenance advice. If it recommends adding `.nvmrc`, `packageManager`, or a lockfile, update the repo so future agents get reproducible live verification.
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
- Package manager caches for job commands are redirected to a sibling temp cache outside the cloned repo so `eslint .`, tests, and build tooling never scan runner cache files. The cache is removed with the workspace cleanup.
- Repos should keep dependencies current in their own lockfile. The runner will not mutate tested repos, but it will surface reproducibility recommendations when package-manager or lockfile metadata is missing or ambiguous.
