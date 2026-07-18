# Server Environment Alias Discovery

## Problem

Allowlisted server environment references let clients submit `@server:<alias>` without exposing the backing environment key or value. Agents still need a safe way to discover which aliases are configured before creating a verification or private operator job.

Without discovery, the only available probe is to submit a job and infer configuration from a validation failure. That creates unnecessary failed requests and makes credential-safe workflows harder to operate.

## Proposed capability

Add a read-only MCP tool:

```text
purr_list_server_env_aliases
```

The tool returns only:

- whether at least one alias is configured
- sorted public alias names
- explicit evidence that values and source environment keys are not included

It must not:

- return source environment key names
- return resolved values
- create a verification or operator job
- read a credential file
- persist any sensitive material
- require a project `cwd`

## Example response

```json
{
  "configured": true,
  "aliases": ["xlora_cookie_path"],
  "valuesIncluded": false,
  "sourceKeysIncluded": false
}
```

## Intended workflow

1. Operator configures an allowlisted mapping server-side.
2. Agent calls `purr_list_server_env_aliases`.
3. Agent supplies only `@server:<alias>` through `env` or `environmentOverrides`.
4. Existing server-side resolution injects the value into runtime memory only.
5. Durable job records, logs, and share links remain free of the backing key and value.

## Acceptance criteria

- Alias names are normalized and sorted.
- Malformed allowlist entries remain hidden.
- Duplicate aliases collapse to one public name.
- Empty configuration returns `configured: false` and an empty list.
- MCP annotations are read-only, non-destructive, and idempotent.
- Unit tests verify that neither source keys nor resolved values appear in the response.
