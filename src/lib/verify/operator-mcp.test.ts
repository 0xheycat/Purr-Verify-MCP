import { describe, expect, test } from "bun:test";
import { OPERATOR_MCP_TOOLS, handleOperatorMcpTool } from "./operator-mcp";

describe("private developer operator MCP surface", () => {
  test("exposes the five phase-one tools as additive read-only capabilities", () => {
    expect(OPERATOR_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "purr_discover_projects",
      "purr_inspect_project",
      "purr_inspect_runtime",
      "purr_inspect_environment",
      "purr_plan_deployment",
    ]);
    expect(
      OPERATOR_MCP_TOOLS.every(
        (tool) =>
          tool.annotations.readOnlyHint === true &&
          tool.annotations.destructiveHint === false &&
          tool.annotations.idempotentHint === true
      )
    ).toBe(true);
  });

  test("rejects a raw invalid deployment strategy before inspecting the filesystem", async () => {
    const result = await handleOperatorMcpTool("purr_plan_deployment", {
      cwd: "/",
      strategy: "delete_everything",
    });

    expect(result).toEqual({
      handled: true,
      isError: true,
      payload: {
        error: "validation_failed",
        message: "invalid strategy: delete_everything",
      },
    });
  });

  test("does not intercept unrelated MCP tools", async () => {
    expect(await handleOperatorMcpTool("health_check", {})).toEqual({ handled: false });
  });
});
