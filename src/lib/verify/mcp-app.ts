// Purr Verify MCP App compatibility layer.
//
// The resource/tool-card pattern is adapted from Waishnav/devspace (MIT):
// https://github.com/Waishnav/devspace
// We reuse its MCP App resource binding and host-context approach while keeping
// Purr Verify's existing JSON-RPC, OAuth, durable jobs, and operator runtime.

import type { NextRequest } from "next/server";

export const VERIFY_MCP_APP_URI = "ui://purr/verify-workbench.html";
export const VERIFY_MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const EXT_APPS_MODULE =
  "https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@1.7.2/+esm";

const UI_TOOLS = new Set([
  "health_check",
  "list_verification_jobs",
  "get_verification_job",
  "create_verification_job",
  "cancel_verification_job",
  "search_verification_history",
  "get_latest_verification",
  "get_verification_summary",
  "compare_verification_jobs",
  "get_job_log_chunk",
  "search_job_logs",
  "purr_discover_projects",
  "purr_inspect_project",
  "purr_inspect_runtime",
  "purr_inspect_environment",
  "purr_plan_deployment",
  "purr_run_command",
  "purr_verify_project",
  "purr_create_deploy_snapshot",
  "purr_deploy_project",
  "purr_restart_service",
  "purr_check_health",
  "purr_rollback_deployment",
  "purr_get_job_status",
  "purr_get_job_logs",
  "purr_cancel_job",
]);

export interface VerifyMcpAppCard {
  kind: "purr-verify-card";
  tool: string;
  status: string;
  isError: boolean;
  payload: unknown;
}

export function verifyMcpAppToolMeta(toolName: string): Record<string, unknown> | undefined {
  if (!UI_TOOLS.has(toolName)) return undefined;
  return {
    ui: {
      resourceUri: VERIFY_MCP_APP_URI,
      visibility: ["model"],
    },
    // Compatibility alias used by older MCP Apps-compatible hosts.
    "ui/resourceUri": VERIFY_MCP_APP_URI,
  };
}

export function verifyMcpAppCard(
  tool: string,
  payload: unknown,
  isError = false,
): VerifyMcpAppCard {
  return {
    kind: "purr-verify-card",
    tool,
    status: inferStatus(payload, isError),
    isError,
    payload,
  };
}

export function verifyMcpAppResultMeta(tool: string): Record<string, unknown> | undefined {
  if (!UI_TOOLS.has(tool)) return undefined;
  return {
    tool,
    card: {
      kind: "purr-verify-card",
      tool,
    },
  };
}

export function listVerifyMcpAppResources() {
  return [
    {
      uri: VERIFY_MCP_APP_URI,
      name: "purr-verify-workbench",
      title: "Purr Verify Workbench",
      description:
        "Interactive cards for verification jobs, VPS projects, deployment plans, health checks, and durable operator runs.",
      mimeType: VERIFY_MCP_APP_MIME_TYPE,
    },
  ];
}

export function readVerifyMcpAppResource(req: NextRequest, uri: string) {
  if (uri !== VERIFY_MCP_APP_URI) return null;
  const origin = publicOrigin(req);
  const csp = {
    resourceDomains: [origin, "https://cdn.jsdelivr.net"],
    connectDomains: [origin, "https://cdn.jsdelivr.net"],
  };
  return {
    contents: [
      {
        uri: VERIFY_MCP_APP_URI,
        mimeType: VERIFY_MCP_APP_MIME_TYPE,
        text: verifyMcpAppHtml(),
        _meta: {
          ui: {
            csp,
            prefersBorder: true,
          },
        },
      },
    ],
  };
}

export function decorateVerifyMcpInitialize(json: unknown): unknown {
  forEachPacket(json, (packet) => {
    const result = packet.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const capabilities =
      result.capabilities && typeof result.capabilities === "object" && !Array.isArray(result.capabilities)
        ? (result.capabilities as Record<string, unknown>)
        : {};
    result.capabilities = {
      ...capabilities,
      resources: {
        listChanged: false,
      },
    };
  });
  return json;
}

export function decorateVerifyMcpToolsList(json: unknown): unknown {
  forEachPacket(json, (packet) => {
    const tools = packet.result?.tools;
    if (!Array.isArray(tools)) return;
    for (const entry of tools) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const tool = entry as Record<string, unknown>;
      const name = typeof tool.name === "string" ? tool.name : "";
      const meta = verifyMcpAppToolMeta(name);
      if (!meta) continue;
      tool._meta = {
        ...(tool._meta && typeof tool._meta === "object" && !Array.isArray(tool._meta)
          ? (tool._meta as Record<string, unknown>)
          : {}),
        ...meta,
      };
    }
  });
  return json;
}

export function decorateVerifyMcpToolResults(
  json: unknown,
  calls: Array<{ id?: string | number | null; tool?: string }>,
): unknown {
  const toolById = new Map<string, string>();
  let singleTool = "";
  for (const call of calls) {
    if (!call.tool || !UI_TOOLS.has(call.tool)) continue;
    singleTool = call.tool;
    toolById.set(String(call.id ?? "null"), call.tool);
  }
  forEachPacket(json, (packet) => {
    const tool = toolById.get(String(packet.id ?? "null")) || singleTool;
    if (!tool || !UI_TOOLS.has(tool)) return;
    const result = packet.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const payload = extractToolPayload(result);
    const isError = result.isError === true;
    result.structuredContent = verifyMcpAppCard(tool, payload, isError);
    result._meta = {
      ...(result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)
        ? (result._meta as Record<string, unknown>)
        : {}),
      ...verifyMcpAppResultMeta(tool),
    };
  });
  return json;
}

interface RpcPacket {
  id?: string | number | null;
  result?: Record<string, unknown>;
}

function forEachPacket(json: unknown, visit: (packet: RpcPacket) => void): void {
  if (Array.isArray(json)) {
    for (const packet of json) {
      if (packet && typeof packet === "object" && !Array.isArray(packet)) visit(packet as RpcPacket);
    }
    return;
  }
  if (json && typeof json === "object") visit(json as RpcPacket);
}

function extractToolPayload(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const texts = content
    .filter((entry): entry is { type: string; text?: unknown } => {
      return Boolean(entry && typeof entry === "object" && !Array.isArray(entry));
    })
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => String(entry.text));
  if (texts.length === 0) return result;
  const text = texts.join("\n");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function publicOrigin(req: NextRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

function inferStatus(payload: unknown, isError: boolean): string {
  if (isError) return "failed";
  const status = findString(payload, ["status", "state", "result"]);
  return status || "ready";
}

function findString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 3 || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  for (const nested of ["job", "data", "project", "execution", "plan"]) {
    const found = findString(record[nested], keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function verifyMcpAppHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Purr Verify Workbench</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --card: color-mix(in srgb, Canvas 94%, CanvasText 6%);
        --border: color-mix(in srgb, CanvasText 16%, transparent);
        --muted: color-mix(in srgb, CanvasText 63%, transparent);
        --soft: color-mix(in srgb, CanvasText 7%, transparent);
        --ok: #22c55e;
        --run: #f59e0b;
        --bad: #ef4444;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; color: CanvasText; }
      body { padding: 8px; }
      button { font: inherit; color: inherit; }
      .shell { width: 100%; }
      .card {
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: var(--card);
        box-shadow: 0 10px 30px color-mix(in srgb, CanvasText 7%, transparent);
      }
      .header {
        width: 100%;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        border: 0;
        background: transparent;
        padding: 13px 14px;
        text-align: left;
        cursor: pointer;
      }
      .header:disabled { cursor: default; }
      .icon {
        width: 30px;
        height: 30px;
        border-radius: 9px;
        display: grid;
        place-items: center;
        background: var(--soft);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 14px;
        font-weight: 700;
      }
      .main { min-width: 0; }
      .title { display: block; font-weight: 650; line-height: 1.25; }
      .label {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status {
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 4px 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        text-transform: lowercase;
      }
      .status.ok { border-color: color-mix(in srgb, var(--ok) 55%, var(--border)); }
      .status.running { border-color: color-mix(in srgb, var(--run) 60%, var(--border)); }
      .status.failed { border-color: color-mix(in srgb, var(--bad) 60%, var(--border)); }
      .body { border-top: 1px solid var(--border); padding: 12px 14px 14px; }
      .metrics { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
      .metric {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 5px 7px;
        background: var(--soft);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
      }
      pre {
        max-height: 360px;
        overflow: auto;
        margin: 0;
        padding: 11px;
        border-radius: 9px;
        background: color-mix(in srgb, CanvasText 6%, transparent);
        font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .empty {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 14px;
        color: var(--muted);
        background: var(--card);
      }
    </style>
  </head>
  <body>
    <main id="app" class="shell"><section class="empty">Connecting to Purr Verify…</section></main>
    <script type="module">
      import {
        App,
        applyDocumentTheme,
        applyHostFonts,
        applyHostStyleVariables
      } from "${EXT_APPS_MODULE}";

      const root = document.querySelector("#app");
      let card = null;
      let expanded = true;
      let connected = false;
      let connectionError = null;

      const app = new App({ name: "purr-verify-workbench", version: "0.1.0" }, {});

      app.ontoolresult = (result) => {
        const structured = result?.structuredContent;
        const meta = result?._meta || {};
        card = structured?.kind === "purr-verify-card"
          ? structured
          : {
              kind: "purr-verify-card",
              tool: meta.tool || "purr_verify",
              status: result?.isError ? "failed" : "ready",
              isError: Boolean(result?.isError),
              payload: structured || parseTextPayload(result?.content)
            };
        render();
      };

      app.onhostcontextchanged = (context) => {
        const current = app.getHostContext() || {};
        const next = { ...current, ...context };
        if (next.theme) applyDocumentTheme(next.theme);
        if (next.styles?.variables) applyHostStyleVariables(next.styles.variables);
        if (next.styles?.css?.fonts) applyHostFonts(next.styles.css.fonts);
        const insets = next.safeAreaInsets;
        if (insets) {
          document.body.style.padding = insets.top + "px " + insets.right + "px " + insets.bottom + "px " + insets.left + "px";
        }
      };

      try {
        await app.connect();
        const context = app.getHostContext();
        if (context?.theme) applyDocumentTheme(context.theme);
        if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
        if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
        connected = true;
      } catch (error) {
        connectionError = error instanceof Error ? error.message : String(error);
      }
      render();

      function render() {
        if (!root) return;
        if (connectionError) {
          root.replaceChildren(node("section", "empty", "UI connection failed: " + connectionError));
          return;
        }
        if (!connected || !card) {
          root.replaceChildren(node("section", "empty", connected ? "Waiting for a tool result." : "Connecting to Purr Verify…"));
          return;
        }

        const display = displayFor(card.tool, card.payload);
        const section = node("section", "card");
        const header = node("button", "header");
        header.type = "button";
        header.setAttribute("aria-expanded", String(expanded));
        header.addEventListener("click", () => { expanded = !expanded; render(); });

        const icon = node("span", "icon", display.icon);
        const main = node("span", "main");
        main.append(node("span", "title", display.title));
        if (display.label) main.append(node("span", "label", display.label));
        const status = node("span", "status " + statusTone(card.status, card.isError), card.status || "ready");
        header.append(icon, main, status);
        section.append(header);

        if (expanded) {
          const body = node("div", "body");
          const metrics = metricValues(card.payload);
          if (metrics.length) {
            const row = node("div", "metrics");
            for (const item of metrics) row.append(node("span", "metric", item));
            body.append(row);
          }
          body.append(node("pre", "", pretty(card.payload)));
          section.append(body);
        }
        root.replaceChildren(section);
      }

      function parseTextPayload(content) {
        const text = Array.isArray(content)
          ? content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\n")
          : "";
        if (!text) return {};
        try { return JSON.parse(text); } catch { return { text }; }
      }

      function displayFor(tool, payload) {
        const labels = {
          health_check: ["H", "Service health"],
          list_verification_jobs: ["J", "Verification history"],
          get_verification_job: ["J", "Verification job"],
          create_verification_job: ["▶", "Verification queued"],
          purr_get_job_status: ["J", "Operator job"],
          purr_get_job_logs: [">_", "Job logs"],
          purr_verify_project: ["✓", "Project verification"],
          purr_plan_deployment: ["P", "Deployment plan"],
          purr_deploy_project: ["↑", "Deployment"],
          purr_create_deploy_snapshot: ["S", "Deploy snapshot"],
          purr_restart_service: ["R", "Service restart"],
          purr_check_health: ["H", "Runtime health"],
          purr_rollback_deployment: ["↶", "Rollback"],
          purr_discover_projects: ["D", "Discovered projects"],
          purr_inspect_project: ["I", "Project inspection"],
          purr_inspect_runtime: ["I", "Runtime inspection"],
          purr_run_command: [">_", "Private command"]
        };
        const item = labels[tool] || ["P", String(tool || "Purr Verify").replaceAll("_", " ")];
        return { icon: item[0], title: item[1], label: findLabel(payload) };
      }

      function findLabel(payload) {
        const values = deepValues(payload, ["cwd", "repo", "jobId", "name", "service", "canonicalPath"]);
        return values[0];
      }

      function metricValues(payload) {
        const keys = ["jobId", "status", "branch", "currentHead", "activeJobs", "queuedJobs", "totalJobs", "strategy", "serviceName"];
        const output = [];
        const seen = new Set();
        walk(payload, 0, (key, value) => {
          if (!keys.includes(key) || seen.has(key)) return;
          if (["string", "number", "boolean"].includes(typeof value)) {
            seen.add(key);
            output.push(key + ": " + String(value));
          }
        });
        return output.slice(0, 8);
      }

      function deepValues(payload, keys) {
        const output = [];
        walk(payload, 0, (key, value) => {
          if (keys.includes(key) && typeof value === "string" && value && !output.includes(value)) output.push(value);
        });
        return output;
      }

      function walk(value, depth, visit) {
        if (depth > 4 || !value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          visit(key, child);
          if (child && typeof child === "object") walk(child, depth + 1, visit);
        }
      }

      function statusTone(status, isError) {
        if (isError || /fail|error|cancel|reject/i.test(String(status))) return "failed";
        if (/run|queue|pending|progress|deploy/i.test(String(status))) return "running";
        return "ok";
      }

      function pretty(value) {
        if (typeof value === "string") return value;
        try { return JSON.stringify(value, null, 2); } catch { return String(value); }
      }

      function node(tag, className = "", text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
      }
    </script>
  </body>
</html>`;
}
