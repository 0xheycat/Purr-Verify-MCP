# Multi-Tenant Ownership Model

## Tenant types

- **Personal tenant** — owned by one Purr Verify user.
- **Organization tenant** — linked to a GitHub organization installation and governed by membership roles.

Every hosted resource has exactly one tenant owner. A nullable `organization_id` alone is insufficient; use a mandatory `tenant_id` referencing a typed tenant record.

## Core ownership chain

```text
tenant
  -> memberships
  -> github installations
  -> repositories
  -> environments/secrets
  -> jobs -> steps/events/artifacts/share tokens
```

Every authorization query must begin from the authenticated subject's active tenant membership and join through owned objects. Do not fetch globally by opaque ID and check ownership afterward when the database can enforce the predicate in the same query.

## Roles

Initial organization roles:

- `owner` — membership, installation, secrets, billing/usage, destructive administration
- `admin` — repositories, environments, secrets, jobs, OAuth clients
- `developer` — create/read/cancel jobs and use permitted environments
- `viewer` — read jobs and artifacts only

Personal tenants implicitly grant `owner` to their creator.

## Mandatory resource fields

Jobs:

- `tenant_id`
- `created_by_user_id`
- `created_by_oauth_client_id` nullable
- `github_installation_id`
- `repository_id`
- immutable repository owner/name snapshot

Secrets and environments:

- `tenant_id`
- optional `repository_id`
- environment name
- encryption key version
- creator/updater audit fields

OAuth grants and API keys:

- `user_id`
- `tenant_id`
- client/key identifier
- scopes
- expiry/revocation metadata

## Isolation rules

- Job list, get, stream, cancel, retry, delete, annotate, share, and artifact access are tenant-scoped.
- Queue positions and usage statistics must not reveal another tenant's job metadata.
- Public share tokens resolve through a separate capability path and expose only an explicitly defined public job projection.
- Share tokens are hashed at rest, expire, and can be revoked.
- Secret names may be returned only within an authorized tenant/repository/environment scope. Secret values are never returned.
- Installation webhooks may mutate only records matching the GitHub installation ID and verified webhook signature.

## Database enforcement

Application predicates are mandatory. PostgreSQL row-level security may be added as defense in depth but does not replace explicit service-layer authorization.

Required constraints include:

- foreign keys for every ownership edge
- uniqueness of GitHub installation and repository identifiers within their natural scope
- tenant ID on all job child tables, enabling direct composite foreign keys and safer partitioning
- atomic quota counters or transactional usage reservation before queue insertion
- immutable audit-event tenant and actor identity

## Deletion and retention

- Deleting a user does not silently delete organization-owned data.
- Removing the final organization owner is forbidden until ownership is transferred or the tenant is deleted.
- Installation removal disables new jobs immediately and schedules credential/reference cleanup.
- Job metadata retention and object-storage retention are explicit policy values.
- Secret deletion removes encrypted ciphertext and key references; backups follow documented retention windows.

## Required tests

For every resource action, create tenant A and tenant B fixtures and prove:

- A cannot list B resources
- A cannot fetch B resource by known ID
- A cannot mutate or stream B resource
- A cannot infer B queue details, secret names, or artifact keys
- revoked membership loses access immediately
- public share capability exposes only the public projection

Hosted launch requires these tests to pass against real persistence, not the legacy in-memory store.