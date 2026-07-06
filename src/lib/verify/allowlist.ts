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
const SAFE_ARG_VALUE = "[A-Za-z0-9_./:@=+,-]+";
const B64URL = "[A-Za-z0-9_-]+={0,2}";

// A safe relative path: segments of [A-Za-z0-9_.-] joined by "/", must not
// start with "/", and ".." is forbidden globally (checked separately).
const SEG = "[a-zA-Z0-9_.-]+";
const REL_PATH = `${SEG}(?:/${SEG})*`;

// Safe flags for the ENV_MODE=mock manage script.
const SAFE_FLAG = `(?:--(?:duration|poll-interval|manage-interval|heartbeat-interval|iterations|interval)=${NUM}|--mode=${WORD}|--execute=false)`;
const SAFE_FLAGS = `${SAFE_FLAG}(?:\\s+${SAFE_FLAG})*`;
const SCRIPT_TS = `scripts/${SEG}(?:/${SEG})*\\.ts`;
const SAFE_BOOL_ARG = `--[A-Za-z0-9_-]+`;
const SAFE_KV_ARG = `--[A-Za-z0-9_-]+=${SAFE_ARG_VALUE}`;
const SAFE_CLI_ARG = `(?:${SAFE_KV_ARG}|${SAFE_BOOL_ARG})`;
const SAFE_CLI_ARGS = `${SAFE_CLI_ARG}(?:\\s+${SAFE_CLI_ARG})*`;
const PRISMA_DB_PUSH_ARG = `(?:--accept-data-loss|--force-reset|--skip-generate|--schema=${SAFE_ARG_VALUE})`;
const PRISMA_DB_PUSH_ARGS = `${PRISMA_DB_PUSH_ARG}(?:\\s+${PRISMA_DB_PUSH_ARG})*`;

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "bun install", re: new RegExp(`^bun install$`) },
  { name: "bun install --frozen-lockfile", re: new RegExp(`^bun install --frozen-lockfile$`) },
  { name: "bun --version", re: /^bun --version$/ },
  { name: "bunx prisma generate", re: new RegExp(`^bunx prisma generate$`) },
  { name: "bunx prisma db push <safe flags>", re: new RegExp(`^bunx prisma db push(?:\\s+${PRISMA_DB_PUSH_ARGS})?$`) },
  { name: "bun run <script>", re: new RegExp(`^bun run ${SCRIPT}$`) },
  { name: "bun run <script> <safe flags>", re: new RegExp(`^bun run ${SCRIPT}\\s+${SAFE_CLI_ARGS}$`) },
  { name: "bun test", re: new RegExp(`^bun test$`) },
  { name: "bun test --isolate", re: new RegExp(`^bun test --isolate$`) },
  { name: "bun test --parallel=<n>", re: new RegExp(`^bun test --parallel=${NUM}$`) },
  { name: "bun test <path>", re: new RegExp(`^bun test ${REL_PATH}$`) },
  { name: "npm ci", re: new RegExp(`^npm ci$`) },
  { name: "npm run <script>", re: new RegExp(`^npm run ${SCRIPT}$`) },
  { name: "npm run <script> <safe flags>", re: new RegExp(`^npm run ${SCRIPT}\\s+${SAFE_CLI_ARGS}$`) },
  { name: "pnpm install --frozen-lockfile", re: new RegExp(`^pnpm install --frozen-lockfile$`) },
  { name: "pnpm run <script>", re: new RegExp(`^pnpm run ${SCRIPT}$`) },
  { name: "pnpm run <script> <safe flags>", re: new RegExp(`^pnpm run ${SCRIPT}\\s+${SAFE_CLI_ARGS}$`) },
  { name: "npx prisma generate", re: new RegExp(`^npx prisma generate$`) },
  { name: "npx prisma db push <safe flags>", re: new RegExp(`^npx prisma db push(?:\\s+${PRISMA_DB_PUSH_ARGS})?$`) },
  { name: "node --version", re: /^node --version$/ },
  { name: "node <path>", re: new RegExp(`^node ${REL_PATH}$`) },
  { name: "node <path> <safe flags>", re: new RegExp(`^node ${REL_PATH}\\s+${SAFE_CLI_ARGS}$`) },
  { name: "git clone https://github.com/txtx/surfpool.git", re: /^git clone https:\/\/github\.com\/txtx\/surfpool\.git$/ },
  { name: "git clone https://github.com/solana-foundation/surfpool.git", re: /^git clone https:\/\/github\.com\/solana-foundation\/surfpool\.git$/ },
  { name: "cargo surfpool-install", re: /^cargo surfpool-install$/ },
  { name: "rustup-init -y", re: /^rustup-init -y$/ },
  { name: "surfpool start", re: /^surfpool start$/ },
  { name: "curl loopback GET", re: /^curl -s http:\/\/(?:127\.0\.0\.1|localhost):8899$/ },
  { name: "curl loopback RPC POST --data-base64 <base64url-json>", re: new RegExp(`^curl -s http://(?:127\\.0\\.0\\.1|localhost):8899 -X POST --data-base64 ${B64URL}$`) },
  { name: "bun run scripts/<script>.ts <safe flags>", re: new RegExp(`^bun run ${SCRIPT_TS}(?:\\s+${SAFE_CLI_ARGS})?$`) },
  { name: "sleep <seconds>", re: new RegExp(`^sleep ${NUM}$`) },
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
  if (/(^|\s|=)\//.test(cmd)) return "absolute path";
  return null;
}

function validateLoopbackCurlPayload(cmd: string): string | null {
  const match = cmd.match(/^curl -s http:\/\/(?:127\.0\.0\.1|localhost):8899 -X POST --data-base64 ([A-Za-z0-9_-]+={0,2})$/);
  if (!match) return null;
  try {
    const json = Buffer.from(match[1], "base64url").toString("utf8");
    if (json.length > 8192) return "curl JSON payload too large";
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "curl JSON payload must decode to an object";
    }
    return null;
  } catch {
    return "curl JSON payload must be valid base64url-encoded JSON";
  }
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

  const sleep = trimmed.match(/^sleep ([0-9]+)$/);
  if (sleep && Number(sleep[1]) > 32_400) {
    return { ok: false, reason: "sleep duration exceeds 32400 seconds" };
  }
  const curlPayloadError = validateLoopbackCurlPayload(trimmed);
  if (curlPayloadError) return { ok: false, reason: curlPayloadError };

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
