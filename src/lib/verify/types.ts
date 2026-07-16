// Shared types for the Purr Verify MCP service.

export type JobStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "canceled"
  | "timeout";

export type CommandStatus = "pending" | "running" | "success" | "failed" | "timeout" | "skipped";

export interface CommandResult {
  command: string;
  /** Actual command executed after runner-level normalization (for example frozen install or bunx -> bun x). */
  effectiveCommand?: string;
  status: CommandStatus;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  startedAt: string | null;
  finishedAt: string | null;
  truncated: boolean;
  installStrategy?: InstallStrategy;
}

export interface DeclaredToolchain {
  node?: string;
  bun?: string;
  sources: Record<string, string>;
}

export interface EffectiveToolchain {
  declared: DeclaredToolchain;
  nodeVersion: string;
  bunVersion: string | null;
  pathPrefix?: string[];
  cacheDir?: string;
  warnings: string[];
  recommendations?: string[];
  defaults?: {
    node?: string;
    bun?: string;
  };
}

export interface InstallStrategy {
  requestedCommand: string;
  effectiveCommand: string;
  packageManager: "bun" | "npm" | "pnpm" | "unknown";
  mode: "frozen" | "locked" | "unlocked" | "not-install";
  lockfile: string | null;
  lockfileHonored: boolean;
}

export interface ResolutionProbeRequest {
  packages: string[];
  modules?: ResolutionProbeModuleRequest[];
}

export interface ResolutionProbeModuleRequest {
  specifier: string;
  exports?: string[];
}

export interface ResolutionProbeResult {
  packageName: string;
  probeType?: "package" | "module";
  specifier?: string;
  ok: boolean;
  resolved?: string;
  format?: "esm" | "cjs" | "unknown";
  require?: {
    ok: boolean;
    resolved?: string;
    format?: "esm" | "cjs" | "unknown";
    error?: string;
  };
  import?: {
    ok: boolean;
    resolved?: string;
    format?: "esm" | "cjs" | "unknown";
    namedExports?: string[];
    hasDefault?: boolean;
    error?: string;
  };
  staticNamedImport?: {
    ok: boolean;
    tested?: string[];
    runtime?: string;
    executable?: string;
    error?: string;
  };
  bunTestStaticNamedImport?: {
    ok: boolean;
    tested?: string[];
    runtime?: string;
    executable?: string;
    error?: string;
  };
  requestedExports?: string[];
  missingExports?: string[];
  error?: string;
}

export interface JobMetadata {
  pr?: number | string;
  purpose?: string;
  [key: string]: unknown;
}

export interface JobSummary {
  passed: boolean;
  failedCommand: string | null;
}

export interface VerifyRequest {
  repo: string;
  ref: string;
  expected_head?: string;
  commands: string[];
  continue_on_error?: boolean;
  metadata?: JobMetadata;
  callback_url?: string;
  tags?: string[];
  /**
   * Optional environment variables injected into every command's process
   * environment. Values may contain secrets: they are redacted from stored
   * logs/results/share links and are NEVER persisted to disk. Reserved keys
   * (PATH, NODE_PATH, NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH,
   * DYLD_INSERT_LIBRARIES) are rejected. See validateEnv in mcp.ts.
   */
  env?: Record<string, string>;
  /** Optional diagnostic: package names to resolve from the cloned workspace after install. */
  resolution_probe?: string[] | ResolutionProbeRequest;
  /** Execution mode. "auto" runs one short smoke command inline and routes long-running work to async. */
  mode?: "sync" | "async" | "auto";
  /**
   * Opt-in long-running verification mode for fork/soak jobs. Defaults keep
   * normal CI bounded; long_run permits per-job timeout overrides up to the
   * server-side cap.
   */
  long_run?: boolean;
  /** Optional per-job command timeout override in milliseconds, long_run only. */
  command_timeout_ms?: number;
  /** Optional per-job total timeout override in milliseconds, long_run only. */
  job_timeout_ms?: number;
}

export interface ExecutionRoutingRecord {
  requestedMode: "sync" | "async" | "auto";
  effectiveMode: "sync" | "async";
  routingReason: string;
  autoRouted: boolean;
  detectedLongRunningCommand?: string;
}

export interface CleanupResult {
  status: "pending" | "running" | "done" | "partial" | "failed" | "skipped";
  startedAt?: string | null;
  finishedAt?: string | null;
  workspaceRemoved?: boolean;
  cacheRemoved?: boolean;
  workspaceError?: string | null;
  cacheError?: string | null;
}

export interface WebhookDelivery {
  attempt: number;
  url: string;
  status: "success" | "failed" | "timeout";
  statusCode: number | null;
  sentAt: string;
  durationMs: number;
  error?: string | null;
}

export interface JobAnnotation {
  id: string;
  text: string;
  createdAt: string;
  author?: string;
}

export interface Job {
  jobId: string;
  repo: string;
  ref: string;
  expected_head?: string;
  actual_head?: string;
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  queuedAt: string;
  commands: CommandResult[];
  summary: JobSummary;
  continue_on_error: boolean;
  metadata: JobMetadata;
  callback_url?: string;
  error?: string | null;
  cleanupStatus?: "pending" | "running" | "done" | "partial" | "failed" | "skipped";
  cleanup?: CleanupResult;
  execution?: ExecutionRoutingRecord;
  webhookDeliveries?: WebhookDelivery[];
  tags?: string[];
  annotations?: JobAnnotation[];
  toolchain?: EffectiveToolchain;
  installStrategies?: InstallStrategy[];
  resolutionProbe?: ResolutionProbeResult[];
  runnerRecommendations?: string[];
  timeoutPolicy?: {
    longRun: boolean;
    commandTimeoutMs: number;
    jobTimeoutMs: number;
    maxLongRunTimeoutMs: number;
    requestedCommandTimeoutMs?: number;
    normalized?: boolean;
    warnings?: string[];
  };
}

export interface HealthResponse {
  status: "ok";
  service: "purr-verify-mcp";
  time: string;
  activeJobs: number;
  queuedJobs: number;
  totalJobs: number;
  version: string;
  allowedRepos: string[];
  /**
   * True when the repo allowlist is unrestricted (ALLOWED_REPOS empty/"*" or
   * ALLOW_ALL_REPOS=true). In that case any `owner/repo` matching the safe
   * regex is accepted and `allowedRepos` is `[]`.
   */
  allowAllRepos: boolean;
  /** Active auth mode: server_token (Bearer == VERIFY_TOKEN) or github_passthrough (Bearer == GitHub PAT, validated via GitHub API). */
  authMode: "server_token" | "github_passthrough";
  /** Where the GitHub clone token comes from: "bearer" (passthrough), "env" (GITHUB_TOKEN), or "none". Never exposes the token value. */
  githubTokenSource: "bearer" | "env" | "none";
  configured: boolean;
  /** Whether async background jobs run reliably (executor + scheduler healthy). */
  backgroundJobsReliable: boolean;
  /** Whether synchronous mode is available (POST /api/verify?mode=sync). */
  syncModeAvailable: boolean;
  /** Whether smart execution routing is available (mode=auto and heavy sync fallback). */
  autoModeAvailable?: boolean;
  /** Node.js runtime version (process.version), e.g. "v26.3.0". Optional for backward compat. */
  nodeVersion?: string;
  /** Bun runtime version if running under Bun (process.versions.bun), else null. */
  bunVersion?: string | null;
  /** Absolute base directory under which per-job workspaces are cloned. */
  workspaceRoot?: string;
  /** Cache root for per-job Node/Bun toolchains. */
  toolchainCacheRoot?: string;
  toolchainDefaultNode?: string | null;
  toolchainDefaultBun?: string | null;
  commandTimeoutMs?: number;
  configuredCommandTimeoutMs?: number;
  jobTimeoutMs?: number;
  timeoutWarnings?: string[];
  maxLongRunTimeoutMs?: number;
  runnerTools?: {
    cargo?: ToolAvailability;
    rustc?: ToolAvailability;
    surfpool?: ToolAvailability;
    python?: ToolAvailability;
    python3?: ToolAvailability;
    uv?: ToolAvailability;
    poetry?: ToolAvailability;
    pipenv?: ToolAvailability;
    tox?: ToolAvailability;
    nox?: ToolAvailability;
  };
}

export interface ToolAvailability {
  available: boolean;
  path?: string | null;
  version?: string | null;
  error?: string | null;
}

// A share token grants public read-only access to a single job's result.
// Tokens are short-lived (default 24h, max 7d) and can be revoked at any time.
export interface ShareToken {
  token: string;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  createdBy?: string | null;
  // Optional note set by the creator (e.g., "PR review", "Slack share").
  note?: string | null;
}

// Public job view returned by GET /api/share/:token. Sensitive fields are
// stripped: callback_url, webhook_deliveries, metadata internals. The
// command stdout/stderr is kept because that's the value of sharing.
export interface PublicJobView {
  jobId: string;
  repo: string;
  ref: string;
  status: JobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  queuedAt: string;
  commands: CommandResult[];
  summary: JobSummary;
  continue_on_error: boolean;
  error?: string | null;
  cleanupStatus?: string;
  tags?: string[];
  actual_head?: string;
  // Share metadata so the viewer knows when the link expires.
  sharedVia: {
    token: string;
    createdAt: string;
    expiresAt: string;
  };
}
