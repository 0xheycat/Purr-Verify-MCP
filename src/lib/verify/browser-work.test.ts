import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  BrowserWorkSessionManager,
  createPursrBrowserAdapters,
} from "./browser-work";
import {
  BROWSER_WORK_MCP_TOOLS,
  handleBrowserWorkMcpTool,
} from "./browser-work-mcp";
import { createProjectProcessEnvironment } from "./operator-runtime";

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", this.exitCode, signal));
    return true;
  }
}

function canonicalize(cwd: string) {
  return Promise.resolve({ requestedPath: cwd, canonicalPath: cwd, symlink: false });
}

function readyFetch() {
  return Promise.resolve(new Response("ok", { status: 200 }));
}

describe("Pursr browser work sessions", () => {
  test("exposes doctor plus managed start/inspect/act/screenshot/close tools", () => {
    expect(BROWSER_WORK_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "purr_browser_doctor",
      "purr_work_session_start",
      "purr_work_sessions",
      "purr_work_session_status",
      "purr_work_session_snapshot",
      "purr_work_session_act",
      "purr_work_session_screenshot",
      "purr_work_session_artifacts",
      "purr_work_session_inspect",
      "purr_work_session_diagnostics",
      "purr_work_session_close",
    ]);
    expect(BROWSER_WORK_MCP_TOOLS.find((tool) => tool.name === "purr_work_session_act")?.annotations.destructiveHint).toBe(true);
    expect(BROWSER_WORK_MCP_TOOLS.find((tool) => tool.name === "purr_browser_doctor")?.annotations.readOnlyHint).toBe(true);
  });

  test("publishes flexible visual output controls without a PNG-only contract", () => {
    const screenshotTool = BROWSER_WORK_MCP_TOOLS.find(
      (tool) => tool.name === "purr_work_session_screenshot",
    );
    const artifactsTool = BROWSER_WORK_MCP_TOOLS.find(
      (tool) => tool.name === "purr_work_session_artifacts",
    );
    const closeTool = BROWSER_WORK_MCP_TOOLS.find(
      (tool) => tool.name === "purr_work_session_close",
    );
    const screenshotSchema = screenshotTool?.inputSchema as {
      properties?: Record<string, { type?: string; description?: string; default?: unknown }>;
    };
    const artifactsSchema = artifactsTool?.inputSchema as {
      properties?: Record<string, { type?: string; description?: string; default?: unknown }>;
    };
    const closeSchema = closeTool?.inputSchema as {
      properties?: Record<string, { type?: string; description?: string; default?: unknown }>;
    };

    expect(screenshotSchema.properties?.format?.type).toBe("string");
    expect(screenshotSchema.properties?.quality?.type).toBe("number");
    expect(screenshotSchema.properties?.strategy).toMatchObject({
      type: "string",
      enum: ["auto", "playwright", "cdp", "stitched"],
    });
    expect(screenshotSchema.properties?.animations).toMatchObject({
      type: "string",
      enum: ["auto", "allow", "disabled"],
    });
    expect(screenshotSchema.properties?.format?.description).toContain("PNG");
    expect(screenshotSchema.properties?.format?.description).toContain("GIF");
    expect(screenshotSchema.properties?.includeAttachments).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(screenshotSchema.properties?.includeAttachments?.description).toContain("materialization");
    expect(artifactsSchema.properties?.includeAttachments).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(closeSchema.properties?.includeAttachments).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(artifactsTool?.annotations.readOnlyHint).toBe(true);
  });

  test("publishes explicit selector timeout and force controls without automatic force", () => {
    const actTool = BROWSER_WORK_MCP_TOOLS.find(
      (tool) => tool.name === "purr_work_session_act",
    );
    const variants = ((actTool?.inputSchema as {
      properties?: { actions?: { items?: { oneOf?: Array<Record<string, unknown>> } } };
    }).properties?.actions?.items?.oneOf ?? []) as Array<{
      properties?: Record<string, { type?: string; description?: string; minimum?: number }>;
    }>;
    const selectorVariant = variants.find((variant) => variant.properties?.force);

    expect(selectorVariant?.properties?.timeoutMs).toMatchObject({ type: "number", minimum: 0 });
    expect(selectorVariant?.properties?.force?.type).toBe("boolean");
    expect(selectorVariant?.properties?.force?.description).toContain("Never enabled automatically");
  });

  test("publishes a typed eval action contract that requires non-empty js", () => {
    const actTool = BROWSER_WORK_MCP_TOOLS.find(
      (tool) => tool.name === "purr_work_session_act",
    );
    const inputSchema = actTool?.inputSchema as {
      properties?: {
        actions?: {
          items?: {
            oneOf?: Array<{
              properties?: {
                type?: { const?: string };
                js?: { type?: string; minLength?: number };
              };
              required?: string[];
              additionalProperties?: boolean;
            }>;
          };
        };
      };
    };
    const variants = inputSchema.properties?.actions?.items?.oneOf;

    expect(Array.isArray(variants)).toBe(true);
    const evalAction = variants?.find(
      (variant) => variant.properties?.type?.const === "eval",
    );
    expect(evalAction?.required).toContain("js");
    expect(evalAction?.properties?.js).toEqual({ type: "string", minLength: 1 });
    expect(evalAction?.additionalProperties).toBe(false);
  });

  test("injects the installed Playwright driver into Pursr sessions", async () => {
    const calls: Array<{ kind: string; input: unknown }> = [];
    const driver = {
      launch: async (options: Record<string, unknown>) => {
        calls.push({ kind: "launch", input: options });
        return { browser: true };
      },
      connectOverCDP: async (endpointURL: string, options: Record<string, unknown>) => {
        calls.push({ kind: "connect", input: { endpointURL, options } });
        return { browser: true };
      },
    };
    const adapters = createPursrBrowserAdapters(
      {
        found: ["/opt/chromium"],
        preferred: "/opt/chromium",
        candidates: ["/opt/chromium"],
        env: {},
      },
      driver,
    );

    await adapters.launchBrowser({ headless: true, slowMo: 15 });
    await adapters.connectBrowser("http://127.0.0.1:9222", { timeoutMs: 12_000 });

    expect(calls).toEqual([
      {
        kind: "launch",
        input: {
          headless: true,
          executablePath: "/opt/chromium",
          slowMo: 15,
          args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        },
      },
      {
        kind: "connect",
        input: {
          endpointURL: "http://127.0.0.1:9222",
          options: { timeout: 12_000 },
        },
      },
    ]);
  });

  test("starts, closes, and reuses a managed dev-only session ID", async () => {
    const children = [new FakeChild(), new FakeChild()];
    children[1].pid = 4343;
    let spawnIndex = 0;
    const manager = new BrowserWorkSessionManager({
      spawnProcess: (() => children[spawnIndex++] as unknown as ChildProcess) as never,
      fetchImpl: readyFetch as unknown as typeof fetch,
      canonicalize: canonicalize as never,
      sleep: async () => {},
    });

    const started = await manager.start({
      cwd: "/tmp/example",
      sessionId: "dev-only",
      argv: ["npm", "run", "dev"],
      browserMode: "none",
      url: "http://127.0.0.1:3000",
    });

    expect(started.status).toBe("ready");
    expect(started.browserAttached).toBe(false);
    expect(started.pid).toBe(4242);
    expect(manager.status("dev-only").url).toBe("http://127.0.0.1:3000/");

    const closed = await manager.close("dev-only");
    expect(closed.closed).toBe(true);
    expect(manager.status("dev-only").status).toBe("stopped");

    const restarted = await manager.start({
      cwd: "/tmp/example",
      sessionId: "dev-only",
      argv: ["npm", "run", "dev"],
      browserMode: "none",
      url: "http://127.0.0.1:3000",
    });
    expect(restarted.status).toBe("ready");
    expect(restarted.pid).toBe(4343);
    await manager.close("dev-only");
  });

  test("keeps the dev server usable with a warning when Chrome is unavailable", async () => {
    const child = new FakeChild();
    const manager = new BrowserWorkSessionManager({
      spawnProcess: (() => child as unknown as ChildProcess) as never,
      fetchImpl: readyFetch as unknown as typeof fetch,
      canonicalize: canonicalize as never,
      sleep: async () => {},
      loadPursr: (async () => ({
        version: "0.10.2",
        discovery: { found: [], preferred: null, candidates: [], env: {} },
        manager: {},
      })) as never,
    });

    const started = await manager.start({
      cwd: "/tmp/example",
      sessionId: "degraded",
      argv: ["npm", "run", "dev"],
      browserMode: "headless",
      url: "http://127.0.0.1:3000",
    });

    expect(started.status).toBe("degraded");
    expect(started.warning).toContain("Chrome-compatible browser not found");
    await manager.close("degraded");
  });

  test("uses Pursr for persistent snapshot, actions, image evidence, diagnostics, and close", async () => {
    const child = new FakeChild();
    const calls: string[] = [];
    let screenshotOptions: Record<string, unknown> | undefined;
    const browserManager = {
      open: async () => ({ sessionId: "attached-browser" }),
      list: () => [],
      snapshot: async () => ({ nodes: [{ tag: "button" }] }),
      act: async () => ({ acted: true }),
      screenshot: async (_sessionId: string, options: Record<string, unknown>) => {
        screenshotOptions = options;
        return {
          sessionId: "attached-browser",
          out: "/tmp/shot.png",
          url: "http://127.0.0.1:3000/",
          data: "cG5n",
          mimeType: "image/png",
          captureMode: "cdp-viewport-fallback",
          fallbackUsed: true,
          elapsedMs: 42,
          requestedTimeoutMs: 321,
          attempts: [
            { strategy: "playwright", status: "failed", durationMs: 21, errorCode: "CAPTURE_TIMEOUT", error: "timed out" },
            { strategy: "cdp", status: "success", durationMs: 18 },
          ],
          image: { width: 800, height: 600, bytes: 3, mimeType: "image/png" },
          fallbackError: "Playwright capture timed out",
        };
      },
      inspect: async () => ({ selector: "button", width: 100 }),
      diagnostics: () => ({ console: [] }),
      close: async () => {
        calls.push("close");
        return { closed: true };
      },
      closeAll: async () => {},
    };
    const manager = new BrowserWorkSessionManager({
      spawnProcess: (() => child as unknown as ChildProcess) as never,
      fetchImpl: readyFetch as unknown as typeof fetch,
      canonicalize: canonicalize as never,
      sleep: async () => {},
      loadPursr: (async () => ({
        version: "0.10.2",
        discovery: {
          found: ["/usr/bin/chromium"],
          preferred: "/usr/bin/chromium",
          candidates: ["/usr/bin/chromium"],
          env: {},
        },
        manager: browserManager,
      })) as never,
    });

    const started = await manager.start({
      cwd: "/tmp/example",
      sessionId: "attached",
      argv: ["npm", "run", "dev"],
      url: "http://127.0.0.1:3000",
    });
    expect(started.status).toBe("ready");
    expect(started.browserAttached).toBe(true);
    expect(await manager.snapshot("attached")).toEqual({ nodes: [{ tag: "button" }] });
    expect(await manager.act("attached", [{ op: "click", selector: "button" }])).toEqual({ acted: true });
    const screenshot = await manager.screenshot("attached", {
      strategy: "cdp",
      animations: "allow",
      timeoutMs: 321,
    });
    expect(screenshot.mimeType).toBe("image/png");
    expect(screenshotOptions).toEqual({ strategy: "cdp", animations: "allow", timeoutMs: 321 });
    expect(screenshot.metadata).toMatchObject({
      sessionId: "attached",
      browserSessionId: "attached-browser",
      out: "/tmp/shot.png",
      url: "http://127.0.0.1:3000/",
      captureMode: "cdp-viewport-fallback",
      fallbackUsed: true,
      elapsedMs: 42,
      requestedTimeoutMs: 321,
      image: { width: 800, height: 600, bytes: 3, mimeType: "image/png" },
      fallbackError: "Playwright capture timed out",
    });
    expect(screenshot.metadata.attempts).toEqual([
      { strategy: "playwright", status: "failed", durationMs: 21, errorCode: "CAPTURE_TIMEOUT", error: "timed out" },
      { strategy: "cdp", status: "success", durationMs: 18 },
    ]);
    expect(await manager.inspect("attached", "button")).toEqual({ selector: "button", width: 100 });
    expect(manager.diagnostics("attached")).toMatchObject({ browser: { console: [] } });
    child.exitCode = 0;
    child.emit("close", 0, null);
    expect(manager.status("attached").status).toBe("stopped");
    const closed = await manager.close("attached");
    expect(closed.closed).toBe(true);
    expect(manager.status("attached").browserSessionId).toBeNull();
    expect(calls).toEqual(["close"]);
  });

  test("fails promptly when the dev server exits before readiness", async () => {
    const child = new FakeChild();
    const manager = new BrowserWorkSessionManager({
      spawnProcess: (() => child as unknown as ChildProcess) as never,
      fetchImpl: (async () => {
        child.exitCode = 0;
        child.emit("close", 0, null);
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      canonicalize: canonicalize as never,
      sleep: async () => {},
    });

    await expect(
      manager.start({
        cwd: "/tmp/example",
        sessionId: "exited-before-ready",
        argv: ["npm", "run", "dev"],
        browserMode: "none",
        url: "http://127.0.0.1:3000",
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toThrow("dev server exited before readiness with code 0");
  });

  test("requires explicit confirmation only for a concretely destructive start command", async () => {
    const result = await handleBrowserWorkMcpTool("purr_work_session_start", {
      cwd: "/tmp/example",
      command: "rm -rf build",
      shell: true,
    });
    expect(result).toMatchObject({
      handled: true,
      isError: true,
      payload: {
        error: "browser_work_failed",
        classification: "recursive_force_delete",
      },
    });
  });

  test("rejects eval without non-empty js before invoking Pursr", async () => {
    const result = await handleBrowserWorkMcpTool("purr_work_session_act", {
      sessionId: "missing-session",
      actions: [{ type: "eval", script: "({ answer: 42 })" }],
    });

    expect(result).toMatchObject({
      handled: true,
      isError: true,
      payload: {
        error: "browser_work_failed",
        message: "eval action requires non-empty js",
        actionIndex: 0,
      },
    });
  });

  test("adds a readable resource link only when screenshot attachments are explicitly requested", async () => {
    const state = globalThis as typeof globalThis & {
      __purrBrowserWorkManager?: {
        status: (sessionId: string) => { outputDir: string; url: string };
        screenshot: (sessionId: string) => Promise<{
          metadata: Record<string, unknown>;
          data: string;
          mimeType: string;
        }>;
      };
    };
    const previousManager = state.__purrBrowserWorkManager;
    const previousDataDir = process.env.VERIFY_DATA_DIR;
    process.env.VERIFY_DATA_DIR = "/tmp/purr-resource-contract";
    state.__purrBrowserWorkManager = {
      status: (sessionId: string) => ({
        outputDir: `/tmp/purr-resource-contract/browser-work/${sessionId}`,
        url: "http://127.0.0.1:3000/",
      }),
      screenshot: async (sessionId: string) => ({
        metadata: {
          sessionId,
          browserSessionId: `${sessionId}-browser`,
          out: `/tmp/purr-resource-contract/browser-work/${sessionId}/shot.png`,
          url: "http://127.0.0.1:3000/",
        },
        data: "cG5n",
        mimeType: "image/png",
      }),
    };

    try {
      const result = await handleBrowserWorkMcpTool("purr_work_session_screenshot", {
        sessionId: "resource-contract",
        includeAttachments: true,
      });
      const content = result.content ?? [];
      expect(content.map((entry) => entry.type)).toEqual([
        "text",
        "image",
        "resource_link",
      ]);
      expect(content[2]).toMatchObject({
        type: "resource_link",
        name: "shot.png",
        mimeType: "image/png",
        size: 3,
        annotations: {
          audience: ["assistant", "user"],
          priority: 1,
        },
      });
      expect(String(content[2]?.uri)).toStartWith("purr://browser-work/");
    } finally {
      if (previousManager) state.__purrBrowserWorkManager = previousManager;
      else delete state.__purrBrowserWorkManager;
      if (previousDataDir === undefined) delete process.env.VERIFY_DATA_DIR;
      else process.env.VERIFY_DATA_DIR = previousDataDir;
    }
  });

  test("removes Verify service framework internals from child projects while allowing explicit overrides", () => {
    const previous = {
      standalone: process.env.__NEXT_PRIVATE_STANDALONE_CONFIG,
      origin: process.env.__NEXT_PRIVATE_ORIGIN,
      deployment: process.env.NEXT_DEPLOYMENT_ID,
      turbo: process.env.TURBOPACK,
    };
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = "serialized-service-config";
    process.env.__NEXT_PRIVATE_ORIGIN = "https://verify.example";
    process.env.NEXT_DEPLOYMENT_ID = "verify-service";
    process.env.TURBOPACK = "1";
    try {
      const clean = createProjectProcessEnvironment({ NODE_ENV: "test" });
      expect(clean.__NEXT_PRIVATE_STANDALONE_CONFIG).toBeUndefined();
      expect(clean.__NEXT_PRIVATE_ORIGIN).toBeUndefined();
      expect(clean.NEXT_DEPLOYMENT_ID).toBeUndefined();
      expect(clean.TURBOPACK).toBeUndefined();
      expect(clean.NODE_ENV).toBe("test");

      const explicit = createProjectProcessEnvironment({ TURBOPACK: "1" });
      expect(explicit.TURBOPACK).toBe("1");
    } finally {
      if (previous.standalone === undefined) delete process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
      else process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = previous.standalone;
      if (previous.origin === undefined) delete process.env.__NEXT_PRIVATE_ORIGIN;
      else process.env.__NEXT_PRIVATE_ORIGIN = previous.origin;
      if (previous.deployment === undefined) delete process.env.NEXT_DEPLOYMENT_ID;
      else process.env.NEXT_DEPLOYMENT_ID = previous.deployment;
      if (previous.turbo === undefined) delete process.env.TURBOPACK;
      else process.env.TURBOPACK = previous.turbo;
    }
  });

  test("does not intercept unrelated MCP tools", async () => {
    expect(await handleBrowserWorkMcpTool("health_check", {})).toEqual({ handled: false });
  });
});
