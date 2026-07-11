# Purr Verify MCP Public Architecture

## Status

Architecture freeze for the hosted public edition. This document defines the target boundary; it does not declare the current runtime production-ready.

## Product modes

### Hosted public mode

- Any developer may create an account through GitHub.
- GitHub App installations grant repository-scoped access.
- MCP clients authenticate with Purr Verify OAuth access tokens.
- Jobs, secrets, usage, installations, and audit events are tenant-owned.
- Repository code executes only in disposable isolated workers.
- PostgreSQL is the source of truth; Redis coordinates queues and live events; object storage retains large logs and artifacts.

### Legacy self-hosted mode

- Existing `server_token`, `VERIFY_TOKEN`, `ALLOWED_REPOS`, and optional server `GITHUB_TOKEN` remain supported.
- Single-owner file persistence may remain available for local/self-hosted deployments.
- Legacy mode must be explicitly selected and must never be used as the hosted multi-tenant backend.

## Trust boundaries

1. **Browser/session boundary** — the dashboard uses an HttpOnly, Secure, SameSite=Lax session cookie. No user token is stored in localStorage.
2. **MCP authorization boundary** — MCP tokens are audience-bound to the configured MCP resource and are never reused as GitHub credentials.
3. **GitHub boundary** — private repository access uses short-lived installation access tokens minted just in time and restricted to the selected repository.
4. **Control-plane boundary** — Next.js/API services own identity, authorization, policy, orchestration, and metadata. They never execute repository commands.
5. **Worker boundary** — workers receive a bounded job specification and temporary credentials, run non-root in an isolated sandbox, upload results, and destroy the workspace.
6. **Secret boundary** — encrypted secret values are resolved server-side and injected only into authorized steps. MCP tools expose secret names, never values.

## Control plane

Responsibilities:

- GitHub login and installation lifecycle
- OAuth 2.1 authorization server for MCP clients
- repository authorization and tenant ownership checks
- workflow validation and job creation
- queue orchestration, cancellation, usage accounting, and audit logging
- dashboard, repository picker, environment management, and share links

The control plane must not mount worker workspaces, expose a host container socket, or inherit user job environment variables.

## Worker plane

Workers perform clone, install, build, test, artifact collection, and cleanup. Minimum isolation contract:

- non-root process
- no privileged mode or host Docker socket
- no control-plane filesystem mount
- no cloud metadata endpoint
- no private-network access by default
- bounded CPU, memory, disk, process count, output size, and runtime
- workspace and temporary credentials destroyed after terminal state

Developer commands are restricted by the sandbox boundary rather than a narrow host-command allowlist.

## Hosted request flow

```text
GitHub login -> user session -> installation selection -> repository authorization
MCP OAuth -> consent -> audience-bound Purr Verify token
create job -> ownership/quota validation -> queue -> isolated worker
worker -> JIT GitHub installation token -> clone -> remove token -> run workflow
worker -> logs/artifacts -> object storage -> terminal job event -> cleanup
```

## Required services

- PostgreSQL: identities, tenancy, OAuth state, jobs, metadata, usage, audit
- Redis: queue, locks, rate limits, live event fan-out
- Object storage: logs, test reports, coverage, build artifacts
- Worker runtime: container or microVM implementation satisfying `RUNNER_ISOLATION.md`

## Non-goals for initial public launch

- anonymous compute
- arbitrary access to user GitHub credentials
- organization billing and marketplace integration
- privileged Docker-in-Docker builds
- persistent mutable build machines
- returning secret values through REST or MCP

## Launch dependency order

1. Multi-tenant persistence and ownership enforcement
2. GitHub App identity and repository authorization
3. MCP OAuth 2.1 with persistent one-time grants and refresh rotation
4. Separate disposable worker runtime
5. Workflow engine and secret vault
6. Public dashboard and launch security validation

No hosted public traffic may be enabled before steps 1–4 pass their acceptance gates.