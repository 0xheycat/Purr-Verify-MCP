# Disposable Worker Isolation Contract

## Security objective

Repository code is untrusted. Hosted Purr Verify must allow normal developer workflows while preventing repository commands from controlling the host, control plane, other tenants, or long-lived credentials.

The current direct child-process runner is a legacy self-hosted implementation. It is not the hosted public worker boundary.

## Required topology

```text
control plane -> authenticated queue message -> worker supervisor -> disposable sandbox
sandbox -> bounded event/log channel -> storage and job state
```

The worker service is deployed separately from the dashboard, OAuth server, and public API.

## Sandbox invariants

Each job sandbox must have:

- unique ephemeral workspace and runtime identity
- non-root user with no privilege escalation
- read-only base image and writable bounded scratch/workspace
- no privileged container mode
- no host PID, IPC, network, or user namespace sharing
- no host Docker/container runtime socket
- no control-plane source, environment, database socket, or cloud credentials
- a restrictive seccomp/capability profile appropriate to the runtime
- enforced CPU, memory, disk, process, log, and wall-clock limits
- termination of all descendants on cancel, timeout, or supervisor loss
- deterministic cleanup after every terminal outcome

A microVM runtime may replace containers where stronger isolation is required, but it must satisfy the same contract.

## Network policy

Default hosted profile:

- outbound public internet allowed for package registries and source downloads
- inbound connections blocked
- loopback confined to the sandbox
- RFC1918, link-local, host-network, cluster-internal, and cloud metadata destinations blocked
- DNS resolution and egress requests observable for abuse investigation without logging credentials
- optional stricter per-tenant/network profiles may be added later

The control plane must validate callback and webhook destinations separately; worker egress does not make control-plane SSRF acceptable.

## Credential lifecycle

1. Supervisor requests a short-lived GitHub installation token restricted to the selected repository.
2. Clone/fetch runs in a bootstrap phase.
3. Token-bearing remote configuration and credential helper state are removed.
4. User workflow begins without GitHub installation credentials unless an explicit future capability grants a narrower credential.
5. Environment secrets are injected only into declared authorized steps.
6. Redaction is initialized before any process output is captured.
7. All temporary credentials are destroyed with the sandbox.

Credentials must never be persisted in job JSON, queue payload logs, artifacts, command text, or diagnostic dumps.

## Resource defaults

Initial free-tier target:

- 2 vCPU
- 4 GiB memory
- 10 GiB workspace
- 30 minute wall-clock limit
- 1,024 processes/threads combined, or the strictest practical lower bound compatible with builds
- bounded stdout/stderr and artifact size
- one concurrent job per personal tenant

Exact values remain configuration, but no hosted job may run without explicit limits.

## Workflow behavior

Inside the sandbox, workflows may use ordinary shell syntax, package managers, compilers, test frameworks, pipes, redirects, and repository scripts. Validation still rejects malformed workflow structure and platform-unsupported capabilities, but the primary security boundary is isolation rather than a small command allowlist.

Disallowed capabilities include:

- privileged containers
- mounting arbitrary host paths
- host networking
- accessing the supervisor/control-plane API through internal credentials
- persistent daemon workloads after job completion
- requesting unbounded resource profiles

## Events and state

- Queue delivery is at-least-once; job claiming must be idempotent and lease-based.
- Only one active worker may own a job lease.
- Job state transitions use compare-and-set semantics.
- Logs/events carry monotonically increasing sequence numbers.
- Worker heartbeat expiry triggers termination/reconciliation.
- A restarted control plane must not mark healthy running jobs failed merely because process-local state was lost.

## Cleanup proof

A job is complete only after:

- all descendant processes are dead
- workspace and temporary mounts are removed
- temporary credentials are revoked/expired and deleted locally
- final logs/artifact manifests are committed
- cleanup result is recorded

Failed cleanup quarantines the worker node from new jobs until reconciliation.

## Launch validation

Required adversarial tests include attempts to:

- read host/control-plane files and environment
- access Docker/container sockets
- reach metadata and private networks
- escape via symlinks, archives, package scripts, and child daemons
- exceed CPU, memory, disk, process, log, and runtime limits
- retain credentials in git config, process environment, logs, or artifacts
- access another concurrent tenant workspace

Hosted public execution stays disabled until these tests pass on the actual deployment runtime.