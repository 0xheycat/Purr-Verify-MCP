export const VERIFY_MCP_INSTRUCTIONS =
  "Before verification work, call read_operating_guide, health_check, and list_allowed_commands. Use async mode for install/build/lint/typecheck/test. Never run heavy verification in sync mode. Poll get_verification_job until terminal status. Retry transient read-only transport failures with bounded backoff. A failed job ends only the current bounded run; never pause a recurring schedule. Return summarized logs unless full logs are requested.";

export const VERIFY_OPERATING_GUIDE = {
  name: "Purr Verify MCP Operating Guide",
  version: "2026-07-14",
  serverRole:
    "Use this MCP only for runtime verification. It clones a GitHub repo/ref into an isolated workspace and runs allowlisted commands. It must not edit repositories, create PRs, or replace GitHub MCP.",
  startupProtocol: [
    "Call read_operating_guide first.",
    "Call health_check to confirm runtime, queue, timeout caps, and auth mode.",
    "Call list_allowed_commands before choosing commands.",
    "If health reports commandTimeoutMs greater than jobTimeoutMs, use explicit valid async overrides such as long_run=true, command_timeout_ms=600000, and job_timeout_ms=1800000.",
    "Confirm repo, ref, expected_head when available, and command list.",
    "Use create_verification_job with mode=async for install/build/lint/typecheck/test.",
    "Poll get_verification_job until a terminal status.",
  ],
  hardRules: [
    "Heavy commands are blocked in sync mode.",
    "Heavy commands include install, build, lint, typecheck, test, prisma generate, playwright, cypress, vitest, jest, and CI scripts.",
    "Use sync only for a short single smoke command expected to complete quickly.",
    "Retry transient read-only MCP transport errors, timeouts, HTTP 429, and HTTP 5xx at most five times with backoff of 2, 4, 8, 16, and 32 seconds.",
    "Do not submit an identical failed verification job repeatedly. Record jobId, command, status, and failure summary; fix the source or test before a new job on the next scheduled run.",
    "If Verify MCP is unavailable, end only the current bounded run gracefully. After two consecutive scheduled turns, record VERIFY_SKIPPED and allow an implementation commit with explicit unverified evidence.",
    "If a queued or running job disappears from the store, record VERIFY_RESULT_EVICTED with its jobId and last state; do not resubmit an identical job in the same run.",
    "Never disable, pause, or terminate a recurring schedule because verification is unavailable or failed. Resume from fresh repository state on the next run.",
    "Summarize logs by default. Provide full logs only when requested.",
    "Use GitHub MCP for repository edits, branches, commits, PRs, comments, and file inspection.",
    "Use Notion only for project context, specs, plans, and audit notes.",
  ],
  safeToolRouting: {
    verifyMcp: ["health_check", "list_allowed_commands", "create_verification_job", "get_verification_job"],
    githubMcp: ["repository inspection", "branch", "commit", "pull request", "file operations"],
    notion: ["specs", "plans", "audit notes", "project context"],
  },
  defaultVerificationPolicy: {
    mode: "async",
    logMode: "summary",
    maxIdenticalJobRetries: 0,
    readOnlyTransportRetries: 5,
    readOnlyBackoffSeconds: [2, 4, 8, 16, 32],
    unavailableTurnsBeforeSkip: 2,
    missingJobStatus: "VERIFY_RESULT_EVICTED",
    explicitCommandTimeoutMs: 600000,
    explicitJobTimeoutMs: 1800000,
    recurringScheduleAction: "continue",
    pollUntilTerminal: true,
  },
};

export const READ_OPERATING_GUIDE_TOOL = {
  name: "read_operating_guide",
  description:
    "Read the Purr Verify MCP operating guide. Call this before verification work so the agent uses async jobs, avoids stream timeouts, and routes GitHub/Notion work to the correct tools.",
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
];

export function findHeavySyncCommand(commands: unknown): string | null {
  if (!Array.isArray(commands)) return null;
  for (const command of commands) {
    if (typeof command !== "string") continue;
    if (HEAVY_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) return command;
  }
  return null;
}
