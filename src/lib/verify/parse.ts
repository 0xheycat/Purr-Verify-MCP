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
