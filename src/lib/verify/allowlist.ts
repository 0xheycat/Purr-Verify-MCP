// Command allowlist validator.
//
// SECURITY MODEL: this is still not a shell. Commands are parsed into an
// executable plus argv and spawned with shell:false. The policy blocks shell
// operators, path escapes, absolute paths, loader overrides, and destructive
// system commands, while keeping normal developer workflows usable.

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  matchedPattern?: string;
}

const SCRIPT = "[a-zA-Z0-9_.:-]+";
const SAFE_FILE = "[a-zA-Z0-9_.-]+";
const NUM = "[0-9]+";
const WORD = "[a-z0-9_-]+";
const SAFE_ARG_VALUE = "[A-Za-z0-9_./:@=+,-]+";
const B64URL = "[A-Za-z0-9_-]+={0,2}";
const SEG = "[a-zA-Z0-9_.-]+";
const REL_PATH = `${SEG}(?:/${SEG})*`;
const SCRIPT_TS = `scripts/${SEG}(?:/${SEG})*\\.ts`;
const SAFE_BOOL_ARG = `--[A-Za-z0-9_-]+`;
const SAFE_KV_ARG = `--[A-Za-z0-9_-]+=${SAFE_ARG_VALUE}`;
const SAFE_CLI_ARG = `(?:${SAFE_KV_ARG}|${SAFE_BOOL_ARG})`;
const SAFE_CLI_ARGS = `${SAFE_CLI_ARG}(?:\\s+${SAFE_CLI_ARG})*`;
const SAFE_FLAG = `(?:--(?:duration|poll-interval|manage-interval|heartbeat-interval|iterations|interval)=${NUM}|--mode=${WORD}|--execute=false)`;
const SAFE_FLAGS = `${SAFE_FLAG}(?:\\s+${SAFE_FLAG})*`;
const PRISMA_DB_PUSH_ARG = `(?:--accept-data-loss|--force-reset|--skip-generate|--schema=${SAFE_ARG_VALUE})`;
const PRISMA_DB_PUSH_ARGS = `${PRISMA_DB_PUSH_ARG}(?:\\s+${PRISMA_DB_PUSH_ARG})*`;

const PY_MODULE_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PY_SCRIPT_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$/;
const SAFE_DEV_TOKEN_RE = /^[A-Za-z0-9_./:@=+,%~\[\]-]+$/;
const SAFE_REQUIREMENT_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:txt|in)$/;
const SAFE_TOOL_RE = /^[A-Za-z0-9_.-]+$/;

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "bun install", re: /^bun install$/ },
  { name: "bun install --frozen-lockfile", re: /^bun install --frozen-lockfile$/ },
  { name: "bun --version", re: /^bun --version$/ },
  { name: "bunx prisma generate", re: /^bunx prisma generate$/ },
  { name: "bunx prisma db push <safe flags>", re: new RegExp(`^bunx prisma db push(?:\\s+${PRISMA_DB_PUSH_ARGS})?$`) },
  { name: "bun run <script>", re: new RegExp(`^bun run ${SCRIPT}$`) },
  { name: "bun run <script> <safe flags>", re: new RegExp(`^bun run ${SCRIPT}\\s+${SAFE_CLI_ARGS}$`) },
  { name: "bun test", re: /^bun test$/ },
  { name: "bun test --isolate", re: /^bun test --isolate$/ },
  { name: "bun test --parallel=<n>", re: new RegExp(`^bun test --parallel=${NUM}$`) },
  { name: "bun test <path>", re: new RegExp(`^bun test ${REL_PATH}$`) },
  { name: "npm ci", re: /^npm ci$/ },
  { name: "npm run <script>", re: new RegExp(`^npm run ${SCRIPT}$`) },
  { name: "npm run <script> <safe flags>", re: new RegExp(`^npm run ${SCRIPT}\\s+${SAFE_CLI_ARGS}$`) },
  { name: "pnpm install --frozen-lockfile", re: /^pnpm install --frozen-lockfile$/ },
  { name: "pnpm run <script>", re: new RegExp(`^pnpm run ${SCRIPT}$`) },
  { name: "pnpm run <script> <safe flags>", re: new RegExp(`^pnpm run ${SCRIPT}\\s+${SAFE_CLI_ARGS}$`) },
  { name: "npx prisma generate", re: /^npx prisma generate$/ },
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
  { name: "ENV_MODE=mock bun run scripts/manage.ts <flags>", re: new RegExp(`^ENV_MODE=mock bun run scripts/manage\\.ts(?:\\s+${SAFE_FLAGS})?$`) },
];

const FRIENDLY_PYTHON_PATTERNS = [
  "python/python3 --version|--help",
  "python/python3 -m venv .venv",
  "python/python3 -m <module> <safe args>",
  "python/python3 <relative-script.py> <safe args>",
  "pip requirements/local/package installs inside .venv",
  "uv sync|lock|run|build|python|pip|tool|tree|export",
  "uvx <tool> <safe args>",
  "poetry install|sync|lock|check|build|run|env|show|export",
  "pipenv sync|install|run|check|verify|requirements|graph",
  "pytest|ruff|mypy|pyright|tox|nox|coverage from .venv",
];

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
  "\"",
  "'",
  "--index-url",
  "--extra-index-url",
  "--trusted-host",
  "git+",
  "file://",
];

const FORBIDDEN_COMMAND_TOKENS = new Set([
  "rm",
  "mv",
  "cp",
  "sudo",
  "chmod",
  "chown",
  "ssh",
  "scp",
  "docker",
  "powershell",
  "nc",
  "netcat",
  "mkfs",
  "dd",
  "wget",
]);

function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function containsForbidden(command: string): string | null {
  const lower = command.toLowerCase();
  for (const value of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(value)) return value;
  }

  const tokens = tokenize(lower);
  for (const token of tokens) {
    if (FORBIDDEN_COMMAND_TOKENS.has(token)) return token;
  }

  if (/(^|\s|=)\//.test(command)) return "absolute path";
  return null;
}

function safeDeveloperArgs(args: string[]): boolean {
  return args.every((arg) => arg === "." || (SAFE_DEV_TOKEN_RE.test(arg) && !arg.includes("..") && !arg.startsWith("/")));
}

function validatePipArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  const action = args[0];

  if (["check", "list", "freeze", "debug", "--version", "--help"].includes(action)) {
    return safeDeveloperArgs(args.slice(1));
  }

  if (action === "show") {
    return args.length >= 2 && safeDeveloperArgs(args.slice(1));
  }

  if (action !== "install" && action !== "download" && action !== "wheel") return false;
  if (args.length < 2) return false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-r" || arg === "--requirement") {
      const file = args[++i];
      if (!file || !SAFE_REQUIREMENT_RE.test(file)) return false;
      continue;
    }
    if (!safeDeveloperArgs([arg])) return false;
  }
  return true;
}

function validatePythonCommand(command: string): ValidationResult | null {
  const tokens = tokenize(command);
  const program = tokens[0];
  const args = tokens.slice(1);

  if (program === "python" || program === "python3") {
    if (args.length === 1 && ["--version", "--help", "-V"].includes(args[0])) {
      return { ok: true, matchedPattern: "python runtime info" };
    }

    if (args[0] === "-c") {
      return { ok: false, reason: "inline python -c is not accepted; commit a script and run it by relative path" };
    }

    if (args[0] === "-m") {
      const moduleName = args[1];
      if (!moduleName || !PY_MODULE_RE.test(moduleName)) {
        return { ok: false, reason: "invalid Python module name" };
      }
      const moduleArgs = args.slice(2);
      if (moduleName === "venv") {
        const venvOk = moduleArgs.length >= 1 && moduleArgs[moduleArgs.length - 1] === ".venv" && safeDeveloperArgs(moduleArgs);
        return venvOk
          ? { ok: true, matchedPattern: "python -m venv .venv" }
          : { ok: false, reason: "Python virtualenv target must be .venv" };
      }
      if (moduleName === "pip") {
        return validatePipArgs(moduleArgs)
          ? { ok: true, matchedPattern: "python -m pip <developer args>" }
          : { ok: false, reason: "unsupported or unsafe pip arguments" };
      }
      return safeDeveloperArgs(moduleArgs)
        ? { ok: true, matchedPattern: "python -m <module> <developer args>" }
        : { ok: false, reason: "unsafe Python module arguments" };
    }

    if (args.length >= 1 && PY_SCRIPT_RE.test(args[0]) && safeDeveloperArgs(args.slice(1))) {
      return { ok: true, matchedPattern: "python <relative script.py> <developer args>" };
    }

    return { ok: false, reason: "unsupported Python invocation" };
  }

  if (program === "uv") {
    if (args.length === 1 && ["--version", "--help"].includes(args[0])) {
      return { ok: true, matchedPattern: "uv runtime info" };
    }
    const action = args[0];
    if (!["sync", "lock", "run", "build", "python", "pip", "tool", "tree", "export"].includes(action || "")) {
      return { ok: false, reason: "unsupported uv command" };
    }
    return safeDeveloperArgs(args.slice(1))
      ? { ok: true, matchedPattern: `uv ${action} <developer args>` }
      : { ok: false, reason: "unsafe uv arguments" };
  }

  if (program === "uvx") {
    return args.length >= 1 && SAFE_TOOL_RE.test(args[0]) && safeDeveloperArgs(args.slice(1))
      ? { ok: true, matchedPattern: "uvx <tool> <developer args>" }
      : { ok: false, reason: "unsafe uvx invocation" };
  }

  if (program === "poetry") {
    const action = args[0];
    if (action === "--version" || action === "--help") return { ok: true, matchedPattern: "poetry runtime info" };
    if (!["install", "sync", "lock", "check", "build", "run", "env", "show", "export"].includes(action || "")) {
      return { ok: false, reason: "unsupported poetry command" };
    }
    return safeDeveloperArgs(args.slice(1))
      ? { ok: true, matchedPattern: `poetry ${action} <developer args>` }
      : { ok: false, reason: "unsafe poetry arguments" };
  }

  if (program === "pipenv") {
    const action = args[0];
    if (action === "--version" || action === "--help") return { ok: true, matchedPattern: "pipenv runtime info" };
    if (!["sync", "install", "run", "check", "verify", "requirements", "graph"].includes(action || "")) {
      return { ok: false, reason: "unsupported pipenv command" };
    }
    return safeDeveloperArgs(args.slice(1))
      ? { ok: true, matchedPattern: `pipenv ${action} <developer args>` }
      : { ok: false, reason: "unsafe pipenv arguments" };
  }

  if (["pytest", "ruff", "mypy", "pyright", "tox", "nox", "coverage", "django-admin"].includes(program || "")) {
    return safeDeveloperArgs(args)
      ? { ok: true, matchedPattern: `${program} <developer args>` }
      : { ok: false, reason: `unsafe ${program} arguments` };
  }

  return null;
}

function validateLoopbackCurlPayload(command: string): string | null {
  const match = command.match(/^curl -s http:\/\/(?:127\.0\.0\.1|localhost):8899 -X POST --data-base64 ([A-Za-z0-9_-]+={0,2})$/);
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

export function validateCommand(command: string): ValidationResult {
  if (typeof command !== "string") return { ok: false, reason: "command must be a string" };
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "empty command" };
  if (trimmed.length > 1000) return { ok: false, reason: "command too long" };

  const forbidden = containsForbidden(trimmed);
  if (forbidden) return { ok: false, reason: `command contains forbidden token: ${forbidden}` };

  const python = validatePythonCommand(trimmed);
  if (python) return python;

  const sleep = trimmed.match(/^sleep ([0-9]+)$/);
  if (sleep && Number(sleep[1]) > 32_400) {
    return { ok: false, reason: "sleep duration exceeds 32400 seconds" };
  }

  const curlPayloadError = validateLoopbackCurlPayload(trimmed);
  if (curlPayloadError) return { ok: false, reason: curlPayloadError };

  for (const pattern of PATTERNS) {
    if (pattern.re.test(trimmed)) return { ok: true, matchedPattern: pattern.name };
  }
  return { ok: false, reason: "command does not match a supported developer workflow" };
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
    const command = commands[i];
    const result = validateCommand(command as string);
    if (!result.ok) return { ok: false, reason: `command #${i + 1} rejected: ${result.reason}` };
    out.push((command as string).trim());
  }
  return { ok: true, commands: out };
}

export function listPatterns(): string[] {
  return [...PATTERNS.map((pattern) => pattern.name), ...FRIENDLY_PYTHON_PATTERNS];
}
