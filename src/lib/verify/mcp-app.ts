// Purr Verify MCP App compatibility layer.
//
// The resource/tool-card pattern is adapted from Waishnav/devspace (MIT):
// https://github.com/Waishnav/devspace
// We reuse its MCP App resource binding and host-context approach while keeping
// Purr Verify's existing JSON-RPC, OAuth, durable jobs, and operator runtime.

import type { NextRequest } from "next/server";

export const VERIFY_MCP_APP_URI = "ui://purr/verify-workbench-v4.html";
export const VERIFY_MCP_APP_LEGACY_URIS = Object.freeze([
  "ui://purr/verify-workbench.html",
  "ui://purr/verify-workbench-v2.html",
  "ui://purr/verify-workbench-v3.html",
]);
export const VERIFY_MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const VERIFY_MCP_APP_READABLE_URIS = new Set([
  VERIFY_MCP_APP_URI,
  ...VERIFY_MCP_APP_LEGACY_URIS,
]);
export const VERIFY_MCP_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["kind", "tool", "status", "isError", "payload"],
  properties: {
    kind: { type: "string", const: "purr-verify-card" },
    tool: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    isError: { type: "boolean" },
    payload: {},
  },
});

export interface VerifyMcpAppCard {
  kind: "purr-verify-card";
  tool: string;
  status: string;
  isError: boolean;
  payload: unknown;
}

export function verifyMcpAppToolMeta(toolName: string): Record<string, unknown> | undefined {
  if (!toolName) return undefined;
  return {
    ui: {
      resourceUri: VERIFY_MCP_APP_URI,
      visibility: ["model"],
    },
    // ChatGPT compatibility alias for the MCP App template.
    "openai/outputTemplate": VERIFY_MCP_APP_URI,
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

export function verifyMcpAppResultMeta(tool: string): Record<string, unknown> {
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

export function readVerifyMcpAppResource(_req: NextRequest, uri: string) {
  if (!VERIFY_MCP_APP_READABLE_URIS.has(uri)) return null;
  return {
    contents: [
      {
        uri,
        mimeType: VERIFY_MCP_APP_MIME_TYPE,
        text: verifyMcpAppHtml(),
        _meta: {
          ui: {
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
      tool.outputSchema = VERIFY_MCP_OUTPUT_SCHEMA;
      const meta = verifyMcpAppToolMeta(name);
      if (meta) {
        tool._meta = {
          ...(tool._meta && typeof tool._meta === "object" && !Array.isArray(tool._meta)
            ? (tool._meta as Record<string, unknown>)
            : {}),
          ...meta,
        };
      }
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
    if (!call.tool) continue;
    singleTool = call.tool;
    toolById.set(String(call.id ?? "null"), call.tool);
  }
  forEachPacket(json, (packet) => {
    const tool = toolById.get(String(packet.id ?? "null")) || singleTool;
    if (!tool) return;
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
    <meta name="mcp-app-template" content="${VERIFY_MCP_APP_URI}" />
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
        contain: layout paint style;
        content-visibility: auto;
        contain-intrinsic-size: 72px;
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
      .actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
      .details-toggle {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 6px 9px;
        background: transparent;
        cursor: pointer;
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .hint { color: var(--muted); font-size: 11px; }
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
    <script>
      const root = document.querySelector("#app");
      let expanded = false;
      let detailsOpen = false;
      let card = normalizeResult(
        window.openai?.toolOutput,
        window.openai?.toolResponseMetadata
      );

      applyHostGlobals(window.openai || {});
      render();

      window.addEventListener("openai:set_globals", (event) => {
        const globals = event.detail?.globals || {};
        applyHostGlobals(globals);
        const output = globals.toolOutput ?? window.openai?.toolOutput;
        const metadata = globals.toolResponseMetadata ?? window.openai?.toolResponseMetadata;
        const next = normalizeResult(output, metadata);
        if (next) card = next;
        render();
      }, { passive: true });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method !== "ui/notifications/tool-result") return;
        const next = normalizeResult(message.params);
        if (next) card = next;
        render();
      }, { passive: true });

      function normalizeResult(result, metadata = {}) {
        if (result === undefined || result === null) return null;
        const full = result && typeof result === "object" ? result : {};
        const structured = full.structuredContent ?? result;
        if (structured?.kind === "purr-verify-card") return structured;
        const meta = full._meta || metadata || {};
        return {
          kind: "purr-verify-card",
          tool: meta.tool || "purr_verify",
          status: full.isError ? "failed" : "ready",
          isError: Boolean(full.isError),
          payload: structured ?? parseTextPayload(full.content)
        };
      }

      function applyHostGlobals(globals) {
        if (globals.theme) document.documentElement.style.colorScheme = globals.theme;
        const variables = globals.styles?.variables;
        if (variables && typeof variables === "object") {
          for (const [name, value] of Object.entries(variables)) {
            if (typeof value === "string") document.documentElement.style.setProperty(name, value);
          }
        }
        const insets = globals.safeAreaInsets;
        if (insets) {
          document.body.style.padding = insets.top + "px " + insets.right + "px " + insets.bottom + "px " + insets.left + "px";
        }
      }

      function render() {
        if (!root) return;
        if (!card) {
          root.replaceChildren(node("section", "empty", "Waiting for a tool result."));
          return;
        }

        const display = displayFor(card.tool, card.payload);
        const section = node("section", "card");
        const header = node("button", "header");
        header.type = "button";
        header.setAttribute("aria-expanded", String(expanded));
        header.addEventListener("click", () => {
          expanded = !expanded;
          if (!expanded) detailsOpen = false;
          render();
        });

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
          const actions = node("div", "actions");
          const details = node("button", "details-toggle", detailsOpen ? "Hide details" : "Show details");
          details.type = "button";
          details.setAttribute("aria-expanded", String(detailsOpen));
          details.addEventListener("click", (event) => {
            event.stopPropagation();
            detailsOpen = !detailsOpen;
            render();
          });
          actions.append(details, node("span", "hint", "Raw payload is rendered on demand."));
          body.append(actions);
          if (detailsOpen) body.append(node("pre", "", pretty(card.payload)));
          section.append(body);
        }
        root.replaceChildren(section);
      }

      function parseTextPayload(content) {
        const text = Array.isArray(content)
          ? content.filter((item) => item?.type === "text").map((item) => item.text || "").join("\\n")
          : "";
        if (!text) return {};
        try { return JSON.parse(text); } catch { return { text }; }
      }

      function displayFor(tool, payload) {
        const labels = {
          read_operating_guide: ["?", "Operating guide"],
          auth_status: ["A", "Authentication status"],
          debug_status: ["D", "Debug status"],
          debug_last_errors: ["!", "Recent errors"],
          health_check: ["H", "Service health"],
          list_allowed_commands: [">_", "Allowed commands"],
          create_share_link: ["↗", "Share verification"],
          list_share_links: ["↗", "Verification shares"],
          revoke_share_links: ["×", "Revoke shares"],
          purr_list_server_env_aliases: ["E", "Environment aliases"],
          purr_list_server_env_profiles: ["E", "Environment profiles"],
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
          purr_inspect_environment: ["E", "Environment inspection"],
          purr_run_command: [">_", "Private command"],
          purr_cancel_job: ["×", "Cancel operator job"],
          cancel_verification_job: ["×", "Cancel verification"],
          get_job_log_chunk: [">_", "Verification logs"],
          search_job_logs: ["?", "Search job logs"],
          compare_verification_jobs: ["Δ", "Compare verifications"],
          get_verification_summary: ["J", "Verification summary"],
          get_latest_verification: ["J", "Latest verification"],
          search_verification_history: ["?", "Search verification history"]
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

      function walk(value, depth, visit, state = { nodes: 0, seen: new WeakSet() }) {
        if (depth > 3 || state.nodes >= 400 || !value || typeof value !== "object") return;
        if (state.seen.has(value)) return;
        state.seen.add(value);
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (state.nodes >= 400) break;
          const child = value[key];
          state.nodes += 1;
          visit(key, child);
          if (child && typeof child === "object") walk(child, depth + 1, visit, state);
        }
      }

      function statusTone(status, isError) {
        if (isError || /fail|error|cancel|reject/i.test(String(status))) return "failed";
        if (/run|queue|pending|progress|deploy/i.test(String(status))) return "running";
        return "ok";
      }

      function pretty(value) {
        if (typeof value === "string") return truncate(value, 65536);
        try { return JSON.stringify(boundedPreview(value), null, 2); } catch { return String(value); }
      }

      function boundedPreview(value, depth = 0, state = { nodes: 0, seen: new WeakSet() }) {
        if (typeof value === "string") return truncate(value, 4000);
        if (value === null || typeof value !== "object") return value;
        if (depth > 5 || state.nodes >= 1200) return "[Preview truncated]";
        if (state.seen.has(value)) return "[Circular]";
        state.seen.add(value);
        if (Array.isArray(value)) {
          const output = [];
          const limit = Math.min(value.length, 50);
          for (let index = 0; index < limit && state.nodes < 1200; index += 1) {
            state.nodes += 1;
            output.push(boundedPreview(value[index], depth + 1, state));
          }
          if (value.length > limit) output.push("[" + (value.length - limit) + " more items]");
          return output;
        }
        const output = {};
        let count = 0;
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (count >= 80 || state.nodes >= 1200) {
            output.__preview = "Additional fields omitted";
            break;
          }
          count += 1;
          state.nodes += 1;
          output[key] = boundedPreview(value[key], depth + 1, state);
        }
        return output;
      }

      function truncate(value, limit) {
        return value.length > limit ? value.slice(0, limit) + "\\n[Preview truncated]" : value;
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
