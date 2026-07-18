const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RESERVED = new Set([
  "PATH",
  "NODE_PATH",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
]);

export interface ServerEnvRefResolution {
  ok: boolean;
  reason?: string;
  env: Record<string, string>;
  aliases: string[];
}

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

export function resolveServerEnvRefs(
  value: unknown,
  directEnv: Record<string, string>,
  options: {
    allowlistRaw?: string;
    sourceEnv?: NodeJS.ProcessEnv;
    maxCombinedKeys?: number;
  } = {},
): ServerEnvRefResolution {
  if (value == null) return { ok: true, env: { ...directEnv }, aliases: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "server_env_refs must map target keys to aliases", env: {}, aliases: [] };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const max = options.maxCombinedKeys ?? 50;
  if (entries.length + Object.keys(directEnv).length > max) {
    return { ok: false, reason: `combined env and server_env_refs exceed max ${max} keys`, env: {}, aliases: [] };
  }

  const allowlist = parseServerEnvRefAllowlist(options.allowlistRaw);
  const sourceEnv = options.sourceEnv ?? process.env;
  const env = { ...directEnv };
  const aliases: string[] = [];

  for (const [targetKey, rawAlias] of entries) {
    if (!ENV_KEY_RE.test(targetKey)) {
      return { ok: false, reason: `invalid target env key: ${targetKey}`, env: {}, aliases: [] };
    }
    if (RESERVED.has(targetKey.toUpperCase())) {
      return { ok: false, reason: `target env key not allowed: ${targetKey}`, env: {}, aliases: [] };
    }
    if (Object.prototype.hasOwnProperty.call(directEnv, targetKey)) {
      return { ok: false, reason: `env and server_env_refs both define ${targetKey}`, env: {}, aliases: [] };
    }
    if (typeof rawAlias !== "string" || !ALIAS_RE.test(rawAlias.trim())) {
      return { ok: false, reason: `invalid server alias for ${targetKey}`, env: {}, aliases: [] };
    }
    const alias = rawAlias.trim().toLowerCase();
    const sourceKey = allowlist.get(alias);
    if (!sourceKey) {
      return { ok: false, reason: `server alias is not allowlisted: ${alias}`, env: {}, aliases: [] };
    }
    const resolvedValue = sourceEnv[sourceKey];
    if (typeof resolvedValue !== "string" || resolvedValue.length === 0) {
      return { ok: false, reason: `server alias is unavailable: ${alias}`, env: {}, aliases: [] };
    }
    if (resolvedValue.length > 16_384) {
      return { ok: false, reason: `server alias value is too long: ${alias}`, env: {}, aliases: [] };
    }
    env[targetKey] = resolvedValue;
    aliases.push(alias);
  }

  return { ok: true, env, aliases };
}
