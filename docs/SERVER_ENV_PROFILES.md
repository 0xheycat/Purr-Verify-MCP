# Global Server Environment Profiles

## Purpose

Server environment profiles provide a reusable, project-agnostic way to run real verification and private developer operations that require runtime configuration.

The client sends only a public profile label. Verify MCP expands the profile on the server, resolves any allowlisted `@server:<alias>` references in memory, and injects the resulting environment into the job process. Profile contents and resolved values do not enter the MCP request, durable job record, logs, snapshots, or share links.

This is a normal execution capability, not a command-shell bypass.

## Supported execution surfaces

The shared resolver works with:

- `create_verification_job` through `env`
- `purr_run_command` through `environmentOverrides`
- `purr_verify_project` through `environmentOverrides`
- `purr_deploy_project` through `environmentOverrides`

It is independent of language and framework. Profiles can support Node, Bun, Python, Rust, Go, Docker, Solana or Surfpool, database migrations, external services, or any project whose process reads environment variables.

## Server configuration

Backing values remain ordinary server environment variables. Public aliases map to those backing variables:

```dotenv
VERIFY_SERVER_ENV_REF_ALLOWLIST=runtime_value=VERIFY_RUNTIME_VALUE,network_endpoint=VERIFY_NETWORK_ENDPOINT
```

Profiles are configured as a JSON object. Values may be plain strings or an allowlisted server reference:

```json
{
  "shared_node_ci": {
    "NODE_ENV": "test",
    "CI": "true"
  },
  "purrliquid_observability_smoke": {
    "PURR_ENV": "fork",
    "PURR_LLM_ENABLED": "true",
    "PURR_LLM_PROVIDER": "custom",
    "PURR_RUNTIME_VALUE": "@server:runtime_value",
    "SURFPOOL_DATASOURCE_RPC_URL": "@server:network_endpoint"
  },
  "python_release": {
    "PYTHONUNBUFFERED": "1",
    "PACKAGE_RUNTIME_VALUE": "@server:runtime_value"
  }
}
```

Store that JSON in `VERIFY_SERVER_ENV_PROFILES` using the service manager's normal environment mechanism.

## Discovery

Agents can discover available public labels without creating a job:

```text
purr_list_server_env_profiles
```

The response contains only sorted profile labels, safe configuration diagnostics, and explicit evidence that environment keys and values are omitted. Malformed unselected entries are observable but do not block valid profiles or unrelated jobs.

## Client usage

Disposable repository verification:

```json
{
  "repo": "owner/project",
  "ref": "feature/test",
  "commands": ["bun test"],
  "env": {
    "VERIFY_SERVER_ENV_PROFILE": "shared_node_ci"
  }
}
```

Private local verification:

```json
{
  "cwd": "/srv/project",
  "verifyCommands": ["bun test", "bun run typecheck"],
  "environmentOverrides": {
    "VERIFY_SERVER_ENV_PROFILE": "shared_node_ci"
  }
}
```

A caller may add non-conflicting explicit values beside the selector. Explicit values cannot silently replace a profile-owned key; a conflict is reported before execution so the operator can choose one source deliberately.

## Professional default behavior

Profiles do not introduce a general workflow gate.

- Jobs without a selected profile behave exactly as before.
- Malformed unselected entries produce discovery diagnostics and are ignored.
- Valid profiles remain usable even when other entries are malformed.
- Existing direct `env`, `environmentOverrides`, and `@server:<alias>` workflows remain supported.
- Environment limits are configurable with `VERIFY_ENV_MAX_KEYS` and `VERIFY_ENV_MAX_VALUE_LENGTH`.

A selected job stops before execution only when continuing would create a misleading or unsafe runtime:

- selected profile does not exist
- required backing alias is missing or unavailable
- explicit environment conflicts with a profile-owned key
- a profile targets loader-sensitive reserved variables such as `PATH`, `NODE_OPTIONS`, or `LD_PRELOAD`

These checks are scoped to the selected job. They do not pause schedules, block unrelated repositories, disable Verify MCP, or prevent non-profile workflows.

## Runtime and evidence lifecycle

1. Client sends a public profile label.
2. Server expands the profile in memory.
3. Server references resolve from server environment values.
4. The selector is removed before the child process starts.
5. Runtime logs are redacted using resolved values.
6. Runtime environment state is cleared after completion.
7. Durable evidence contains commands and results, but not profile contents or resolved values.
