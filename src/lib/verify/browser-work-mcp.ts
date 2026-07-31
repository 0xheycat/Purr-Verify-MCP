import {
  browserDoctor,
  getBrowserWorkSessionManager,
  type BrowserWorkMode,
  type BrowserWorkStartInput,
} from "./browser-work";
import {
  browserWorkArtifactResourceLink,
  listBrowserWorkArtifactLinks,
  type BrowserWorkResourceLink,
} from "./browser-work-resource";
import { transcodeBrowserScreenshot } from "./browser-work-media";
import { recordVerifyDebugError } from "./debug";
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

const NON_EVAL_ACTION_TYPES = [
  "click",
  "doubleClick",
  "hover",
  "fill",
  "type",
  "check",
  "select",
  "drag",
  "press",
  "keyDown",
  "keyUp",
  "scroll",
  "wait",
  "sleep",
  "reload",
  "move",
  "annotate",
  "clearAnnotations",
];

const ACTION_TIMEOUT = {
  type: "number",
  minimum: 0,
  description: "Per-action deadline. Overrides the top-level purr_work_session_act timeoutMs.",
};

const BROWSER_ACTION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { const: "eval" },
        js: { type: "string", minLength: 1 },
        timeoutMs: ACTION_TIMEOUT,
        settleMs: { type: "number", minimum: 0 },
      },
      required: ["type", "js"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "eval" },
        js: { type: "string", minLength: 1 },
        timeoutMs: ACTION_TIMEOUT,
        settleMs: { type: "number", minimum: 0 },
      },
      required: ["op", "js"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "navigate" },
        url: {
          type: "string",
          minLength: 1,
          description: "Required absolute or resolvable target URL for navigate actions.",
        },
        timeoutMs: ACTION_TIMEOUT,
        settleMs: { type: "number", minimum: 0 },
      },
      required: ["type", "url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        op: { const: "navigate" },
        url: {
          type: "string",
          minLength: 1,
          description: "Required absolute or resolvable target URL for navigate actions.",
        },
        timeoutMs: ACTION_TIMEOUT,
        settleMs: { type: "number", minimum: 0 },
      },
      required: ["op", "url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { type: "string", enum: NON_EVAL_ACTION_TYPES },
        op: { type: "string", enum: NON_EVAL_ACTION_TYPES },
        selector: {
          type: "string",
          description: "CSS, text, role, label, placeholder, test-id, or xpath selector supported by Pursr.",
        },
        timeoutMs: ACTION_TIMEOUT,
        force: {
          type: "boolean",
          description: "Explicitly bypass Playwright actionability checks for selector actions. Never enabled automatically.",
        },
        text: { type: "string" },
        value: {},
        checked: { type: "boolean" },
        x: { type: "number" },
        y: { type: "number" },
        settleMs: { type: "number", minimum: 0 },
      },
      anyOf: [{ required: ["type"] }, { required: ["op"] }],
      additionalProperties: true,
    },
  ],
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
      "Perform a small ordered Pursr action sequence in the persistent browser. Eval actions require non-empty js and are bounded by timeoutMs. Navigate actions require url. Other actions support selectors, coordinates, click, hover, fill, type, drag, keys, scroll, reload, cursor movement, and annotations.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        timeoutMs: {
          type: "number",
          minimum: 0,
          description: "Default per-action deadline for actions that omit timeoutMs, including eval actions.",
        },
        actions: { type: "array", minItems: 1, items: BROWSER_ACTION_SCHEMA },
      },
      required: ["sessionId", "actions"],
    },
    annotations: SIDE_EFFECTING,
  },
  {
    name: "purr_work_session_screenshot",
    description:
      "Capture the current persistent browser state, return image pixels plus structured Pursr recovery metadata, and publish a readable browser artifact. Auto adapts across Playwright and CDP; stitched is full-page only. PNG is the default, with optional Sharp transcoding after the validated source capture.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        out: {
          type: "string",
          description: "Optional requested copy path. A managed artifact is always retained for MCP resource delivery.",
        },
        full: { type: "boolean", default: false },
        selector: { type: "string" },
        format: {
          type: "string",
          description: "Output image format. Common values include PNG, JPEG/JPG, WebP, GIF, AVIF, and TIFF.",
        },
        quality: {
          type: "number",
          description: "Optional encoder quality. Values are softly clamped to 1-100 instead of rejecting the operation.",
        },
        timeoutMs: {
          type: "number",
          minimum: 0,
          description: "Total capture-operation deadline forwarded to Pursr.",
        },
        strategy: {
          type: "string",
          enum: ["auto", "playwright", "cdp", "stitched"],
          description: "Capture strategy forwarded to Pursr. Auto adapts from per-session capture health; stitched requires full=true.",
        },
        animations: {
          type: "string",
          enum: ["auto", "allow", "disabled"],
          description: "Animation handling forwarded to Pursr. Auto keeps the package default.",
        },
        includeAttachments: {
          type: "boolean",
          default: false,
          description: "Opt in to MCP resource-link attachments. Default false keeps image pixels inline and avoids ChatGPT file-materialization approval prompts.",
        },
      },
      required: ["sessionId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_work_session_artifacts",
    description:
      "List metadata for every regular browser-session artifact, including PNG, JPEG, WebP, GIF, WebM, MP4, audio, PDFs, and unknown binary formats. Set includeAttachments=true only when MCP resource-link attachments are explicitly wanted. No extension whitelist is applied; artifacts remain bounded to the managed browser-work directory.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        includeAttachments: {
          type: "boolean",
          default: false,
          description: "Opt in to MCP resource-link attachments. Default false avoids ChatGPT file-materialization approval prompts.",
        },
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
      "Close the Pursr browser session, finalize any browser video, and terminate the managed dev-server process tree. Final video metadata is returned by default; set includeAttachments=true only when a resource-link attachment is explicitly wanted.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: SESSION_ID,
        includeAttachments: {
          type: "boolean",
          default: false,
          description: "Opt in to a finalized-video resource-link attachment. Default false avoids ChatGPT file-materialization approval prompts.",
        },
      },
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

function artifactMetadata(link: BrowserWorkResourceLink | undefined): Record<string, unknown> | undefined {
  if (!link) return undefined;
  return {
    uri: link.uri,
    name: link.name,
    title: link.title,
    description: link.description,
    mimeType: link.mimeType,
    size: link.size,
  };
}

function error(message: string, extra: Record<string, unknown> = {}): BrowserWorkMcpToolResult {
  return {
    handled: true,
    isError: true,
    payload: { error: "browser_work_failed", message, ...extra },
  };
}

function browserWorkFailure(
  tool: string | undefined,
  sessionId: string | undefined,
  message: string,
  extra: Record<string, unknown> = {},
): BrowserWorkMcpToolResult {
  recordVerifyDebugError({
    phase: "browser_work_tool",
    tool: tool ?? null,
    status: "failed",
    code: "browser_work_failed",
    message,
    hint: sessionId ? `sessionId=${sessionId}` : undefined,
  });
  return error(message, extra);
}

function validateActions(
  actions: Array<Record<string, unknown>>,
): { message: string; extra: Record<string, unknown> } | undefined {
  for (const [actionIndex, action] of actions.entries()) {
    const operation = stringValue(action.type) ?? stringValue(action.op);
    if (operation === "eval" && !stringValue(action.js)) {
      return { message: "eval action requires non-empty js", extra: { actionIndex } };
    }
    if (operation === "navigate" && !stringValue(action.url)) {
      return { message: "navigate action requires non-empty url", extra: { actionIndex } };
    }
  }
  return undefined;
}

export async function handleBrowserWorkMcpTool(
  name: string | undefined,
  args: Record<string, unknown>,
): Promise<BrowserWorkMcpToolResult> {
  const toolNames = new Set(BROWSER_WORK_MCP_TOOLS.map((tool) => tool.name));
  if (!toolNames.has(name ?? "")) return { handled: false };
  const sessionId = stringValue(args.sessionId);
  const fail = (message: string, extra: Record<string, unknown> = {}) =>
    browserWorkFailure(name, sessionId, message, extra);
  try {
    const manager = getBrowserWorkSessionManager();
    if (name === "purr_browser_doctor") return { handled: true, payload: await browserDoctor() };
    if (name === "purr_work_sessions") return { handled: true, payload: { sessions: manager.list() } };

    if (name !== "purr_work_session_start" && !sessionId) return fail("sessionId is required");

    if (name === "purr_work_session_start") {
      const cwd = stringValue(args.cwd);
      if (!cwd) return fail("cwd is required");
      const argv = stringArray(args.argv);
      const command = stringValue(args.command);
      const display = argv?.join(" ") ?? command ?? "";
      const destructive = classifyDestructiveCommand(display);
      if (destructive && args.confirmDestructive !== true) {
        return fail("destructive command requires confirmDestructive=true", {
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
      if (!actions?.length) return fail("actions must be an array of objects");
      const validationError = validateActions(actions);
      if (validationError) return fail(validationError.message, validationError.extra);
      return {
        handled: true,
        payload: await manager.act(sessionId!, actions, {
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        }),
      };
    }
    if (name === "purr_work_session_screenshot") {
      const status = manager.status(sessionId!);
      const outputDir = stringValue(status.outputDir);
      if (!outputDir) return fail("browser work session has no artifact directory");
      const raw = await manager.screenshot(sessionId!, {
        full: args.full === true,
        selector: stringValue(args.selector),
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        strategy: stringValue(args.strategy),
        animations: stringValue(args.animations),
      });
      const result = await transcodeBrowserScreenshot(raw, {
        format: stringValue(args.format),
        quality: typeof args.quality === "number" ? args.quality : undefined,
        out: stringValue(args.out),
        outputDir,
      });
      const resourceLink = browserWorkArtifactResourceLink(
        result.metadata,
        result.data,
        result.mimeType,
      );
      const payload = {
        ...result.metadata,
        ...(resourceLink ? { artifact: artifactMetadata(resourceLink) } : {}),
      };
      return {
        handled: true,
        payload,
        content: [
          { type: "text", text: JSON.stringify(payload, null, 2) },
          {
            type: "image",
            data: result.data,
            mimeType: result.mimeType,
            annotations: { audience: ["assistant", "user"], priority: 1 },
          },
          ...(args.includeAttachments === true && resourceLink ? [resourceLink] : []),
        ],
      };
    }
    if (name === "purr_work_session_artifacts") {
      const status = manager.status(sessionId!);
      const outputDir = stringValue(status.outputDir);
      if (!outputDir) return fail("browser work session has no artifact directory");
      const links = await listBrowserWorkArtifactLinks({
        sessionId,
        outputDir,
        url: status.url,
      });
      const payload = {
        sessionId,
        outputDir,
        count: links.length,
        artifacts: links.map(({ uri, name: artifactName, mimeType, size }) => ({
          uri,
          name: artifactName,
          mimeType,
          size,
        })),
      };
      return {
        handled: true,
        payload,
        content: [
          { type: "text", text: JSON.stringify(payload, null, 2) },
          ...(args.includeAttachments === true ? links : []),
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
      const status = manager.status(sessionId!);
      const payload = await manager.close(sessionId!);
      const browser = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { browser?: unknown }).browser
        : undefined;
      const video = browser && typeof browser === "object" && !Array.isArray(browser)
        ? stringValue((browser as { video?: unknown }).video)
        : undefined;
      const videoLink = video
        ? browserWorkArtifactResourceLink({ sessionId, out: video, url: status.url })
        : undefined;
      const responsePayload = payload && typeof payload === "object" && !Array.isArray(payload)
        ? {
            ...(payload as Record<string, unknown>),
            ...(videoLink ? { videoArtifact: artifactMetadata(videoLink) } : {}),
          }
        : payload;
      return {
        handled: true,
        payload: responsePayload,
        content: [
          { type: "text", text: JSON.stringify(responsePayload, null, 2) },
          ...(args.includeAttachments === true && videoLink ? [videoLink] : []),
        ],
      };
    }
    return { handled: false };
  } catch (caught) {
    return fail(caught instanceof Error ? caught.message : String(caught));
  }
}
