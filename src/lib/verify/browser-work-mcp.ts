import {
  browserDoctor,
  getBrowserWorkSessionManager,
  type BrowserWorkMode,
  type BrowserWorkStartInput,
} from "./browser-work";
import { classifyDestructiveCommand } from "./operator-runtime";

export interface BrowserWorkMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

export interface BrowserWorkMcpToolResult {
  handled: boolean;
  payload?: unknown;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;
const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
} as const;
const SIDE_EFFECTING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

const SESSION_ID = {
  type: "string",
  description: "Work-session identifier returned by purr_work_session_start.",
};

export const BROWSER_WORK_MCP_TOOLS: BrowserWorkMcpToolDefinition[] = [
  {
    name: "purr_browser_doctor",
    description:
      "Inspect the installed Pursr package, playwright-core resolution, Chrome-compatible browser discovery, output directory, and active browser work sessions. Returns setup hints instead of mutating the server.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_start",
    description:
      "Start a managed local dev server, wait for its HTTP URL, and attach a persistent Pursr browser session for inspect-act-screenshot-diagnostics work. Browser setup failures degrade to a dev-server-only session unless browserRequired=true.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Absolute local project directory. The server canonicalizes symlinks.",
        },
        sessionId: { type: "string", description: "Optional stable session name." },
        argv: {
          type: "array",
          items: { type: "string" },
          description: "Preferred dev-server command, for example [\"npm\",\"run\",\"dev\"].",
        },
        command: { type: "string", description: "Shell command used only when shell=true." },
        shell: { type: "boolean", default: false },
        environmentOverrides: { type: "object", additionalProperties: { type: "string" } },
        url: {
          type: "string",
          description: "Expected local HTTP URL. When omitted, host and port are used and local URLs printed by the dev server are auto-detected.",
        },
        host: { type: "string", default: "127.0.0.1" },
        port: { type: "number", default: 3000 },
        readyPath: { type: "string", default: "/" },
        startupTimeoutMs: { type: "number", default: 120000 },
        browserMode: {
          type: "string",
          enum: ["headless", "visible", "cdp", "none"],
          default: "headless",
        },
        browserRequired: {
          type: "boolean",
          default: false,
          description: "Fail and stop the dev server when browser attachment is unavailable. Default false preserves a usable dev-server session with a warning.",
        },
        cdpUrl: { type: "string", description: "Local Chrome DevTools endpoint for browserMode=cdp." },
        storageState: { description: "Playwright storageState object or local file path." },
        preset: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        dpr: { type: "number" },
        visual: { type: "boolean" },
        slowMo: { type: "number" },
        recordVideo: { type: "boolean", default: false },
        confirmDestructive: {
          type: "boolean",
          default: false,
          description: "Required only when the supplied dev command is classified as destructive.",
        },
      },
      required: ["cwd"],
    },
    annotations: MUTATING,
  },
  {
    name: "purr_work_sessions",
    description: "List managed dev-server and Pursr browser work sessions in the current Verify MCP process.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_status",
    description: "Read one work session's dev-server, URL, browser attachment, artifact directory, warning, and exit state.",
    inputSchema: {
      type: "object",
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_snapshot",
    description:
      "Read concise rendered nodes, semantics, geometry, and computed styles from the persistent Pursr browser attached to a work session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        selector: { type: "string", default: "body" },
        maxNodes: { type: "number", default: 250 },
        includeStyles: { type: "boolean", default: true },
      },
      required: ["sessionId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_act",
    description:
      "Perform a small ordered Pursr action sequence in the persistent browser. Supports selectors, coordinates, click, hover, fill, type, drag, keys, scroll, navigation, reload, eval, cursor movement, and annotations.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        actions: { type: "array", minItems: 1, items: { type: "object" } },
      },
      required: ["sessionId", "actions"],
    },
    annotations: SIDE_EFFECTING,
  },
  {
    name: "purr_work_session_screenshot",
    description:
      "Capture the current persistent browser state and return the PNG directly to the model, with a server-side artifact path.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        out: { type: "string" },
        full: { type: "boolean", default: false },
        selector: { type: "string" },
      },
      required: ["sessionId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_inspect",
    description:
      "Inspect one rendered element through Pursr, including HTML, exact geometry, computed styles, clipping, and stacking ancestors.",
    inputSchema: {
      type: "object",
      properties: { sessionId: SESSION_ID, selector: { type: "string" } },
      required: ["sessionId", "selector"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_diagnostics",
    description:
      "Read bounded dev-server stdout/stderr plus Pursr console messages, page errors, failed requests, and HTTP failures. clear=true clears current buffers after reading.",
    inputSchema: {
      type: "object",
      properties: { sessionId: SESSION_ID, clear: { type: "boolean", default: false } },
      required: ["sessionId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_close",
    description:
      "Close the Pursr browser session, finalize any browser video, and terminate the managed dev-server process tree.",
    inputSchema: {
      type: "object",
      properties: { sessionId: SESSION_ID },
      required: ["sessionId"],
    },
    annotations: SIDE_EFFECTING,
  },
];

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function objectArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
  return items.length === value.length ? items : undefined;
}

function error(message: string, extra: Record<string, unknown> = {}): BrowserWorkMcpToolResult {
  return {
    handled: true,
    isError: true,
    payload: { error: "browser_work_failed", message, ...extra },
  };
}

export async function handleBrowserWorkMcpTool(
  name: string | undefined,
  args: Record<string, unknown>,
): Promise<BrowserWorkMcpToolResult> {
  const toolNames = new Set(BROWSER_WORK_MCP_TOOLS.map((tool) => tool.name));
  if (!toolNames.has(name ?? "")) return { handled: false };
  try {
    const manager = getBrowserWorkSessionManager();
    if (name === "purr_browser_doctor") return { handled: true, payload: await browserDoctor() };
    if (name === "purr_work_sessions") return { handled: true, payload: { sessions: manager.list() } };

    const sessionId = stringValue(args.sessionId);
    if (name !== "purr_work_session_start" && !sessionId) return error("sessionId is required");

    if (name === "purr_work_session_start") {
      const cwd = stringValue(args.cwd);
      if (!cwd) return error("cwd is required");
      const argv = stringArray(args.argv);
      const command = stringValue(args.command);
      const display = argv?.join(" ") ?? command ?? "";
      const destructive = classifyDestructiveCommand(display);
      if (destructive && args.confirmDestructive !== true) {
        return error("destructive command requires confirmDestructive=true", {
          classification: destructive,
          command: display,
        });
      }
      const input: BrowserWorkStartInput = {
        cwd,
        sessionId: stringValue(args.sessionId),
        argv,
        command,
        shell: args.shell === true,
        environmentOverrides:
          args.environmentOverrides && typeof args.environmentOverrides === "object" && !Array.isArray(args.environmentOverrides)
            ? (args.environmentOverrides as Record<string, string>)
            : undefined,
        url: stringValue(args.url),
        host: stringValue(args.host),
        port: typeof args.port === "number" ? args.port : undefined,
        readyPath: stringValue(args.readyPath),
        startupTimeoutMs: typeof args.startupTimeoutMs === "number" ? args.startupTimeoutMs : undefined,
        browserMode: stringValue(args.browserMode) as BrowserWorkMode | undefined,
        browserRequired: args.browserRequired === true,
        cdpUrl: stringValue(args.cdpUrl),
        storageState: args.storageState,
        preset: stringValue(args.preset),
        width: typeof args.width === "number" ? args.width : undefined,
        height: typeof args.height === "number" ? args.height : undefined,
        dpr: typeof args.dpr === "number" ? args.dpr : undefined,
        visual: typeof args.visual === "boolean" ? args.visual : undefined,
        slowMo: typeof args.slowMo === "number" ? args.slowMo : undefined,
        recordVideo: args.recordVideo === true,
      };
      return {
        handled: true,
        payload: {
          session: await manager.start(input),
          destructiveClassification: destructive,
          nextTools: [
            "purr_work_session_snapshot",
            "purr_work_session_act",
            "purr_work_session_screenshot",
            "purr_work_session_diagnostics",
            "purr_work_session_close",
          ],
        },
      };
    }

    if (name === "purr_work_session_status") {
      return { handled: true, payload: manager.status(sessionId!) };
    }
    if (name === "purr_work_session_snapshot") {
      return {
        handled: true,
        payload: await manager.snapshot(sessionId!, {
          selector: stringValue(args.selector),
          maxNodes: typeof args.maxNodes === "number" ? args.maxNodes : undefined,
          includeStyles: typeof args.includeStyles === "boolean" ? args.includeStyles : undefined,
        }),
      };
    }
    if (name === "purr_work_session_act") {
      const actions = objectArray(args.actions);
      if (!actions?.length) return error("actions must be an array of objects");
      return { handled: true, payload: await manager.act(sessionId!, actions) };
    }
    if (name === "purr_work_session_screenshot") {
      const result = await manager.screenshot(sessionId!, {
        out: stringValue(args.out),
        full: args.full === true,
        selector: stringValue(args.selector),
      });
      return {
        handled: true,
        payload: result.metadata,
        content: [
          { type: "text", text: JSON.stringify(result.metadata, null, 2) },
          { type: "image", data: result.data, mimeType: result.mimeType },
        ],
      };
    }
    if (name === "purr_work_session_inspect") {
      return {
        handled: true,
        payload: await manager.inspect(sessionId!, stringValue(args.selector) ?? ""),
      };
    }
    if (name === "purr_work_session_diagnostics") {
      return { handled: true, payload: manager.diagnostics(sessionId!, args.clear === true) };
    }
    if (name === "purr_work_session_close") {
      return { handled: true, payload: await manager.close(sessionId!) };
    }
    return { handled: false };
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : String(caught));
  }
}
