// Purr Verify MCP App compatibility layer.
//
// The resource/tool-card pattern is adapted from Waishnav/devspace (MIT):
// https://github.com/Waishnav/devspace
// We reuse its MCP App resource binding and host-context approach while keeping
// Purr Verify's existing JSON-RPC, OAuth, durable jobs, and operator runtime.

import type { NextRequest } from "next/server";

export const VERIFY_MCP_APP_URI = "ui://purr/verify-workbench-v7.html";
export const VERIFY_MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
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
        "Purr Compact v7 views for verification, VPS operations, browser work sessions, deployment, health, and durable jobs.",
      mimeType: VERIFY_MCP_APP_MIME_TYPE,
    },
  ];
}

export function readVerifyMcpAppResource(_req: NextRequest, uri: string) {
  if (uri !== VERIFY_MCP_APP_URI) return null;
  return {
    contents: [
      {
        uri: VERIFY_MCP_APP_URI,
        mimeType: VERIFY_MCP_APP_MIME_TYPE,
        text: verifyMcpAppHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
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
        --surface: color-mix(in srgb, Canvas 97%, CanvasText 3%);
        --border: color-mix(in srgb, CanvasText 15%, transparent);
        --line: color-mix(in srgb, CanvasText 9%, transparent);
        --muted: color-mix(in srgb, CanvasText 58%, transparent);
        --subtle: color-mix(in srgb, CanvasText 5%, transparent);
        --ok: #22c55e;
        --run: #f59e0b;
        --bad: #ef4444;
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; color: CanvasText; }
      body { padding: 4px; }
      button, summary { font: inherit; color: inherit; }
      .shell { width: 100%; }
      .card {
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 11px;
        background: var(--surface);
        contain: layout paint style;
        content-visibility: auto;
        contain-intrinsic-size: 58px;
      }
      .header {
        width: 100%;
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr) auto 14px;
        gap: 9px;
        align-items: center;
        border: 0;
        background: transparent;
        padding: 10px 12px;
        text-align: left;
        cursor: pointer;
      }
      .mark {
        color: var(--muted);
        font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-align: center;
      }
      .main { min-width: 0; }
      .title { display: block; font-size: 13px; font-weight: 650; line-height: 1.3; }
      .label {
        display: block;
        margin-top: 2px;
        overflow: hidden;
        color: var(--muted);
        font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .state {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--muted);
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
      }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
      .state.running .dot { background: var(--run); }
      .state.failed .dot { background: var(--bad); }
      .chevron { color: var(--muted); font-size: 11px; transition: transform 120ms ease; }
      .header[aria-expanded="true"] .chevron { transform: rotate(180deg); }
      .body { border-top: 1px solid var(--line); padding: 11px 12px 12px; }
      .summary { margin: 0 0 9px; font-size: 13px; line-height: 1.45; }
      .rows { margin: 0; }
      .row {
        display: grid;
        grid-template-columns: minmax(88px, 118px) minmax(0, 1fr);
        gap: 12px;
        padding: 6px 0;
        border-bottom: 1px solid var(--line);
      }
      .row:last-child { border-bottom: 0; }
      dt { color: var(--muted); font-size: 11px; }
      dd {
        min-width: 0;
        margin: 0;
        overflow-wrap: anywhere;
        font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .items { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
      .item {
        padding: 7px 8px;
        border-radius: 7px;
        background: var(--subtle);
        font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow-wrap: anywhere;
      }
      .console {
        max-height: 300px;
        overflow: auto;
        margin: 8px 0 0;
        padding: 9px 10px;
        border-radius: 7px;
        background: color-mix(in srgb, CanvasText 7%, transparent);
        font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .raw { margin-top: 9px; border-top: 1px solid var(--line); padding-top: 8px; }
      .raw > summary {
        width: fit-content;
        color: var(--muted);
        cursor: pointer;
        font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      .empty {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        color: var(--muted);
        background: var(--surface);
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <main id="app" class="shell"><section class="empty">Connecting to Purr Verify…</section></main>
    <script>
      const root = document.querySelector("#app");
      let expanded = false;
      let card = normalizeResult(window.openai?.toolOutput, window.openai?.toolResponseMetadata);

      applyHostGlobals(window.openai || {});
      render();

      window.addEventListener("openai:set_globals", (event) => {
        const globals = event.detail?.globals || {};
        applyHostGlobals(globals);
        const output = globals.toolOutput ?? window.openai?.toolOutput;
        const metadata = globals.toolResponseMetadata ?? window.openai?.toolResponseMetadata;
        const next = normalizeResult(output, metadata);
        if (next) {
          const changed = !card || next.tool !== card.tool;
          card = next;
          if (changed) expanded = false;
        }
        render();
      }, { passive: true });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method !== "ui/notifications/tool-result") return;
        const next = normalizeResult(message.params);
        if (next) {
          const changed = !card || next.tool !== card.tool;
          card = next;
          if (changed) expanded = false;
        }
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
        header.addEventListener("click", () => { expanded = !expanded; render(); });

        header.append(node("span", "mark", display.icon));
        const main = node("span", "main");
        main.append(node("span", "title", display.title));
        if (display.label) main.append(node("span", "label", display.label));
        header.append(main);

        const tone = statusTone(card.status, card.isError);
        const state = node("span", "state " + tone);
        state.append(node("span", "dot"), node("span", "", normalizedStatus(card.status, card.isError)));
        header.append(state, node("span", "chevron", "⌄"));
        section.append(header);

        if (expanded) section.append(renderBody(card.tool, card.payload));
        root.replaceChildren(section);
      }

      function renderBody(tool, payload) {
        const body = node("div", "body");
        const view = presentationFor(tool, payload);
        if (view.summary) body.append(node("p", "summary", view.summary));
        if (view.rows?.length) {
          const rows = node("dl", "rows");
          for (const item of view.rows) {
            const row = node("div", "row");
            row.append(node("dt", "", item[0]), node("dd", "", item[1]));
            rows.append(row);
          }
          body.append(rows);
        }
        if (view.items?.length) {
          const list = node("ul", "items");
          for (const item of view.items) list.append(node("li", "item", item));
          body.append(list);
        }
        if (view.console) body.append(node("pre", "console", view.console));

        const raw = node("details", "raw");
        raw.append(node("summary", "", "Raw"));
        raw.addEventListener("toggle", () => {
          if (raw.open && raw.children.length === 1) raw.append(node("pre", "console", pretty(payload)));
        });
        body.append(raw);
        return body;
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
          auth_status: ["A", "Authentication"],
          debug_status: ["D", "Debug status"],
          debug_last_errors: ["!", "Recent errors"],
          health_check: ["H", "Service health"],
          list_allowed_commands: [">", "Allowed commands"],
          create_share_link: ["↗", "Share verification"],
          list_share_links: ["↗", "Verification shares"],
          revoke_share_links: ["×", "Revoke shares"],
          purr_list_server_env_aliases: ["E", "Environment aliases"],
          purr_list_server_env_profiles: ["E", "Environment profiles"],
          list_verification_jobs: ["J", "Verification history"],
          get_verification_job: ["J", "Verification job"],
          create_verification_job: ["▶", "Verification queued"],
          purr_get_job_status: ["J", "Operator job"],
          purr_get_job_logs: [">", "Job logs"],
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
          purr_run_command: [">", "Command"],
          purr_browser_doctor: ["B", "Browser runtime"],
          purr_work_session_start: ["B", "Browser session started"],
          purr_work_sessions: ["B", "Browser sessions"],
          purr_work_session_status: ["B", "Browser session"],
          purr_work_session_snapshot: ["S", "Page snapshot"],
          purr_work_session_act: ["A", "Browser action"],
          purr_work_session_screenshot: ["▣", "Screenshot"],
          purr_work_session_inspect: ["I", "Element inspection"],
          purr_work_session_diagnostics: ["!", "Browser diagnostics"],
          purr_work_session_close: ["×", "Browser session closed"],
          purr_cancel_job: ["×", "Cancel operator job"],
          cancel_verification_job: ["×", "Cancel verification"],
          get_job_log_chunk: [">", "Verification logs"],
          search_job_logs: ["?", "Search job logs"],
          compare_verification_jobs: ["Δ", "Compare verifications"],
          get_verification_summary: ["J", "Verification summary"],
          get_latest_verification: ["J", "Latest verification"],
          search_verification_history: ["?", "Search verification history"]
        };
        const item = labels[tool] || ["P", sentence(String(tool || "Purr Verify").replaceAll("_", " "))];
        return { icon: item[0], title: item[1], label: findLabel(tool, payload) };
      }

      function findLabel(tool, payload) {
        if (tool.startsWith("purr_work_session")) {
          return firstValue(payload, ["sessionId", "url", "cwd"]);
        }
        return firstValue(payload, ["cwd", "repo", "jobId", "name", "service", "canonicalPath"]);
      }

      function presentationFor(tool, payload) {
        if (tool === "purr_browser_doctor" || tool.startsWith("purr_work_session")) {
          return browserPresentation(tool, payload);
        }
        const message = firstValue(payload, ["message", "error", "warning"]);
        const rows = rowsFor(payload, [
          ["Job", ["jobId"]],
          ["Status", ["status", "state"]],
          ["Repository", ["repo"]],
          ["Branch", ["branch", "ref"]],
          ["Head", ["currentHead", "head"]],
          ["Project", ["canonicalPath", "cwd"]],
          ["Service", ["serviceName", "service"]],
          ["Strategy", ["strategy"]]
        ]);
        const consoleText = /logs|run_command/i.test(tool) ? firstValue(payload, ["stdout", "stderr", "text", "logs"]) : undefined;
        return {
          summary: message ? truncate(String(message), 700) : conciseSummary(payload),
          rows,
          console: consoleText ? truncate(String(consoleText), 24000) : undefined
        };
      }

      function browserPresentation(tool, payload) {
        if (tool === "purr_browser_doctor") {
          const status = firstValue(payload, ["status"]) || "unknown";
          const sessions = arrayAt(payload, ["activeSessions"]);
          return {
            summary: status === "ready" ? "Pursr and a Chrome-compatible browser are ready." : "Browser runtime needs attention.",
            rows: compactRows([
              ["Pursr", firstValue(payload, ["pursrVersion"])],
              ["Playwright", firstValue(payload, ["playwrightCore"]) ? "resolved" : "missing"],
              ["Browser", firstValue(payload, ["preferred", "executablePath", "path"]) || "not found"],
              ["Sessions", String(sessions.length)],
              ["Output", firstValue(payload, ["outputDir"])]
            ]),
            items: stringArrayAt(payload, ["setupHints"])
          };
        }

        if (tool === "purr_work_sessions") {
          const sessions = arrayAt(payload, ["sessions"]);
          return {
            summary: sessions.length === 1 ? "1 managed browser work session." : String(sessions.length) + " managed browser work sessions.",
            items: sessions.slice(0, 12).map((session) => sessionLine(session))
          };
        }

        const session = objectAt(payload, ["session"]) || payload;
        if (tool === "purr_work_session_start" || tool === "purr_work_session_status") {
          const attached = firstValue(session, ["browserAttached"]);
          const warning = firstValue(session, ["warning", "error"]);
          return {
            summary: warning ? truncate(String(warning), 700) : attached === true ? "Dev server is ready and Pursr is attached." : "Managed dev server session is ready.",
            rows: sessionRows(session)
          };
        }

        if (tool === "purr_work_session_snapshot") {
          const nodes = firstArray(payload, ["nodes", "elements", "items"]);
          return {
            summary: nodes.length ? "Rendered page state captured with " + String(nodes.length) + " nodes." : "Rendered page state captured.",
            rows: compactRows([
              ["URL", firstValue(payload, ["url"])],
              ["Selector", firstValue(payload, ["selector"])],
              ["Nodes", nodes.length ? String(nodes.length) : undefined]
            ]),
            items: nodes.slice(0, 8).map((entry) => snapshotLine(entry))
          };
        }

        if (tool === "purr_work_session_act") {
          const actions = firstArray(payload, ["actions", "results", "steps"]);
          return {
            summary: actions.length ? String(actions.length) + " browser actions completed." : "Browser action completed.",
            rows: compactRows([
              ["Session", firstValue(payload, ["sessionId"])],
              ["URL", firstValue(payload, ["url"])],
              ["Status", firstValue(payload, ["status", "state"])]
            ]),
            items: actions.slice(0, 10).map((entry) => actionLine(entry))
          };
        }

        if (tool === "purr_work_session_screenshot") {
          return {
            summary: "PNG screenshot captured from the persistent browser session.",
            rows: compactRows([
              ["Session", firstValue(payload, ["sessionId", "browserSessionId"])],
              ["URL", firstValue(payload, ["url"])],
              ["Artifact", firstValue(payload, ["out", "path"])]
            ])
          };
        }

        if (tool === "purr_work_session_inspect") {
          const rect = objectAt(payload, ["rect", "bounds", "geometry"]);
          const width = rect ? firstValue(rect, ["width"]) : undefined;
          const height = rect ? firstValue(rect, ["height"]) : undefined;
          return {
            summary: firstValue(payload, ["text", "innerText", "message"]) || "Rendered element inspected.",
            rows: compactRows([
              ["Selector", firstValue(payload, ["selector"])],
              ["Element", firstValue(payload, ["tagName", "tag", "role"])],
              ["Size", width !== undefined && height !== undefined ? String(width) + " × " + String(height) : undefined],
              ["Visibility", firstValue(payload, ["visible", "visibility"])]
            ])
          };
        }

        if (tool === "purr_work_session_diagnostics") {
          const consoleMessages = firstArray(payload, ["console", "consoleMessages"]);
          const pageErrors = firstArray(payload, ["pageErrors", "errors"]);
          const failedRequests = firstArray(payload, ["failedRequests", "requestFailures"]);
          const httpFailures = firstArray(payload, ["httpFailures", "responses"]);
          const stdout = firstValue(payload, ["stdout"]);
          const stderr = firstValue(payload, ["stderr"]);
          const consoleText = [stdout, stderr].filter((value) => typeof value === "string" && value).join("\\n");
          return {
            summary: pageErrors.length || failedRequests.length || httpFailures.length ? "Browser diagnostics found runtime failures." : "No browser runtime failures were reported.",
            rows: compactRows([
              ["Console", String(consoleMessages.length)],
              ["Page errors", String(pageErrors.length)],
              ["Failed requests", String(failedRequests.length)],
              ["HTTP failures", String(httpFailures.length)]
            ]),
            console: consoleText ? truncate(consoleText, 24000) : undefined
          };
        }

        if (tool === "purr_work_session_close") {
          return {
            summary: firstValue(payload, ["closed"]) === false ? "Browser session was already stopped." : "Browser and dev-server process tree closed.",
            rows: sessionRows(payload)
          };
        }

        return { summary: "Browser work session updated.", rows: sessionRows(session) };
      }

      function sessionRows(value) {
        return compactRows([
          ["Session", firstValue(value, ["sessionId"])],
          ["Status", firstValue(value, ["status", "state"])],
          ["URL", firstValue(value, ["url"])],
          ["Browser", firstValue(value, ["browserAttached"]) === true ? "attached" : firstValue(value, ["browserMode"])],
          ["PID", firstValue(value, ["pid"])],
          ["Project", firstValue(value, ["cwd"])],
          ["Artifacts", firstValue(value, ["outputDir"])]
        ]);
      }

      function rowsFor(payload, definitions) {
        return compactRows(definitions.map((definition) => [definition[0], firstValue(payload, definition[1])]));
      }

      function compactRows(rows) {
        return rows
          .filter((row) => row[1] !== undefined && row[1] !== null && String(row[1]) !== "")
          .map((row) => [String(row[0]), truncate(String(row[1]), 1000)]);
      }

      function conciseSummary(payload) {
        if (Array.isArray(payload)) return String(payload.length) + " results.";
        if (!payload || typeof payload !== "object") return truncate(String(payload ?? "Completed."), 700);
        const status = firstValue(payload, ["status", "state"]);
        return status ? "Result status: " + String(status) + "." : "Operation completed.";
      }

      function sessionLine(value) {
        if (!value || typeof value !== "object") return truncate(String(value), 500);
        const id = firstValue(value, ["sessionId", "id"]) || "session";
        const status = firstValue(value, ["status", "state"]) || "unknown";
        const url = firstValue(value, ["url"]);
        return String(id) + "  ·  " + String(status) + (url ? "  ·  " + String(url) : "");
      }

      function snapshotLine(value) {
        if (!value || typeof value !== "object") return truncate(String(value), 500);
        const selector = firstValue(value, ["selector", "path", "tagName", "tag"]) || "node";
        const text = firstValue(value, ["text", "innerText", "name", "role"]);
        return String(selector) + (text ? "  ·  " + truncate(String(text), 220) : "");
      }

      function actionLine(value) {
        if (!value || typeof value !== "object") return truncate(String(value), 500);
        const action = firstValue(value, ["action", "type", "name"]) || "action";
        const target = firstValue(value, ["selector", "target", "url"]);
        const status = firstValue(value, ["status", "state", "result"]);
        return String(action) + (target ? "  ·  " + String(target) : "") + (status ? "  ·  " + String(status) : "");
      }

      function firstValue(value, keys) {
        let found;
        walk(value, 0, (key, child) => {
          if (found !== undefined || !keys.includes(key)) return;
          if (["string", "number", "boolean"].includes(typeof child) && String(child) !== "") found = child;
        });
        return found;
      }

      function firstArray(value, keys) {
        let found;
        walk(value, 0, (key, child) => {
          if (!found && keys.includes(key) && Array.isArray(child)) found = child;
        });
        return found || [];
      }

      function arrayAt(value, keys) {
        if (!value || typeof value !== "object") return [];
        for (const key of keys) if (Array.isArray(value[key])) return value[key];
        return [];
      }

      function stringArrayAt(value, keys) {
        return arrayAt(value, keys).filter((entry) => typeof entry === "string").slice(0, 12);
      }

      function objectAt(value, keys) {
        if (!value || typeof value !== "object") return null;
        for (const key of keys) {
          const child = value[key];
          if (child && typeof child === "object" && !Array.isArray(child)) return child;
        }
        return null;
      }

      function walk(value, depth, visit, state = { nodes: 0, seen: new WeakSet() }) {
        if (depth > 4 || state.nodes >= 500 || !value || typeof value !== "object") return;
        if (state.seen.has(value)) return;
        state.seen.add(value);
        for (const key in value) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          if (state.nodes >= 500) break;
          const child = value[key];
          state.nodes += 1;
          visit(key, child);
          if (child && typeof child === "object") walk(child, depth + 1, visit, state);
        }
      }

      function normalizedStatus(status, isError) {
        if (isError) return "failed";
        const value = String(status || "ready").toLowerCase();
        if (/success|complete|completed|ok|healthy|verified/.test(value)) return "ready";
        if (/manual/.test(value)) return "manual required";
        if (/approval/.test(value)) return "approval required";
        return truncate(value, 22);
      }

      function statusTone(status, isError) {
        if (isError || /fail|error|cancel|reject|unavailable/i.test(String(status))) return "failed";
        if (/run|queue|pending|progress|deploy|start|stop/i.test(String(status))) return "running";
        return "ok";
      }

      function sentence(value) {
        const text = String(value || "").trim();
        return text ? text[0].toUpperCase() + text.slice(1) : "Purr Verify";
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
        const text = String(value ?? "");
        return text.length > limit ? text.slice(0, limit) + "\\n[truncated]" : text;
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
