import { afterEach, describe, expect, test } from "bun:test";
import {
  listServerEnvAliases,
  parseServerEnvRefAllowlist,
  resolveInlineServerEnvRefs,
} from "./server-env-ref";
import {
  createJob,
  deleteJob,
  flushJobPersistence,
  getRuntime,
  setJobStatus,
} from "./store";

const originalAllowlist = process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
const originalRuntimeValue = process.env.PURR_TEST_RUNTIME_VALUE;

afterEach(() => {
  if (originalAllowlist === undefined) delete process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
  else process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = originalAllowlist;

  if (originalRuntimeValue === undefined) delete process.env.PURR_TEST_RUNTIME_VALUE;
  else process.env.PURR_TEST_RUNTIME_VALUE = originalRuntimeValue;
});

describe("allowlisted server environment references", () => {
  test("parses valid alias mappings and ignores malformed entries", () => {
    const parsed = parseServerEnvRefAllowlist(
      "runtime=PURR_TEST_RUNTIME_VALUE, malformed, bad alias=OTHER, rpc=SOLANA_RPC_URL",
    );
    expect([...parsed.entries()]).toEqual([
      ["runtime", "PURR_TEST_RUNTIME_VALUE"],
      ["rpc", "SOLANA_RPC_URL"],
    ]);
  });

  test("discovers normalized sorted aliases without source keys or values", () => {
    const sourceValue = "resolved-secret-value";
    const result = listServerEnvAliases(
      "zeta=PURR_ZETA, malformed, Alpha=PURR_ALPHA, bad alias=PURR_BAD, alpha=PURR_ALPHA_OVERRIDE, beta=PURR_BETA",
    );

    expect(result).toEqual({
      configured: true,
      aliases: ["alpha", "beta", "zeta"],
      valuesIncluded: false,
      sourceKeysIncluded: false,
    });
    expect(JSON.stringify(result)).not.toContain("PURR_ALPHA_OVERRIDE");
    expect(JSON.stringify(result)).not.toContain(sourceValue);
  });

  test("reports an empty configuration while hiding malformed entries", () => {
    expect(listServerEnvAliases("malformed, bad alias=NOPE, =MISSING_ALIAS")).toEqual({
      configured: false,
      aliases: [],
      valuesIncluded: false,
      sourceKeysIncluded: false,
    });
  });

  test("keeps plain values and resolves an allowlisted server alias", () => {
    const runtimeValue = "runtime-value-123";
    const result = resolveInlineServerEnvRefs(
      {
        PURR_ENV: "fork",
        TARGET_RUNTIME_VALUE: "@server:runtime",
      },
      {
        allowlistRaw: "runtime=PURR_TEST_RUNTIME_VALUE",
        sourceEnv: { PURR_TEST_RUNTIME_VALUE: runtimeValue },
      },
    );

    expect(result).toEqual({
      ok: true,
      env: {
        PURR_ENV: "fork",
        TARGET_RUNTIME_VALUE: runtimeValue,
      },
      aliases: ["runtime"],
    });
    expect(JSON.stringify(result.aliases)).not.toContain(runtimeValue);
    expect(JSON.stringify(result.aliases)).not.toContain("PURR_TEST_RUNTIME_VALUE");
  });

  test("fails closed for malformed, unallowlisted, unavailable, or reserved refs", () => {
    expect(
      resolveInlineServerEnvRefs(
        { TARGET_RUNTIME_VALUE: "@server:bad alias" },
        { allowlistRaw: "runtime=PURR_TEST_RUNTIME_VALUE", sourceEnv: {} },
      ),
    ).toMatchObject({
      ok: false,
      reason: "invalid server environment reference for TARGET_RUNTIME_VALUE",
    });

    expect(
      resolveInlineServerEnvRefs(
        { TARGET_RUNTIME_VALUE: "@server:unknown" },
        { allowlistRaw: "runtime=PURR_TEST_RUNTIME_VALUE", sourceEnv: {} },
      ),
    ).toMatchObject({
      ok: false,
      reason: "server environment alias is not allowlisted: unknown",
    });

    expect(
      resolveInlineServerEnvRefs(
        { TARGET_RUNTIME_VALUE: "@server:runtime" },
        { allowlistRaw: "runtime=PURR_TEST_RUNTIME_VALUE", sourceEnv: {} },
      ),
    ).toMatchObject({
      ok: false,
      reason: "server environment alias is unavailable: runtime",
    });

    expect(
      resolveInlineServerEnvRefs(
        { PATH: "@server:runtime" },
        {
          allowlistRaw: "runtime=PURR_TEST_RUNTIME_VALUE",
          sourceEnv: { PURR_TEST_RUNTIME_VALUE: "source-value" },
        },
      ),
    ).toMatchObject({
      ok: false,
      reason: "target environment key is reserved: PATH",
    });
  });

  test("createJob keeps resolved values only in runtime state", async () => {
    process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = "runtime=PURR_TEST_RUNTIME_VALUE";
    process.env.PURR_TEST_RUNTIME_VALUE = "runtime-value-456";

    const job = createJob({
      repo: "owner/repo",
      ref: "main",
      commands: ["node --version"],
      continue_on_error: false,
      metadata: { purpose: "server env ref test" },
      env: { TARGET_RUNTIME_VALUE: "@server:runtime" },
    });

    expect(JSON.stringify(job)).not.toContain("runtime-value-456");
    expect(JSON.stringify(job)).not.toContain("@server:runtime");
    expect(getRuntime(job.jobId)?.env).toEqual({
      TARGET_RUNTIME_VALUE: "runtime-value-456",
    });

    setJobStatus(job.jobId, "success");
    await flushJobPersistence(job.jobId);
    expect(await deleteJob(job.jobId)).toBe(true);
  });
});
