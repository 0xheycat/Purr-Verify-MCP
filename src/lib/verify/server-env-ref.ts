const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SERVER_REF_RE = /^@server:([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/;

export interface ServerEnvRefResolution {
  ok: boolean;
  reason?: string;
  env: Record<string, string>;
  aliases: string[];
}

/**
 * Parse an operator-owned allowlist such as:
 *
 *   VERIFY_SERVER_ENV_REF_ALLOWLIST=purr_llm=RUNTIME_VALUE_A,solana_rpc=RUNTIME_VALUE_B
 *
 * Requests may reference only the alias on the left. Source environment key
 * names and values never need to be sent by the client.
 */
export function parseServerEnvRefAllowlist(
  raw = process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST ?? "",
): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of raw.split(",")) {
    const entry = item.trim();
    if (!entry) continue;
    const split = entry.indexOf("=");
    if (split <= 0 || split === entry.length - 1) continue;
    const alias = entry.slice(0, split).trim().toLowerCase();
    const sourceKey = entry.slice(split + 1).trim();
    if (ALIAS_RE.test(alias) && ENV_KEY_RE.test(sourceKey)) out.set(alias, sourceKey);
  }
  return out;
}

/**
 * Resolve env values written as @server:<alias>. Plain values are preserved.
 * Resolution happens before a job is created, so a missing/unallowlisted alias
 * fails closed without creating durable job state. Returned aliases are safe
 * labels only; source key names and resolved values are never returned there.
 */
export function resolveInlineServerEnvRefs(
  input: Record<string, string>,
  options: {
    allowlistRaw?: string;
    sourceEnv?: NodeJS.ProcessEnv;
  } = {},
): ServerEnvRefResolution {
  const allowlist = parseServerEnvRefAllowlist(options.allowlistRaw);
  const sourceEnv = options.sourceEnv ?? process.env;
  const env: Record<string, string> = {};
  const aliases: string[] = [];

  for (const [targetKey, inputValue] of Object.entries(input)) {
    const reference = SERVER_REF_RE.exec(inputValue);
    if (!reference) {
      if (inputValue.startsWith("@server:")) {
        return {
          ok: false,
          reason: `invalid server environment reference for ${targetKey}`,
          env: {},
          aliases: [],
        };
      }
      env[targetKey] = inputValue;
      continue;
    }

    const alias = reference[1].toLowerCase();
    const sourceKey = allowlist.get(alias);
    if (!sourceKey) {
      return {
        ok: false,
        reason: `server environment alias is not allowlisted: ${alias}`,
        env: {},
        aliases: [],
      };
    }

    const resolvedValue = sourceEnv[sourceKey];
    if (typeof resolvedValue !== "string" || resolvedValue.length === 0) {
      return {
        ok: false,
        reason: `server environment alias is unavailable: ${alias}`,
        env: {},
        aliases: [],
      };
    }
    if (resolvedValue.length > 16_384) {
      return {
        ok: false,
        reason: `server environment alias value is too long: ${alias}`,
        env: {},
        aliases: [],
      };
    }

    env[targetKey] = resolvedValue;
    aliases.push(alias);
  }

  return { ok: true, env, aliases };
}
