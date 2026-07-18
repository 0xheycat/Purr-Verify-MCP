import { afterEach, describe, expect, test } from "bun:test";
import {
  SERVER_ENV_ALIAS_MCP_TOOLS,
  handleServerEnvAliasMcpTool,
} from "./server-env-alias-mcp";

const originalAllowlist = process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
const originalProfiles = process.env.VERIFY_SERVER_ENV_PROFILES;

afterEach(() => {
  if (originalAllowlist === undefined) delete process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
  else process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = originalAllowlist;

  if (originalProfiles === undefined) delete process.env.VERIFY_SERVER_ENV_PROFILES;
  else process.env.VERIFY_SERVER_ENV_PROFILES = originalProfiles;
});

describe("server environment discovery MCP surface", () => {
  test("exposes read-only alias and profile discovery tools", () => {
    expect(SERVER_ENV_ALIAS_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "purr_list_server_env_aliases",
      "purr_list_server_env_profiles",
    ]);
    expect(
      SERVER_ENV_ALIAS_MCP_TOOLS.every(
        (tool) =>
          tool.annotations.readOnlyHint === true &&
          tool.annotations.destructiveHint === false &&
          tool.annotations.idempotentHint === true,
      ),
    ).toBe(true);
  });

  test("returns public aliases without source keys or values", () => {
    process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST =
      "Beta=PURR_DISCOVERY_BETA,alpha=PURR_DISCOVERY_ALPHA";

    expect(handleServerEnvAliasMcpTool("purr_list_server_env_aliases")).toEqual({
      handled: true,
      payload: {
        configured: true,
        aliases: ["alpha", "beta"],
        valuesIncluded: false,
        sourceKeysIncluded: false,
      },
    });
  });

  test("returns reusable profile labels and safe diagnostics only", () => {
    process.env.VERIFY_SERVER_ENV_PROFILES = JSON.stringify({
      Shared_Node_CI: { NODE_ENV: "test" },
      purrliquid_observability_smoke: {
        PURR_ENV: "fork",
        RUNTIME_VALUE: "@server:runtime_api_key",
      },
      "bad profile": { VALUE: "ignored" },
      empty: {},
    });

    const result = handleServerEnvAliasMcpTool("purr_list_server_env_profiles");
    expect(result).toEqual({
      handled: true,
      payload: {
        configured: true,
        profiles: ["purrliquid_observability_smoke", "shared_node_ci"],
        ignoredEntries: 2,
        invalidConfiguration: false,
        valuesIncluded: false,
        environmentKeysIncluded: false,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("NODE_ENV");
    expect(serialized).not.toContain("RUNTIME_VALUE");
    expect(serialized).not.toContain("runtime_api_key");
  });

  test("reports malformed profile configuration without blocking alias discovery", () => {
    process.env.VERIFY_SERVER_ENV_PROFILES = "not-json";
    expect(handleServerEnvAliasMcpTool("purr_list_server_env_profiles")).toEqual({
      handled: true,
      payload: {
        configured: false,
        profiles: [],
        ignoredEntries: 0,
        invalidConfiguration: true,
        valuesIncluded: false,
        environmentKeysIncluded: false,
      },
    });
  });

  test("does not intercept unrelated tools", () => {
    expect(handleServerEnvAliasMcpTool("health_check")).toEqual({ handled: false });
  });
});
