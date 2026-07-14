# Hosted Database Schema

## Scope

PostgreSQL becomes the hosted source of truth. The legacy JSON store remains a self-hosted compatibility adapter and is not queried by hosted routes.

## Identity and tenancy

### `users`

- `id` UUID primary key
- `github_user_id` bigint unique not null
- `github_login`, `display_name`, `avatar_url`, `primary_email`
- `status` active/suspended/deleted
- timestamps

### `tenants`

- `id` UUID primary key
- `kind` personal/organization
- `slug`, `display_name`
- `github_organization_id` nullable unique
- timestamps, deletion metadata

### `tenant_memberships`

- composite unique `(tenant_id, user_id)`
- role owner/admin/developer/viewer
- status and timestamps

### `web_sessions`

- hashed opaque session identifier
- `user_id`, active `tenant_id`
- expiry, last use, revocation, IP/user-agent hints

## GitHub installation model

### `github_installations`

- GitHub installation ID unique
- tenant/account identity and type
- permission snapshot and repository-selection mode
- status, suspended/deleted timestamps

### `repositories`

- GitHub repository ID unique
- `tenant_id`, `github_installation_id`
- owner/name, default branch, visibility, archived flag
- installation access status and synchronization timestamps

Webhook delivery IDs are stored for idempotency.

## OAuth and API credentials

### `oauth_clients`

Persistent client ID, redirect URIs, token endpoint auth method, client metadata, status, creator, and timestamps.

### `oauth_consents`

Unique grant per user/tenant/client/scope set with grant and revocation timestamps.

### `oauth_authorization_codes`

Hashed code, user, tenant, client, redirect URI, PKCE challenge/method, scopes, resource audience, expiry, and atomically set `consumed_at`.

### `oauth_access_tokens`

JWT ID or opaque-token hash, subject/client/tenant, scopes, audience, expiry, revocation. Storing JWT plaintext is forbidden.

### `oauth_refresh_tokens`

Hashed token, token-family ID, parent token, subject/client/tenant, scopes/audience, expiry, consumed/revoked timestamps, and replay metadata.

### `api_keys`

Prefix, strong token hash, owner/tenant, scopes, expiry, last use, revocation. Plain API keys are displayed once and never stored.

## Environments and secrets

### `environments`

Tenant-owned name with optional repository scope, protection policy, and timestamps. Unique within `(tenant_id, repository_id, name)`.

### `secrets`

- tenant/environment and optional repository scope
- normalized secret name
- encrypted data key, ciphertext, nonce/algorithm metadata
- encryption key version
- creator/updater and timestamps

Secret plaintext is never stored in columns, logs, audit payloads, or job specifications.

## Jobs

### `jobs`

- `id` UUID primary key
- `tenant_id`, creator user/client
- installation and repository IDs
- immutable repository/ref/expected-head snapshot
- status, queue timestamps, start/finish/duration
- workflow version and sanitized workflow specification
- timeout/resource policy
- summary, error classification, cleanup status
- callback metadata excluding credentials

### `job_steps`

Tenant/job IDs, stable index/name, sanitized command, working directory, status, timing, exit code, truncation and artifact metadata.

### `job_events`

Tenant/job IDs, monotonically increasing sequence, type, sanitized payload, timestamp. Unique `(job_id, sequence)`.

### `job_artifacts`

Tenant/job/step IDs, object-storage key, type, size, digest, retention and deletion timestamps. Storage keys are never user-authoritative.

### `job_annotations`

Tenant/job, author, body, timestamps and deletion metadata.

### `job_share_tokens`

Tenant/job, token hash/prefix, public projection policy, expiry, revocation and last-access metadata.

## Usage, quota, and audit

### `usage_reservations`

Transactional reservation before enqueue: tenant, job, period, compute/resource estimate, state and release/finalization timestamps.

### `usage_counters`

Tenant/period aggregates for jobs, compute seconds, artifact bytes, and concurrency controls.

### `audit_events`

Immutable tenant, actor type/id, action, target type/id, sanitized metadata, request correlation, timestamp. Partitioning may be used; credential and secret plaintext is forbidden.

## Integrity requirements

- Child job tables include `tenant_id` and use composite foreign keys where practical.
- Ownership-changing foreign keys use restrictive deletion, not broad cascading by default.
- Job state transitions and quota reservations occur transactionally.
- Authorization-code consumption and refresh-token rotation use row locks or equivalent atomic updates.
- Webhook deliveries and queue claims are idempotent.
- Repository and installation deletion disables access before asynchronous cleanup.

## Index requirements

At minimum:

- jobs by `(tenant_id, queued_at desc)` and `(tenant_id, status, queued_at)`
- events by `(job_id, sequence)`
- repositories by tenant and installation
- active sessions/tokens by hash and expiry
- refresh token family and active status
- secrets by tenant/repository/environment/name
- audit by tenant/time and target

## Migration implementation

Use a versioned migration tool compatible with the repository stack. Schema changes must be reviewable SQL or generated migrations committed to source control. Production startup must not perform destructive implicit schema synchronization.