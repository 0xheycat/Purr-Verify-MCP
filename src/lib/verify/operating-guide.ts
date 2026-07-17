export const VERIFY_MCP_INSTRUCTIONS =
  "Before verification or local VPS operator work, call read_operating_guide and health_check. Use the purr discovery, inspection, environment, and deployment-plan tools for read-only local project work. Call list_allowed_commands before repository-clone verification. Use mode=auto or async for install/build/lint/typecheck/test. Long-running sync requests are routed to async instead of rejected. Valid long_run jobs, including 8-9 hour smoke and soak verification, are first-class developer workflows up to the operator timeout cap. Read effectiveMode from the response and poll get_verification_job when it is async. Use history summaries and bounded log chunks by default while preserving full evidence access.";

export const VERIFY_OPERATING_GUIDE = {
  name: "Purr Verify MCP Operating Guide",
  version: "2026-07-17-operator-phase1",
  serverRole:
    "Use this MCP for runtime verification plus private read-only VPS project discovery, inspection, environment inventory, and deployment planning. Repository-clone verification still uses isolated workspaces and allowlisted commands. Phase-one operator tools do not deploy, restart, edit repositories, or replace GitHub MCP.",
  startupProtocol: [
    "Call read_operating_guide first.",
    "Call health_check to confirm runtime, queue, effective timeout policy, durable history status, and auth mode.",
    "For local VPS work, discover projects or provide an absolute cwd, then inspect the project and runtime before planning deployment.",
    "Inspect environment key presence first; reveal only explicitly requested keys when a value is genuinely required.",
    "Call purr_plan_deployment before future deployment mutations. Phase one returns a plan only.",
    "Call list_allowed_commands before choosing commands.",
    "Confirm repo, ref, expected_head when available, and command list.",
    "Use create_verification_job with mode=auto or mode=async for install/build/lint/typecheck/test.",
    "For smoke, soak, fork, and live-observation jobs lasting hours, set long_run=true with explicit command_timeout_ms and job_timeout_ms up to maxLongRunTimeoutMs.",
    "Read requestedMode, effectiveMode, routingReason, and autoRouted from the create response.",
    "Poll get_verification_job until terminal status when effectiveMode is async.",
    "Use search_verification_history, get_verification_summary, and get_job_log_chunk to inspect durable evidence without flooding agent context.",
  ],
  hardRules: [
    "Heavy commands requested in sync mode are routed to async instead of being rejected.",
    "Heavy commands include install, build, lint, typecheck, test, prisma generate, playwright, cypress, vitest, jest, Surfpool start, and CI scripts.",
    "Explicit sync remains available for one short smoke command expected to complete within the transport window.",
    "Valid long_run verification is not blocked merely because it lasts for hours. Eight-to-nine-hour smoke, soak, fork, and live-observation jobs are supported up to maxLongRunTimeoutMs when the operator explicitly supplies long_run=true and valid timeout overrides.",
    "Queued and running jobs are never removed by history retention. Their durable state remains readable until they reach a terminal result, including cancellation and cleanup evidence.",
    "History summaries and log chunks protect agent context; they do not remove access to full stored job evidence.",
    "Phase-one purr operator tools are read-only. They discover, inspect, inventory, and plan without running deploy, restart, rollback, or arbitrary command mutations.",
    "Environment inspection returns key names, source locations, and present or missing state by default. Revealing a value requires explicit requested keys and that response is not stored in history or deployment plans.",
    "Canonical cwd is the project identity for plans and future same-project operation locks; requested and symlink paths remain visible for auditability.",
    "Retry transient read-only MCP transport errors, timeouts, HTTP 429, and HTTP 5xx at most five times with backoff of 2, 4, 8, 16, and 32 seconds.",
    "Do not submit an identical source or test failure repeatedly. Record jobId, command, status, and failure summary; change the source, test, or execution inputs before submitting a new job.",
    "A missing or evicted queued/running job is recorded as VERIFY_RESULT_EVICTED. Continue from fresh state on a later run rather than blindly duplicating the same request.",
    "Never disable, pause, or terminate a recurring schedule because verification is unavailable or failed.",
    "Workspace source and per-job cache are disposable and must be removed after terminal execution. Persisted job history and redacted evidence remain available.",
    "Summarize logs by default. Provide full logs only when requested.",
    "Use GitHub MCP for repository edits, branches, commits, pull requests, comments, and file inspection.",
    "Use Notion only for project context, specs, plans, and audit notes.",
  ],
  executionRouting: {
    defaultMode: "auto",
    shortSingleCommand: "sync",
    longRunningCommand: "async",
    multiCommandAuto: "async",
    explicitAsync: "async",
    heavyExplicitSync: "async_fallback",
    rejectionPolicy: "do_not_reject_valid_heavy_work_only_because_sync_was_requested",
  },
  workspaceLifecycle: {
    sourceWorkspace: "delete_after_job",
    perJobCache: "delete_after_job",
    persistedHistory: "retain",
    orphanCleanup: "startup_and_periodic_janitor",
    cleanupEvidence: ["workspaceRemoved", "cacheRemoved", "workspaceError", "cacheError"],
  },
  historyLifecycle: {
    backend: "sqlite_wal",
    activeJobRetention: "never_evict_queued_or_running",
    terminalEvidence: "durable_and_cursor_paginated",
    defaultAgentView: "summary",
    fullEvidenceAccess: "preserved",
    logAccess: "bounded_chunks_and_search",
  },
  operatorInspection: {
    phase: "read_only_discovery_inspection_and_planning",
    defaultRoots: ["/opt", "/srv", "/var/www", "/home", "/root"],
    customRootsEnvironment: "PURR_OPERATOR_ROOTS",
    projectIdentity: "canonical_absolute_cwd",
    runtimeAdapters: ["pm2", "systemd", "docker_compose", "process"],
    projectTypes: ["node", "rust", "python", "go", "docker_compose"],
    environmentSources: ["dotenv", "pm2", "systemd", "docker_compose", "process"],
    defaultEnvironmentView: "key_name_source_and_presence_only",
    revealedValuePersistence: "never",
    mutationToolsAvailable: false,
  },
  safeToolRouting: {
    verifyMcp: [
      "health_check",
      "list_allowed_commands",
      "create_verification_job",
      "get_verification_job",
      "search_verification_history",
      "get_latest_verification",
      "get_verification_summary",
      "compare_verification_jobs",
      "get_job_log_chunk",
      "search_job_logs",
      "purr_discover_projects",
      "purr_inspect_project",
      "purr_inspect_runtime",
      "purr_inspect_environment",
      "purr_plan_deployment",
    ],
    githubMcp: ["repository inspection", "branch", "commit", "pull request", "file operations"],
    notion: ["specs", "plans", "audit notes", "project context"],
  },
  defaultVerificationPolicy: {
    mode: "auto",
    logMode: "summary",
    maxIdenticalSourceFailureRetries: 0,
    readOnlyTransportRetries: 5,
    readOnlyBackoffSeconds: [2, 4, 8, 16, 32],
    missingJobStatus: "VERIFY_RESULT_EVICTED",
    explicitCommandTimeoutMs: 600000,
    explicitJobTimeoutMs: 1800000,
    maxLongRunTimeoutMs: 32400000,
    supportedLongRunExamples: [
      "PurrLiquid 8-9 hour live smoke",
      "Surfpool fork soak",
      "long-lived integration observation",
    ],
    recurringScheduleAction: "continue",
    pollWhenEffectiveModeAsync: true,
  },
};

export const READ_OPERATING_GUIDE_TOOL = {
  name: "read_operating_guide",
  description:
    "Read the Purr Verify MCP operating guide. Call this before verification work so the agent uses smart execution routing, durable history, long-run workflows, and the correct repository tool boundary.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

const HEAVY_COMMAND_PATTERNS = [
  /\binstall\b/i,
  /\bbuild\b/i,
  /\blint\b/i,
  /\btypecheck\b/i,
  /\btest\b/i,
  /\bci\b/i,
  /\bprisma\s+generate\b/i,
  /\bplaywright\b/i,
  /\bcypress\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bsurfpool\s+start\b/i,
];

/** @deprecated Use execution-policy.ts resolveExecutionMode for routing decisions. */
export function findHeavySyncCommand(commands: unknown): string | null {
  if (!Array.isArray(commands)) return null;
  for (const command of commands) {
    if (typeof command !== "string") continue;
    if (HEAVY_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return command;
  }
  return null;
}
