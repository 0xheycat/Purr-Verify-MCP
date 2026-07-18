const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PROFILE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SERVER_REF_RE = /^@server:([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/;
const PROFILE_SELECTOR_KEY = "VERIFY_SERVER_ENV_PROFILE";
const MAX_ENV_VARS = 50;
const MAX_VALUE_LENGTH = 4_096;
const RESERVED_TARGET_KEYS = new Set([
  "PATH",
  "NODE_PATH",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
]);

type EnvironmentSource = Record<string, string | undefined>;

export interface ServerEnvRefResolution {
  ok: boolean;
  reason?: string;
  env: Record<string, string>;
  aliases: string[];
  profile?: string;
}

export interface ServerEnvAliasDiscovery {
  configured: boolean;
  aliases: string[];
  valuesIncluded: false;
  sourceKeysIncluded: false;
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
 * Return only the public alias labels from the operator-owned allowlist.
 * Source environment key names and resolved values are intentionally omitted.
 */
export function listServerEnvAliases(
  raw = process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST ?? "",
): ServerEnvAliasDiscovery {
  const aliases = [...parseServerEnvRefAllowlist(raw).keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  return {
    configured: aliases.length > 0,
    aliases,
    valuesIncluded: false,
    sourceKeysIncluded: false,
  };
}

/**
 * Parse operator-owned runtime profiles. Profile contents may contain plain
 * values and @server:<alias> references, but never resolved values.
 */
export function parseServerEnvProfiles(
  raw = process.env.VERIFY_SERVER_ENV_PROFILES ?? "",
): Map<string, Record<string, string>> {
  if (!raw.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Map();
  }

  const profiles = new Map<string, Record<string, string>>();
  for (const [rawName, rawEnv] of Object.entries(parsed as Record<string, unknown>)) {
    const name = rawName.trim().toLowerCase();
    if (!PROFILE_RE.test(name)) continue;
    if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) continue;

    const entries = Object.entries(rawEnv as Record<string, unknown>);
    if (entries.length === 0 || entries.length > MAX_ENV_VARS) continue;
    const env: Record<string, string> = {};
    let valid = true;
    for (const [key, value] of entries) {
      if (
        key === PROFILE_SELECTOR_KEY ||
        !ENV_KEY_RE.test(key) ||
        typeof value !== "string" ||
        value.length > MAX_VALUE_LENGTH
      ) {
        valid = false;
        break;
      }
      env[key] = value;
    }
    if (valid) profiles.set(name, env);
  }
  return profiles;
}

function expandServerEnvProfile(
  input: Record<string, string>,
  profilesRaw = process.env.VERIFY_SERVER_ENV_PROFILES ?? "",
): ServerEnvRefResolution {
  const explicitEnv = { ...input };
  const rawProfile = explicitEnv[PROFILE_SELECTOR_KEY];
  delete explicitEnv[PROFILE_SELECTOR_KEY];

  if (rawProfile == null || rawProfile.trim() === "") {
    return { ok: true, env: explicitEnv, aliases: [] };
  }

  const profile = rawProfile.trim().toLowerCase();
  if (!PROFILE_RE.test(profile)) {
    return {
      ok: false,
      reason: "invalid server environment profile name",
      env: {},
      aliases: [],
    };
  }

  const profileEnv = parseServerEnvProfiles(profilesRaw).get(profile);
  if (!profileEnv) {
    return {
      ok: false,
      reason: `server environment profile is unavailable: ${profile}`,
      env: {},
      aliases: [],
    };
  }

  for (const key of Object.keys(explicitEnv)) {
    if (Object.prototype.hasOwnProperty.call(profileEnv, key)) {
      return {
        ok: false,
        reason: `explicit env conflicts with server environment profile: ${key}`,
        env: {},
        aliases: [],
      };
    }
  }
  if (Object.keys(profileEnv).length + Object.keys(explicitEnv).length > MAX_ENV_VARS) {
    return {
      ok: false,
      reason: `combined environment exceeds max ${MAX_ENV_VARS} vars`,
      env: {},
      aliases: [],
    };
  }

  return {
    ok: true,
    env: { ...profileEnv, ...explicitEnv },
    aliases: [],
    profile,
  };
}

/**
 * Resolve env values written as @server:<alias>. Plain values are preserved.
 * A client may select one server-owned profile with the control key
 * VERIFY_SERVER_ENV_PROFILE; that selector is consumed and never reaches the
 * child process. Resolution happens before durable job creation, so a missing
 * profile or alias fails closed without creating durable job state.
 */
export function resolveInlineServerEnvRefs(
  input: Record<string, string>,
  options: {
    allowlistRaw?: string;
    profilesRaw?: string;
    sourceEnv?: EnvironmentSource;
  } = {},
): ServerEnvRefResolution {
  const expanded = expandServerEnvProfile(input, options.profilesRaw);
  if (!expanded.ok) return expanded;

  const allowlist = parseServerEnvRefAllowlist(options.allowlistRaw);
  const sourceEnv: EnvironmentSource = options.sourceEnv ?? process.env;
  const env: Record<string, string> = {};
  const aliases: string[] = [];

  for (const [targetKey, inputValue] of Object.entries(expanded.env)) {
    if (!ENV_KEY_RE.test(targetKey)) {
      return {
        ok: false,
        reason: `invalid target environment key: ${targetKey}`,
        env: {},
        aliases: [],
      };
    }
    if (RESERVED_TARGET_KEYS.has(targetKey.toUpperCase())) {
      return {
        ok: false,
        reason: `target environment key is reserved: ${targetKey}`,
        env: {},
        aliases: [],
      };
    }

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
    if (resolvedValue.length > MAX_VALUE_LENGTH) {
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

  return { ok: true, env, aliases, profile: expanded.profile };
}
