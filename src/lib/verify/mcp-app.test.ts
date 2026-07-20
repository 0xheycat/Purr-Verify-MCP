import { describe, expect, test } from "bun:test";
import { Script } from "node:vm";
import ts from "typescript";
import type { NextRequest } from "next/server";
import { VERIFY_DEBUG_TOOLS } from "./debug";
import { VERIFY_MCP_TOOLS } from "./mcp";
import { READ_OPERATING_GUIDE_TOOL } from "./operating-guide";
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

  test("attaches the shared workbench to every visible tool", () => {
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
    expect(packet.result.tools[1]._meta).toEqual({
      ui: { resourceUri: VERIFY_MCP_APP_URI, visibility: ["model"] },
      "openai/outputTemplate": VERIFY_MCP_APP_URI,
    });
  });

  test("covers the complete live catalog with one readable template", () => {
    const tools = [
      READ_OPERATING_GUIDE_TOOL,
      ...VERIFY_DEBUG_TOOLS,
      ...VERIFY_MCP_TOOLS,
    ].map((tool) => ({ ...tool }));
    const packet: {
      jsonrpc: string;
      id: number;
      result: { tools: Array<Record<string, unknown>> };
    } = {
      jsonrpc: "2.0",
      id: 3,
      result: { tools },
    };

    decorateVerifyMcpToolsList(packet);

    expect(new Set(packet.result.tools.map((tool) => tool.name)).size).toBe(46);
    const templateUris = new Set<string>();
    for (const tool of packet.result.tools) {
      expect(tool.outputSchema).toEqual(VERIFY_MCP_OUTPUT_SCHEMA);
      const meta = tool._meta as Record<string, unknown>;
      expect(meta["openai/outputTemplate"]).toBe(VERIFY_MCP_APP_URI);
      expect(meta.ui).toEqual({ resourceUri: VERIFY_MCP_APP_URI, visibility: ["model"] });
      templateUris.add(String(meta["openai/outputTemplate"]));
    }

    const request = { url: "https://verify.example/mcp" } as NextRequest;
    expect([...templateUris]).toEqual([VERIFY_MCP_APP_URI]);
    for (const uri of templateUris) {
      expect(readVerifyMcpAppResource(request, uri)?.contents[0].mimeType).toBe(
        VERIFY_MCP_APP_MIME_TYPE,
      );
    }
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
    expect(resource?.contents[0].text).toContain("verify-workbench-v7");
    expect(resource?.contents[0].text).toContain("let expanded = false");
    expect(resource?.contents[0].text).toContain("browserPresentation");
    expect(resource?.contents[0].text).toContain("Pursr and a Chrome-compatible browser are ready.");
    expect(resource?.contents[0].text).toContain("raw.addEventListener(\"toggle\"");
    expect(resource?.contents[0].text).toContain("content-visibility: auto");
    expect(resource?.contents[0].text).not.toContain("Raw payload is rendered on demand.");
    const widgetScript =
      resource?.contents[0].text.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(widgetScript).not.toBe("");
    expect(() => new Script(widgetScript)).not.toThrow();
    const browserDiagnostics =
      ts.transpileModule(widgetScript, {
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).diagnostics ?? [];
    expect(
      browserDiagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      })),
    ).toEqual([]);
    expect(resource?.contents[0]._meta.ui.prefersBorder).toBe(false);
    expect("csp" in (resource?.contents[0]._meta.ui ?? {})).toBe(false);
    expect(readVerifyMcpAppResource(request, "ui://purr/verify-workbench-v6.html")).toBeNull();
    expect(readVerifyMcpAppResource(request, "ui://purr/verify-workbench-v5.html")).toBeNull();
    expect(readVerifyMcpAppResource(request, "ui://purr/verify-workbench-v4.html")).toBeNull();
    expect(readVerifyMcpAppResource(request, "ui://purr/verify-workbench-v3.html")).toBeNull();
    expect(readVerifyMcpAppResource(request, "ui://missing")).toBeNull();
  });
});
