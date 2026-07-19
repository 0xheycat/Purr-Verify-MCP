import { describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import {
  VERIFY_MCP_APP_MIME_TYPE,
  VERIFY_MCP_APP_URI,
  decorateVerifyMcpInitialize,
  decorateVerifyMcpToolResults,
  decorateVerifyMcpToolsList,
  listVerifyMcpAppResources,
  readVerifyMcpAppResource,
} from "./mcp-app";

describe("Purr Verify MCP App compatibility", () => {
  test("advertises the UI resource capability", () => {
    const packet = {
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { tools: {} } },
    };

    decorateVerifyMcpInitialize(packet);

    expect(packet.result.capabilities).toEqual({
      tools: {},
      resources: { listChanged: false },
    });
  });

  test("attaches the shared workbench only to supported tools", () => {
    const packet = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "health_check", inputSchema: { type: "object" } },
          { name: "read_operating_guide", inputSchema: { type: "object" } },
        ],
      },
    };

    decorateVerifyMcpToolsList(packet);

    expect(packet.result.tools[0]._meta).toEqual({
      ui: { resourceUri: VERIFY_MCP_APP_URI, visibility: ["model"] },
      "ui/resourceUri": VERIFY_MCP_APP_URI,
    });
    expect(packet.result.tools[1]._meta).toBeUndefined();
  });

  test("preserves text content and adds a structured card", () => {
    const packet = {
      jsonrpc: "2.0",
      id: "job-status",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ jobId: "job-1", status: "running" }),
          },
        ],
        isError: false,
      },
    };

    decorateVerifyMcpToolResults(packet, [
      { id: "job-status", tool: "purr_get_job_status" },
    ]);

    expect(packet.result.content).toHaveLength(1);
    expect(packet.result.structuredContent).toEqual({
      kind: "purr-verify-card",
      tool: "purr_get_job_status",
      status: "running",
      isError: false,
      payload: { jobId: "job-1", status: "running" },
    });
    expect(packet.result._meta).toEqual({
      tool: "purr_get_job_status",
      card: { kind: "purr-verify-card", tool: "purr_get_job_status" },
    });
  });

  test("returns a ChatGPT-compatible MCP App resource", () => {
    const resources = listVerifyMcpAppResources();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe(VERIFY_MCP_APP_URI);
    expect(resources[0].mimeType).toBe(VERIFY_MCP_APP_MIME_TYPE);

    const request = { url: "https://verify.example/mcp" } as NextRequest;
    const resource = readVerifyMcpAppResource(request, VERIFY_MCP_APP_URI);
    expect(resource?.contents[0].mimeType).toBe(VERIFY_MCP_APP_MIME_TYPE);
    expect(resource?.contents[0].text).toContain("@modelcontextprotocol/ext-apps@1.7.2");
    expect(resource?.contents[0].text).toContain("Purr Verify Workbench");
    expect(readVerifyMcpAppResource(request, "ui://missing")).toBeNull();
  });
});
