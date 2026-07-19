import { describe, expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import {
  VERIFY_MCP_APP_MIME_TYPE,
  VERIFY_MCP_APP_URI,
  VERIFY_MCP_OUTPUT_SCHEMA,
  decorateVerifyMcpInitialize,
  decorateVerifyMcpToolResults,
  decorateVerifyMcpToolsList,
  listVerifyMcpAppResources,
  readVerifyMcpAppResource,
} from "./mcp-app";

describe("Purr Verify MCP App compatibility", () => {
  test("advertises the UI resource capability", () => {
    const packet: {
      jsonrpc: string;
      id: number;
      result: { capabilities: Record<string, unknown> };
    } = {
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
    const packet: {
      jsonrpc: string;
      id: number;
      result: { tools: Array<Record<string, unknown>> };
    } = {
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

    expect(packet.result.tools[0].outputSchema).toEqual(VERIFY_MCP_OUTPUT_SCHEMA);
    expect(packet.result.tools[1].outputSchema).toEqual(VERIFY_MCP_OUTPUT_SCHEMA);
    expect(packet.result.tools[0]._meta).toEqual({
      ui: { resourceUri: VERIFY_MCP_APP_URI, visibility: ["model"] },
      "openai/outputTemplate": VERIFY_MCP_APP_URI,
    });
    expect(packet.result.tools[1]._meta).toBeUndefined();
  });

  test("preserves text content and adds a structured card", () => {
    const packet: {
      jsonrpc: string;
      id: string;
      result: Record<string, unknown> & {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
    } = {
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

  test("adds the output contract to non-UI startup tools", () => {
    const packet: {
      jsonrpc: string;
      id: string;
      result: Record<string, unknown> & {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
    } = {
      jsonrpc: "2.0",
      id: "guide",
      result: {
        content: [{ type: "text", text: JSON.stringify({ service: "verify" }) }],
        isError: false,
      },
    };

    decorateVerifyMcpToolResults(packet, [
      { id: "guide", tool: "read_operating_guide" },
    ]);

    expect(packet.result.structuredContent).toEqual({
      kind: "purr-verify-card",
      tool: "read_operating_guide",
      status: "ready",
      isError: false,
      payload: { service: "verify" },
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
    expect(resource?.contents[0].text).toContain("window.openai?.toolOutput");
    expect(resource?.contents[0].text).toContain("openai:set_globals");
    expect(resource?.contents[0].text).toContain("ui/notifications/tool-result");
    expect(resource?.contents[0].text).not.toContain("cdn.jsdelivr.net");
    expect(resource?.contents[0].text).not.toContain("@modelcontextprotocol/ext-apps");
    expect(resource?.contents[0].text).toContain("Purr Verify Workbench");
    expect("csp" in (resource?.contents[0]._meta.ui ?? {})).toBe(false);
    expect(readVerifyMcpAppResource(request, "ui://missing")).toBeNull();
  });
});
