# Hosted Public Edition Migration Plan

## Migration rule

Hosted mode is introduced alongside the legacy self-hosted mode. Do not silently reinterpret legacy tokens, JSON jobs, or global configuration as multi-tenant hosted records.

## Phase 0 — Architecture freeze

Deliver and approve the documents in this directory.

Gate:

- hosted and self-hosted boundaries are explicit
- auth, tenancy, persistence, and runner trust boundaries agree
- no public launch claim is made

## Phase 1 — Multi-tenant foundation

Implement:

- PostgreSQL migration framework and hosted configuration validation
- users, tenants, memberships, sessions, installations, repositories
- jobs and child records with mandatory tenant ownership
- repository/service interfaces separating hosted persistence from legacy JSON storage
- centralized authorization helpers and audit events

Gate:

- every hosted job operation is tenant-scoped
- cross-tenant list/get/mutate/stream/share tests pass
- hosted startup fails closed when PostgreSQL is unavailable
- self-hosted regression tests remain passing

## Phase 2 — GitHub App authentication

Implement GitHub login, web sessions, installation callbacks/webhooks, repository synchronization, repository picker, and JIT installation-token clone.

Gate:

- no PAT or `VERIFY_TOKEN` required by hosted users
- uninstalled repositories cannot run
- webhook verification and idempotency tests pass
- installation tokens do not reach workflow steps, logs, persistence, or artifacts

## Phase 3 — MCP OAuth 2.1

Replace hosted owner-code/stateless-code behavior with persistent clients, consent, one-time authorization codes, PKCE S256, asymmetric access tokens, refresh rotation/replay detection, revocation, scopes, and audience checks.

Gate:

- browser authorization and refresh flow pass end to end
- code replay, refresh replay, redirect mismatch, wrong audience, and insufficient scope are rejected
- query-string bearer tokens and GitHub-token passthrough are absent in hosted paths

## Phase 4 — Disposable worker runtime

Introduce Redis queueing, lease-based workers, isolated sandbox execution, object storage, cancellation, reconciliation, and cleanup quarantine.

Gate:

- control plane never spawns repository commands
- adversarial isolation and resource-limit suite passes on deployment runtime
- worker restart and duplicate delivery do not duplicate active execution
- cleanup proof is recorded for every terminal job

## Phase 5 — Workflow engine

Add versioned workflows with named steps, working directory, nonsecret env, secret references, presets, stack detection, artifacts, and bounded retries.

Gate:

- representative Node/Bun, Python, Rust, Go, and monorepo fixtures pass
- shell pipelines run inside sandbox
- invalid workflow structure fails before compute reservation

## Phase 6 — Secret vault

Implement envelope encryption, key versioning, tenant/repository/environment scoping, step-level injection, redaction, audit, and secret-name-only MCP APIs.

Gate:

- no API or MCP route returns secret plaintext
- injected values are absent from logs and artifacts in adversarial tests
- unauthorized environment and repository references fail closed

## Phase 7 — Public dashboard

Replace token gate with GitHub onboarding, repository management, MCP connection wizard, jobs, environments, usage, sessions, clients, API keys, and account controls.

Gate:

- a new user completes login, installation, MCP connection, and first job without copying a token
- logout/session revocation takes effect immediately
- accessibility and mobile critical paths pass

## Phase 8 — Launch validation

Run OAuth conformance, tenant isolation, webhook security, SSRF, sandbox escape, credential leak, quota, load, backup/restore, retention, and incident-response exercises.

Launch gate:

- no Critical or High unresolved security finding
- public/private repository end-to-end pass
- multi-user isolation pass
- worker cleanup and restore drills pass
- documented rollback disables hosted job creation without damaging self-hosted mode

## Data migration policy

Legacy JSON jobs are not automatically imported into hosted tenants. An optional administrative import may later:

1. require an explicit destination tenant
2. validate and sanitize each record
3. omit runtime credentials and unsupported fields
4. preserve original timestamps and attach import provenance
5. remain read-only until import completes transactionally

OAuth owner codes, reusable signed authorization codes, localStorage tokens, and GitHub PATs are never migrated.

## Feature flags

Use explicit server-side flags such as:

- `DEPLOYMENT_MODE=self_hosted|hosted`
- `HOSTED_AUTH_ENABLED`
- `HOSTED_JOB_CREATION_ENABLED`
- `HOSTED_WORKER_ENABLED`

Hosted routes fail closed when their dependency or flag is unavailable. Client-side flags do not enforce security.

## Rollout order

1. Deploy schema and read-only hosted identity plumbing.
2. Enable internal accounts and tenant-isolation tests.
3. Enable GitHub App repository discovery.
4. Enable OAuth for internal MCP clients.
5. Enable worker canary with non-sensitive public fixtures.
6. Enable private-repository canary.
7. Enable bounded external beta.
8. Enable public signup only after launch gate approval.

## Rollback

Rollback prioritizes preventing new compute while preserving observability:

- disable hosted job creation and OAuth client registration
- drain or cancel queued jobs according to policy
- allow authorized read access to existing terminal jobs
- revoke affected token families and sessions when auth is involved
- preserve audit records and storage manifests
- never fall back from hosted auth to global legacy tokens automatically

## Definition of complete

The migration is complete only when hosted public traffic uses PostgreSQL ownership, GitHub App repository authorization, Purr Verify OAuth, and isolated workers; the legacy path remains explicitly self-hosted; and all launch gates have evidence committed or linked from the release record.