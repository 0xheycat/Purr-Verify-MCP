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
diff --git a/src/lib/verify/store.ts b/src/lib/verify/store.ts
--- a/src/lib/verify/store.ts
+++ b/src/lib/verify/store.ts
@@ -9,7 +9,7 @@ import fs from "node:fs/promises";
 import path from "node:path";
 import { getConfig } from "./config";
-import { resolveInlineServerEnvRefs } from "./server-env-ref";
+import { resolveServerEnvProfile } from "./server-env-profile";
 import {
   getHistoryDatabase,
   historyBackendStatus,
@@ -291,12 +291,13 @@ export function createJob(input: {
   tags?: string[];
   githubToken?: string;
   env?: Record<string, string>;
+  serverEnvProfile?: string;
   resolutionProbePackages?: string[];
   resolutionProbeModules?: ResolutionProbeModuleRequest[];
   timeoutPolicy?: Job["timeoutPolicy"];
   execution?: ExecutionRoutingRecord;
 }): Job {
-  const resolvedEnv = resolveInlineServerEnvRefs(input.env ?? {});
+  const resolvedEnv = resolveServerEnvProfile(input.serverEnvProfile, input.env ?? {});
   if (!resolvedEnv.ok) {
     throw new Error(resolvedEnv.reason ?? "server environment reference resolution failed");
   }
diff --git a/src/lib/verify/types.ts b/src/lib/verify/types.ts
--- a/src/lib/verify/types.ts
+++ b/src/lib/verify/types.ts
@@ -105,6 +105,12 @@ export interface VerifyRequest {
    * DYLD_INSERT_LIBRARIES) are rejected. See validateEnv in mcp.ts.
    */
   env?: Record<string, string>;
+  /**
+   * Optional operator-owned environment profile. The client sends only this
+   * safe label; profile contents and resolved values stay server-side and are
+   * injected into runtime memory before job creation.
+   */
+  server_env_profile?: string;
   /** Optional diagnostic: package names to resolve from the cloned workspace after install. */
   resolution_probe?: string[] | ResolutionProbeRequest;
   /** Execution mode. "auto" runs one short smoke command inline and routes long-running work to async. */
diff --git a/src/lib/verify/mcp.ts b/src/lib/verify/mcp.ts
--- a/src/lib/verify/mcp.ts
+++ b/src/lib/verify/mcp.ts
@@ -101,6 +101,11 @@ const TOOLS: ToolDef[] = [
           additionalProperties: { type: "string" },
           description: "Optional environment variables (string values) injected into every command's process environment. Values may contain secrets — they are redacted from stored logs, results, and share links, and are never persisted to disk. Reserved keys (PATH, NODE_PATH, NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES) are rejected. Max 50 vars.",
         },
+        server_env_profile: {
+          type: "string",
+          description:
+            "Optional operator-owned environment profile label. The client sends only the label; profile contents and resolved values remain server-side and are injected into runtime memory before durable job creation.",
+        },
         resolution_probe: {
           oneOf: [
             { type: "array", items: { type: "string" } },
@@ -310,7 +315,11 @@ export async function handleMcp(req: NextRequest): Promise<NextResponse> {
               commands: validation.commands!,
               continue_on_error: !!input.continue_on_error,
-              metadata: (input.metadata as Record<string, unknown>) || {},
+              metadata: {
+                ...((input.metadata as Record<string, unknown>) || {}),
+                ...(validation.serverEnvProfile
+                  ? { _purrServerEnvProfile: validation.serverEnvProfile }
+                  : {}),
+              },
               callback_url: input.callback_url?.trim() || undefined,
               tags: validation.tags,
               // Per-request GitHub clone token (github_passthrough mode).
@@ -319,6 +328,7 @@ export async function handleMcp(req: NextRequest): Promise<NextResponse> {
               // Optional per-job env injection (validated + redacted from logs).
               env: validation.env,
+              serverEnvProfile: validation.serverEnvProfile,
               resolutionProbePackages: validation.resolutionProbePackages,
               resolutionProbeModules: validation.resolutionProbeModules,
               timeoutPolicy: validation.timeoutPolicy,
@@ -451,6 +461,7 @@ export function validateCreateInput(input: VerifyRequest): {
   commands?: string[];
   tags?: string[];
   env?: Record<string, string>;
+  serverEnvProfile?: string;
   resolutionProbePackages?: string[];
   resolutionProbeModules?: ResolutionProbeModuleRequest[];
   timeoutPolicy?: Job["timeoutPolicy"];
@@ -472,6 +483,9 @@ export function validateCreateInput(input: VerifyRequest): {
   const ev = validateEnv(input.env);
   if (!ev.ok) return { ok: false, reason: ev.reason };
+  const profile = validateServerEnvProfile(input.server_env_profile);
+  if (!profile.ok) return { ok: false, reason: profile.reason };
   const rp = validateResolutionProbe(input.resolution_probe);
   if (!rp.ok) return { ok: false, reason: rp.reason };
   const timeoutPolicy = validateTimeoutPolicy(input);
@@ -483,6 +497,7 @@ export function validateCreateInput(input: VerifyRequest): {
     commands: cv.commands,
     tags: tv.tags,
     env: ev.env,
+    serverEnvProfile: profile.profile,
     resolutionProbePackages: rp.packages,
     resolutionProbeModules: rp.modules,
     timeoutPolicy: timeoutPolicy.policy,
@@ -490,6 +505,22 @@ export function validateCreateInput(input: VerifyRequest): {
 }
 
+export function validateServerEnvProfile(value: unknown): {
+  ok: boolean;
+  reason?: string;
+  profile?: string;
+} {
+  if (value == null || value === "") return { ok: true };
+  if (typeof value !== "string") {
+    return { ok: false, reason: "server_env_profile must be a string" };
+  }
+  const profile = value.trim().toLowerCase();
+  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(profile)) {
+    return { ok: false, reason: "invalid server_env_profile" };
+  }
+  return { ok: true, profile };
+}
+
 export function validateTimeoutPolicy(input: VerifyRequest): {
   ok: boolean;
   reason?: string;
diff --git a/src/lib/verify/server-env-profile.test.ts b/src/lib/verify/server-env-profile.test.ts
new file mode 100644
--- /dev/null
+++ b/src/lib/verify/server-env-profile.test.ts
@@ -0,0 +1,152 @@
+import { afterEach, describe, expect, test } from "bun:test";
+import {
+  parseServerEnvProfiles,
+  resolveServerEnvProfile,
+} from "./server-env-profile";
+import {
+  createJob,
+  deleteJob,
+  flushJobPersistence,
+  getRuntime,
+  setJobStatus,
+} from "./store";
+
+const originalProfiles = process.env.VERIFY_SERVER_ENV_PROFILES;
+const originalAllowlist = process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
+const originalRuntimeValue = process.env.PURR_TEST_PROFILE_VALUE;
+
+afterEach(() => {
+  if (originalProfiles === undefined) delete process.env.VERIFY_SERVER_ENV_PROFILES;
+  else process.env.VERIFY_SERVER_ENV_PROFILES = originalProfiles;
+
+  if (originalAllowlist === undefined) delete process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
+  else process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = originalAllowlist;
+
+  if (originalRuntimeValue === undefined) delete process.env.PURR_TEST_PROFILE_VALUE;
+  else process.env.PURR_TEST_PROFILE_VALUE = originalRuntimeValue;
+});
+
+describe("server environment profiles", () => {
+  test("parses valid profiles and ignores malformed entries", () => {
+    const profiles = parseServerEnvProfiles(
+      JSON.stringify({
+        Smoke: { MODE: "fork", TARGET_RUNTIME_VALUE: "@server:runtime" },
+        "bad profile": { MODE: "bad" },
+        empty: {},
+        invalidValue: { MODE: 1 },
+      }),
+    );
+
+    expect([...profiles.entries()]).toEqual([
+      [
+        "smoke",
+        { MODE: "fork", TARGET_RUNTIME_VALUE: "@server:runtime" },
+      ],
+    ]);
+  });
+
+  test("resolves static values and allowlisted aliases from one safe label", () => {
+    const result = resolveServerEnvProfile("SMOKE", { EXTRA_MODE: "bounded" }, {
+      profilesRaw: JSON.stringify({
+        smoke: { MODE: "fork", TARGET_RUNTIME_VALUE: "@server:runtime" },
+      }),
+      allowlistRaw: "runtime=PURR_TEST_PROFILE_VALUE",
+      sourceEnv: { PURR_TEST_PROFILE_VALUE: "runtime-value-123" },
+    });
+
+    expect(result).toEqual({
+      ok: true,
+      env: {
+        MODE: "fork",
+        TARGET_RUNTIME_VALUE: "runtime-value-123",
+        EXTRA_MODE: "bounded",
+      },
+      aliases: ["runtime"],
+      profile: "smoke",
+    });
+  });
+
+  test("fails closed for unavailable profiles and explicit conflicts", () => {
+    expect(
+      resolveServerEnvProfile("missing", {}, {
+        profilesRaw: JSON.stringify({ smoke: { MODE: "fork" } }),
+      }),
+    ).toMatchObject({
+      ok: false,
+      reason: "server environment profile is unavailable: missing",
+    });
+
+    expect(
+      resolveServerEnvProfile("smoke", { MODE: "override" }, {
+        profilesRaw: JSON.stringify({ smoke: { MODE: "fork" } }),
+      }),
+    ).toMatchObject({
+      ok: false,
+      reason: "explicit env conflicts with server environment profile: MODE",
+    });
+  });
+
+  test("fails closed before job creation when a backing alias is unavailable", () => {
+    expect(
+      resolveServerEnvProfile("smoke", {}, {
+        profilesRaw: JSON.stringify({
+          smoke: { TARGET_RUNTIME_VALUE: "@server:runtime" },
+        }),
+        allowlistRaw: "runtime=PURR_TEST_PROFILE_VALUE",
+        sourceEnv: {},
+      }),
+    ).toMatchObject({
+      ok: false,
+      reason: "server environment alias is unavailable: runtime",
+    });
+  });
+
+  test("createJob keeps profile contents and resolved values runtime-only", async () => {
+    process.env.VERIFY_SERVER_ENV_PROFILES = JSON.stringify({
+      smoke: {
+        MODE: "fork",
+        TARGET_RUNTIME_VALUE: "@server:runtime",
+      },
+    });
+    process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = "runtime=PURR_TEST_PROFILE_VALUE";
+    process.env.PURR_TEST_PROFILE_VALUE = "runtime-value-456";
+
+    const job = createJob({
+      repo: "owner/repo",
+      ref: "main",
+      commands: ["node --version"],
+      continue_on_error: false,
+      metadata: { purpose: "server env profile test" },
+      serverEnvProfile: "smoke",
+    });
+
+    const durable = JSON.stringify(job);
+    expect(durable).not.toContain("runtime-value-456");
+    expect(durable).not.toContain("TARGET_RUNTIME_VALUE");
+    expect(durable).not.toContain("@server:runtime");
+    expect(getRuntime(job.jobId)?.env).toEqual({
+      MODE: "fork",
+      TARGET_RUNTIME_VALUE: "runtime-value-456",
+    });
+
+    setJobStatus(job.jobId, "success");
+    await flushJobPersistence(job.jobId);
+    expect(await deleteJob(job.jobId)).toBe(true);
+  });
+});