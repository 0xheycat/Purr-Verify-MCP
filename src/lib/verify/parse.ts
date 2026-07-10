// Parses a validated, allowlisted command string into a safe spawn invocation.
//
// Because the allowlist forbids quotes, shell metacharacters, and backslashes,
// naive whitespace splitting is safe here. This module NEVER uses a shell.

export interface ParsedCommand {
  program: string;
  args: string[];
  env: Record<string, string>;
  // For `cat reports/<file>.{json,txt}` we read the file directly instead of
  // spawning `cat`, which is safer and avoids needing the binary.
  readFile?: string;
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
  };
}

function normalizePythonInvocation(program: string, args: string[], env: Record<string, string>): ParsedCommand | null {
  if (program !== "python" && program !== "python3") return null;

  // Runtime discovery and venv creation must use the system interpreter.
  if ((args.length === 1 && args[0] === "--version") ||
      (args.length === 3 && args[0] === "-m" && args[1] === "venv" && args[2] === ".venv")) {
    return { program, args, env: { ...env, ...pythonJobEnv() } };
  }

  // Every other accepted Python command is forced through the workspace-local
  // virtualenv. This guarantees pip, pytest, build tools, and repo scripts never
  // mutate or depend on the runner's global Python site-packages.
  return {
    program: ".venv/bin/python",
    args,
    env: { ...env, ...pythonJobEnv() },
  };
}

export function parseCommand(cmd: string): ParsedCommand {
  const tokens = cmd.trim().split(/\s+/);
  const env: Record<string, string> = {};
  let i = 0;

  // Consume leading ENV=VALUE prefixes (only ENV_MODE=mock is allowlisted, but
  // handle the general shape for robustness).
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) {
    const eq = tokens[i].indexOf("=");
    const key = tokens[i].slice(0, eq);
    const val = tokens[i].slice(eq + 1);
    env[key] = val;
    i++;
  }

  const rest = tokens.slice(i);
  const program = rest[0];
  const args = rest.slice(1);

  // Special-case `cat reports/<file>` -> read file directly.
  if (program === "cat" && args.length === 1 && args[0].startsWith("reports/")) {
    return { program, args, env, readFile: args[0] };
  }

  // Special-case Python: accepted dependency/test/build commands run inside the
  // per-job `.venv`; only version probing and venv creation use system Python.
  const python = normalizePythonInvocation(program, args, env);
  if (python) return python;

  // uv creates/uses the same workspace `.venv`. Cache and bytecode settings are
  // scoped to the disposable job workspace and disappear during normal cleanup.
  if (program === "uv") {
    return { program, args, env: { ...env, ...pythonJobEnv() } };
  }

  // Special-case loopback JSON-RPC curl. The allowlist accepts a base64url
  // JSON token instead of shell-quoted JSON so callers cannot smuggle shell
  // syntax and `spawn(..., shell:false)` still receives the real JSON body.
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
