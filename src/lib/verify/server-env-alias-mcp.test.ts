import { afterEach, describe, expect, test } from "bun:test";
import {
  SERVER_ENV_ALIAS_MCP_TOOLS,
  handleServerEnvAliasMcpTool,
} from "./server-env-alias-mcp";

const originalAllowlist = process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;

afterEach(() => {
  if (originalAllowlist === undefined) delete process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST;
  else process.env.VERIFY_SERVER_ENV_REF_ALLOWLIST = originalAllowlist;
});

describe("server environment alias discovery MCP surface", () => {
  test("exposes one read-only non-destructive idempotent tool", () => {
    expect(SERVER_ENV_ALIAS_MCP_TOOLS).toHaveLength(1);
    expect(SERVER_ENV_ALIAS_MCP_TOOLS[0]).toMatchObject({
      name: "purr_list_server_env_aliases",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    });
  });

  test("returns public aliases without accepting cwd or creating a job", () => {
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

  test("does not intercept unrelated tools", () => {
    expect(handleServerEnvAliasMcpTool("health_check")).toEqual({ handled: false });
  });
});
