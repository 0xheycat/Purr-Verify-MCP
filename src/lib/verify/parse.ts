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

  return { program, args, env };
}
