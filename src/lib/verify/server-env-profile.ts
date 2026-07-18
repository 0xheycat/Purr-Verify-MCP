import {
  resolveInlineServerEnvRefs,
  type ServerEnvRefResolution,
} from "./server-env-ref";

const PROFILE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PROFILE_ENV_VARS = 50;
const MAX_VALUE_LENGTH = 4_096;

type EnvironmentSource = Record<string, string | undefined>;

export interface ServerEnvProfileResolution extends ServerEnvRefResolution {
  profile?: string;
}

/**
 * Parse operator-owned profiles from a JSON object such as:
 *
 *   VERIFY_SERVER_ENV_PROFILES={"smoke":{"MODE":"fork","TOKEN":"@server:runtime"}}
 *
 * Profile contents never need to be supplied by the client. Invalid profiles
 * are ignored and therefore fail closed when requested.
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
    if (entries.length === 0 || entries.length > MAX_PROFILE_ENV_VARS) continue;
    const env: Record<string, string> = {};
    let valid = true;
    for (const [key, value] of entries) {
      if (
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

/**
 * Resolve one server-owned profile plus optional explicit non-conflicting env.
 * Resolution happens before durable job creation. Only the profile label may
 * be persisted; profile contents, source keys, and resolved values remain in
 * runtime memory.
 */
export function resolveServerEnvProfile(
  profileName: string | undefined,
  explicitEnv: Record<string, string> = {},
  options: {
    profilesRaw?: string;
    allowlistRaw?: string;
    sourceEnv?: EnvironmentSource;
  } = {},
): ServerEnvProfileResolution {
  if (profileName == null || profileName.trim() === "") {
    return resolveInlineServerEnvRefs(explicitEnv, {
      allowlistRaw: options.allowlistRaw,
      sourceEnv: options.sourceEnv,
    });
  }

  const profile = profileName.trim().toLowerCase();
  if (!PROFILE_RE.test(profile)) {
    return {
      ok: false,
      reason: "invalid server environment profile name",
      env: {},
      aliases: [],
    };
  }

  const profileEnv = parseServerEnvProfiles(options.profilesRaw).get(profile);
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
  if (Object.keys(profileEnv).length + Object.keys(explicitEnv).length > MAX_PROFILE_ENV_VARS) {
    return {
      ok: false,
      reason: `combined environment exceeds max ${MAX_PROFILE_ENV_VARS} vars`,
      env: {},
      aliases: [],
    };
  }

  const resolved = resolveInlineServerEnvRefs(
    { ...profileEnv, ...explicitEnv },
    {
      allowlistRaw: options.allowlistRaw,
      sourceEnv: options.sourceEnv,
    },
  );
  return resolved.ok ? { ...resolved, profile } : resolved;
}
