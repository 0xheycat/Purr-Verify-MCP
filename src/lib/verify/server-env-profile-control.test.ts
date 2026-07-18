import { afterEach, describe, expect, test } from "bun:test";
import {
  parseServerEnvProfiles,
  resolveInlineServerEnvRefs,
} from "./server-env-ref";
import {
  createJob,
  deleteJob,
  flushJobPersistence,
  getRuntime,
  setJobStatus,
} from "./store";

const originalProfiles = process.env.VERIFY_SERVER_ENV_PROFILES;
const originalAllowlist = process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
const originalRuntimeValue = process.env.PURR_TEST_PROFILE_VALUE;

afterEach(() => {
  if (originalProfiles === undefined) delete process.env.VERIFY_SERVER_ENV_PROFILES;
  else process.env.VERIFY_SERVER_ENV_PROFILES = originalProfiles;

  if (originalAllowlist === undefined) delete process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
  else process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = originalAllowlist;

  if (originalRuntimeValue === undefined) delete process.env.PURR_TEST_PROFILE_VALUE;
  else process.env.PURR_TEST_PROFILE_VALUE = originalRuntimeValue;
});

describe("server environment profile selector", () => {
  test("parses valid profiles and ignores malformed entries", () => {
    const profiles = parseServerEnvProfiles(
      JSON.stringify({
        Smoke: { MODE: "fork", TARGET_RUNTIME_VALUE: "@server:runtime" },
        "bad profile": { MODE: "bad" },
        empty: {},
        invalidValue: { MODE: 1 },
        recursive: { VERIFY_SERVER_ENV_PROFILE: "other" },
      }),
    );

    expect([...profiles.entries()]).toEqual([
      [
        "smoke",
        { MODE: "fork", TARGET_RUNTIME_VALUE: "@server:runtime" },
      ],
    ]);
  });

  test("expands one safe selector and consumes the control key", () => {
    const result = resolveInlineServerEnvRefs(
      {
        VERIFY_SERVER_ENV_PROFILE: "SMOKE",
        EXTRA_MODE: "bounded",
      },
      {
        profilesRaw: JSON.stringify({
          smoke: { MODE: "fork", TARGET_RUNTIME_VALUE: "@server:runtime" },
        }),
        allowlistRaw: "runtime=PURR_TEST_PROFILE_VALUE",
        sourceEnv: { PURR_TEST_PROFILE_VALUE: "runtime-value-123" },
      },
    );

    expect(result).toEqual({
      ok: true,
      env: {
        MODE: "fork",
        TARGET_RUNTIME_VALUE: "runtime-value-123",
        EXTRA_MODE: "bounded",
      },
      aliases: ["runtime"],
      profile: "smoke",
    });
    expect(result.env).not.toHaveProperty("VERIFY_SERVER_ENV_PROFILE");
  });

  test("fails closed for unavailable profiles and explicit conflicts", () => {
    expect(
      resolveInlineServerEnvRefs(
        { VERIFY_SERVER_ENV_PROFILE: "missing" },
        { profilesRaw: JSON.stringify({ smoke: { MODE: "fork" } }) },
      ),
    ).toMatchObject({
      ok: false,
      reason: "server environment profile is unavailable: missing",
    });

    expect(
      resolveInlineServerEnvRefs(
        { VERIFY_SERVER_ENV_PROFILE: "smoke", MODE: "override" },
        { profilesRaw: JSON.stringify({ smoke: { MODE: "fork" } }) },
      ),
    ).toMatchObject({
      ok: false,
      reason: "explicit env conflicts with server environment profile: MODE",
    });
  });

  test("fails closed before job creation when a backing alias is unavailable", () => {
    expect(
      resolveInlineServerEnvRefs(
        { VERIFY_SERVER_ENV_PROFILE: "smoke" },
        {
          profilesRaw: JSON.stringify({
            smoke: { TARGET_RUNTIME_VALUE: "@server:runtime" },
          }),
          allowlistRaw: "runtime=PURR_TEST_PROFILE_VALUE",
          sourceEnv: {},
        },
      ),
    ).toMatchObject({
      ok: false,
      reason: "server environment alias is unavailable: runtime",
    });
  });

  test("createJob keeps profile contents and resolved values runtime-only", async () => {
    process.env.VERIFY_SERVER_ENV_PROFILES = JSON.stringify({
      smoke: {
        MODE: "fork",
        TARGET_RUNTIME_VALUE: "@server:runtime",
      },
    });
    process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = "runtime=PURR_TEST_PROFILE_VALUE";
    process.env.PURR_TEST_PROFILE_VALUE = "runtime-value-456";

    const job = createJob({
      repo: "owner/repo",
      ref: "main",
      commands: ["node --version"],
      continue_on_error: false,
      metadata: { purpose: "server env profile test" },
      env: { VERIFY_SERVER_ENV_PROFILE: "smoke" },
    });

    const durable = JSON.stringify(job);
    expect(durable).not.toContain("runtime-value-456");
    expect(durable).not.toContain("TARGET_RUNTIME_VALUE");
    expect(durable).not.toContain("VERIFY_SERVER_ENV_PROFILE");
    expect(getRuntime(job.jobId)?.env).toEqual({
      MODE: "fork",
      TARGET_RUNTIME_VALUE: "runtime-value-456",
    });

    setJobStatus(job.jobId, "success");
    await flushJobPersistence(job.jobId);
    expect(await deleteJob(job.jobId)).toBe(true);
  });
});
