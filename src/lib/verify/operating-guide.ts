export const VERIFY_MCP_INSTRUCTIONS =
  "Before verification work, call read_operating_guide, health_check, and list_allowed_commands. Use async mode for install/build/lint/typecheck/test. Never run heavy verification in sync mode. Poll get_verification_job until terminal status. Return summarized logs unless full logs are requested.";

export const VERIFY_OPERATING_GUIDE = {
  name: "Purr Verify MCP Operating Guide",
  version: "2026-07-08",
  serverRole:
    "Use this MCP only for runtime verification. It clones a GitHub repo/ref into an isolated workspace and runs allowlisted commands. It must not edit repositories, create PRs, or replace GitHub MCP.",
  startupProtocol: [
    "Call read_operating_guide first.",
    "Call health_check to confirm runtime, queue, timeout caps, and auth mode.",
    "Call list_allowed_commands before choosing commands.",
    "Confirm repo, ref, expected_head when available, and command list.",
    "Use create_verification_job with mode=async for install/build/lint/typecheck/test.",
    "Poll get_verification_job until a terminal status.",
  ],
  hardRules: [
    "Heavy commands are blocked in sync mode.",
    "Heavy commands include install, build, lint, typecheck, test, prisma generate, playwright, cypress, vitest, jest, and CI scripts.",
    "Use sync only for a short single smoke command expected to complete quickly.",
    "Do not retry failed jobs in a loop. Stop and report jobId, command, status, and failure summary.",
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
    maxRetries: 0,
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
