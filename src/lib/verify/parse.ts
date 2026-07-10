// Parses a validated command string into a safe spawn invocation.
//
// The runner never uses a shell. The validator rejects shell operators and path
// escapes before this parser receives the command, so whitespace tokenization is
// deterministic for the supported developer command grammar.

import path from "node:path";

export interface ParsedCommand {
  program: string;
  args: string[];
  env: Record<string, string>;
  readFile?: string;
}

function venvBin(executable: string): string {
  return process.platform === "win32"
    ? path.join(".venv", "Scripts", executable.endsWith(".exe") ? executable : `${executable}.exe`)
    : path.join(".venv", "bin", executable);
}

function pythonJobEnv(): Record<string, string> {
  return {
    VIRTUAL_ENV: ".venv",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    PIP_CACHE_DIR: ".verify-cache/pip",
    UV_CACHE_DIR: ".verify-cache/uv",
    UV_PROJECT_ENVIRONMENT: ".venv",
    POETRY_VIRTUALENVS_CREATE: "true",
    POETRY_VIRTUALENVS_IN_PROJECT: "true",
    PIPENV_VENV_IN_PROJECT: "1",
    PIPENV_NOSPIN: "1",
  };
}

function normalizePythonInvocation(
  program: string,
  args: string[],
  env: Record<string, string>
): ParsedCommand | null {
  if (program !== "python" && program !== "python3") return null;

  const runtimeInfo = args.length === 1 && ["--version", "--help", "-V"].includes(args[0]);
  const createsVenv = args[0] === "-m" && args[1] === "venv" && args[args.length - 1] === ".venv";

  // Runtime discovery and virtualenv creation must use the host/toolchain
  // interpreter. All project work below is isolated inside `.venv`.
  if (runtimeInfo || createsVenv) {
    return { program, args, env: { ...env, ...pythonJobEnv() } };
  }

  return {
    program: venvBin("python"),
    args,
    env: { ...env, ...pythonJobEnv() },
  };
}

const DIRECT_VENV_TOOLS = new Set([
  "pytest",
  "ruff",
  "mypy",
  "pyright",
  "tox",
  "nox",
  "coverage",
  "django-admin",
]);

export function parseCommand(command: string): ParsedCommand {
  const tokens = command.trim().split(/\s+/);
  const env: Record<string, string> = {};
  let index = 0;

  while (index < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[index])) {
    const separator = tokens[index].indexOf("=");
    const key = tokens[index].slice(0, separator);
    const value = tokens[index].slice(separator + 1);
    env[key] = value;
    index++;
  }

  const rest = tokens.slice(index);
  const program = rest[0];
  const args = rest.slice(1);

  if (program === "cat" && args.length === 1 && args[0].startsWith("reports/")) {
    return { program, args, env, readFile: args[0] };
  }

  const python = normalizePythonInvocation(program, args, env);
  if (python) return python;

  if (DIRECT_VENV_TOOLS.has(program)) {
    return {
      program: venvBin(program),
      args,
      env: { ...env, ...pythonJobEnv() },
    };
  }

  // uv/uvx, Poetry, and Pipenv manage the same workspace-local `.venv` through
  // their documented environment variables. Their binaries remain host tools;
  // project executables launched through `run` live inside `.venv`.
  if (["uv", "uvx", "poetry", "pipenv"].includes(program)) {
    return { program, args, env: { ...env, ...pythonJobEnv() } };
  }

  if (
    program === "curl" &&
    args.length === 6 &&
    args[0] === "-s" &&
    /^http:\/\/(?:127\.0\.0\.1|localhost):8899$/.test(args[1]) &&
    args[2] === "-X" &&
    args[3] === "POST" &&
    args[4] === "--data-base64"
  ) {
    const body = Buffer.from(args[5], "base64url").toString("utf8");
    return {
      program,
      args: ["-s", args[1], "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", body],
      env,
    };
  }

  return { program, args, env };
}
