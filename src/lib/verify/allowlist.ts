// Command allowlist validator.
//
// SECURITY: This is NOT a general shell executor. Every command must match one
// of a fixed set of allowlisted grammars. The validator:
//   1. Rejects commands containing any dangerous metacharacter or token.
//   2. Requires the command to fully match exactly one allowlisted pattern.
//
// Only the exact grammars below are permitted. Anything else is rejected.

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  matchedPattern?: string;
}

// Building blocks for safe tokens.
const SCRIPT = "[a-zA-Z0-9_.:-]+"; // npm/bun script names: build, ci:check
const SAFE_FILE = "[a-zA-Z0-9_.-]+"; // a single filename (no slashes)
const NUM = "[0-9]+";
const WORD = "[a-z0-9_-]+";

// A safe relative path: segments of [A-Za-z0-9_.-] joined by "/", must not
// start with "/", and ".." is forbidden globally (checked separately).
const SEG = "[a-zA-Z0-9_.-]+";
const REL_PATH = `${SEG}(?:/${SEG})*`;

// Safe flags for the ENV_MODE=mock manage script.
const SAFE_FLAG = `(?:--(?:duration|poll-interval|manage-interval|heartbeat-interval|iterations|interval)=${NUM}|--mode=${WORD}|--execute=false)`;
const SAFE_FLAGS = `${SAFE_FLAG}(?:\\s+${SAFE_FLAG})*`;

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "bun install", re: new RegExp(`^bun install$`) },
  { name: "bun install --frozen-lockfile", re: new RegExp(`^bun install --frozen-lockfile$`) },
  { name: "bunx prisma generate", re: new RegExp(`^bunx prisma generate$`) },
  { name: "bun run <script>", re: new RegExp(`^bun run ${SCRIPT}$`) },
  { name: "bun test", re: new RegExp(`^bun test$`) },
  { name: "bun test --isolate", re: new RegExp(`^bun test --isolate$`) },
  { name: "bun test --parallel=<n>", re: new RegExp(`^bun test --parallel=${NUM}$`) },
  { name: "bun test <path>", re: new RegExp(`^bun test ${REL_PATH}$`) },
  { name: "npm ci", re: new RegExp(`^npm ci$`) },
  { name: "npm run <script>", re: new RegExp(`^npm run ${SCRIPT}$`) },
  { name: "pnpm install --frozen-lockfile", re: new RegExp(`^pnpm install --frozen-lockfile$`) },
  { name: "pnpm run <script>", re: new RegExp(`^pnpm run ${SCRIPT}$`) },
  { name: "npx prisma generate", re: new RegExp(`^npx prisma generate$`) },
  { name: "node <path>", re: new RegExp(`^node ${REL_PATH}$`) },
  { name: "cat reports/<file>.json", re: new RegExp(`^cat reports/${SAFE_FILE}\\.json$`) },
  { name: "cat reports/<file>.txt", re: new RegExp(`^cat reports/${SAFE_FILE}\\.txt$`) },
  {
    name: "ENV_MODE=mock bun run scripts/manage.ts <flags>",
    re: new RegExp(`^ENV_MODE=mock bun run scripts/manage\\.ts(?:\\s+${SAFE_FLAGS})?$`),
  },
];

// Globally forbidden substrings/tokens. Defense in depth on top of allowlist.
const FORBIDDEN_SUBSTRINGS = [
  ";",
  "&&",
  "||",
  "|",
  ">",
  "<",
  "`",
  "$(",
  "..",
  "\\",
  '"',
  "'",
  "curl",
  "wget",
  "rm ",
  "rm\t",
  "mv ",
  "cp ",
  "sudo",
  "chmod",
  "chown",
  "ssh",
  "scp",
  "docker",
  "powershell",
  "nc ",
  "mkfs",
  "dd ",
];

function containsForbidden(cmd: string): string | null {
  const lower = cmd.toLowerCase();
  for (const f of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(f)) return f.trim() || f;
  }
  // Absolute paths
  if (/(^|\s)\//.test(cmd)) return "absolute path";
  return null;
}

export function validateCommand(cmd: string): ValidationResult {
  if (typeof cmd !== "string") return { ok: false, reason: "command must be a string" };
  const trimmed = cmd.trim();
  if (!trimmed) return { ok: false, reason: "empty command" };
  if (trimmed.length > 500) return { ok: false, reason: "command too long" };

  const forbidden = containsForbidden(trimmed);
  if (forbidden) {
    return { ok: false, reason: `command contains forbidden token: ${forbidden}` };
  }

  for (const p of PATTERNS) {
    if (p.re.test(trimmed)) {
      return { ok: true, matchedPattern: p.name };
    }
  }
  return { ok: false, reason: "command does not match any allowlisted pattern" };
}

export function validateCommands(commands: unknown): {
  ok: boolean;
  reason?: string;
  commands?: string[];
} {
  if (!Array.isArray(commands)) return { ok: false, reason: "commands must be an array" };
  if (commands.length === 0) return { ok: false, reason: "commands array is empty" };
  if (commands.length > 50) return { ok: false, reason: "too many commands (max 50)" };
  const out: string[] = [];
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    const res = validateCommand(c as string);
    if (!res.ok) {
      return { ok: false, reason: `command #${i + 1} rejected: ${res.reason}` };
    }
    out.push((c as string).trim());
  }
  return { ok: true, commands: out };
}

// List of supported allowlisted patterns (for docs / UI display).
export function listPatterns(): string[] {
  return PATTERNS.map((p) => p.name);
}
