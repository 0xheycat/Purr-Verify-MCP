# Private Developer Operations

Purr Verify MCP supports private developer operations without reducing the existing verification surface. Project discovery, inspection, environment inventory, deployment planning, durable operator jobs, and managed Pursr browser work sessions share the same private control plane.

## Phase-one tools

- `purr_discover_projects`
- `purr_inspect_project`
- `purr_inspect_runtime`
- `purr_inspect_environment`
- `purr_plan_deployment`

All five tools use the existing `verify:read` scope. They do not edit source, install dependencies, restart services, deploy, or roll back releases.

## Project locations

Discovery defaults to `/opt`, `/srv`, `/var/www`, `/home`, and `/root`. Operators may set `PURR_OPERATOR_ROOTS` or pass explicit absolute roots. A directly supplied absolute `cwd` is canonicalized with `realpath`; the requested path, canonical path, and symlink state remain visible.

Detected project markers include Git, Node, Rust, Python, Go, Docker Compose, and PM2 ecosystem files. Node package managers are inferred from lockfiles or `packageManager`; legacy `package.json` projects default to npm.

## Runtime inspection

Runtime inspection reports installed Node package managers and matches project services across PM2, systemd, Docker Compose, and `/proc` process working directories. It records service identity and state without returning environment values.

## Environment inspection

Supported sources are dotenv files, PM2, systemd, Docker Compose, and matching process environments. Default output contains key names, source locations, and present state only.

`revealValues: true` requires an explicit key list with at most 20 unique valid names. Only those requested values are returned. The response is marked sensitive and values are not written to verification history, deployment plans, snapshots, or logs.

## Deployment planning

`purr_plan_deployment` creates a plan but performs no mutation. The plan includes canonical project identity, Git state, package manager, monorepo state, suggested install/verify/build commands, detected service manager, environment gaps, health checks, snapshot fields, rollback strategy, risk classification, and a deterministic same-project lock key.

The existing durable job engine is reused for generic commands, snapshots, deploy, restart, health checks, rollback, cancellation, and logs. Existing Verify tools and long-run capability remain available.

## Pursr browser work sessions

Verify MCP integrates the published `pursr` npm package as a capability provider rather than rebuilding browser automation internally.

- `purr_browser_doctor` reports the Pursr version, `playwright-core` resolution, browser discovery, setup hints, and active work sessions.
- `purr_work_session_start` starts the project's real dev command, waits for HTTP readiness, and attaches a persistent Pursr session.
- Snapshot, act, screenshot, inspect, and diagnostics calls reuse that same browser state.
- Screenshots are returned as MCP image content and retained under the Verify data directory.
- `purr_work_session_close` closes the browser and terminates the managed dev-server process tree.

A missing Chrome-compatible browser is a recoverable setup condition. The default behavior keeps the dev server available and returns a warning; callers may opt into `browserRequired=true` when browser attachment is mandatory. Browser discovery honors `PURSR_BROWSER_PATH`, while startup readiness can be adjusted with `PURR_WORK_SESSION_STARTUP_TIMEOUT_MS`.

Browser work sessions are live process-local sessions, not durable verification jobs. Their artifacts remain on disk, but active browser state is intentionally not claimed to survive a Verify MCP service restart.
