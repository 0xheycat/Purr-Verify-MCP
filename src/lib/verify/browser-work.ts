import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { MAX_LONG_RUN_TIMEOUT_MS, getConfig } from "./config";
import { canonicalDirectory } from "./operator-inspection";
import { redactText } from "./redact";
import { createProjectProcessEnvironment } from "./operator-runtime";

export type BrowserWorkMode = "headless" | "visible" | "cdp" | "none";
export type BrowserWorkStatus = "starting" | "ready" | "degraded" | "failed" | "stopping" | "stopped";

export interface BrowserWorkStartInput {
  cwd: string;
  sessionId?: string;
  argv?: string[];
  command?: string;
  shell?: boolean;
  environmentOverrides?: Record<string, string>;
  url?: string;
  host?: string;
  port?: number;
  readyPath?: string;
  startupTimeoutMs?: number;
  browserMode?: BrowserWorkMode;
  browserRequired?: boolean;
  cdpUrl?: string;
  storageState?: unknown;
  preset?: string;
  width?: number;
  height?: number;
  dpr?: number;
  visual?: boolean;
  slowMo?: number;
  recordVideo?: boolean;
}

export interface BrowserWorkSummary {
  sessionId: string;
  cwd: string;
  status: BrowserWorkStatus;
  command: string;
  pid: number | null;
  url: string | null;
  browserMode: BrowserWorkMode;
  browserAttached: boolean;
  browserSessionId: string | null;
  outputDir: string;
  startedAt: string;
  updatedAt: string;
  exitCode: number | null;
  warning: string | null;
  error: string | null;
}

interface PursrBrowserSessionManager {
  open(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  list(): Array<Record<string, unknown>>;
  snapshot(sessionId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  act(sessionId: string, actions: Array<Record<string, unknown>>): Promise<Record<string, unknown>>;
  screenshot(sessionId: string, options?: Record<string, unknown>): Promise<{
    sessionId: string;
    out: string;
    url: string;
    data: string;
    mimeType: string;
  }>;
  inspect(sessionId: string, selector: string): Promise<Record<string, unknown>>;
  diagnostics(sessionId: string, options?: { clear?: boolean }): Record<string, unknown>;
  close(sessionId: string): Promise<Record<string, unknown>>;
  closeAll(): Promise<void>;
}

interface BrowserDiscoveryResult {
  found: string[];
  preferred: string | null;
  candidates: string[];
  env: Record<string, boolean>;
}

interface PlaywrightChromiumDriver {
  launch(options: Record<string, unknown>): Promise<unknown>;
  connectOverCDP(endpointURL: string, options: Record<string, unknown>): Promise<unknown>;
}

interface BrowserWorkRecord extends BrowserWorkSummary {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  browserResult: Record<string, unknown> | null;
  browserManager: PursrBrowserSessionManager | null;
  environmentSecrets: string[];
}

export interface BrowserWorkDependencies {
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
  canonicalize?: typeof canonicalDirectory;
  loadPursr?: typeof loadPursrRuntime;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const require = createRequire(import.meta.url);
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{2,5})?(?:\/[^\s"']*)?/gi;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,96}$/;
const RESERVED_ENV = new Set([
  "PATH",
  "NODE_PATH",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
]);

interface BrowserWorkGlobalState {
  __purrBrowserWorkManager?: BrowserWorkSessionManager;
  __purrBrowserWorkExitHookInstalled?: boolean;
}

function globalState(): typeof globalThis & BrowserWorkGlobalState {
  return globalThis as typeof globalThis & BrowserWorkGlobalState;
}

function cleanSessionId(raw?: string): string {
  const value = String(raw ?? "").trim() || `work-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  if (!SESSION_ID_RE.test(value)) {
    throw new Error("sessionId must use only letters, numbers, dot, underscore, or dash");
  }
  return value;
}

function safePort(value: unknown): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535");
  return port;
}

function normalizeReadyPath(value?: string): string {
  if (!value) return "/";
  const readyPath = value.trim();
  if (!readyPath.startsWith("/") || readyPath.startsWith("//")) {
    throw new Error("readyPath must be an absolute URL path beginning with /");
  }
  return readyPath;
}

function validateEnvironment(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("environmentOverrides must be an object of string values");
  }
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid environment key: ${key}`);
    if (RESERVED_ENV.has(key.toUpperCase())) throw new Error(`environment key is reserved: ${key}`);
    if (typeof raw !== "string") throw new Error(`environment value for ${key} must be a string`);
    output[key] = raw;
  }
  return output;
}

function commandSpec(input: BrowserWorkStartInput): {
  program: string;
  args: string[];
  display: string;
} {
  if (input.argv?.length) {
    return {
      program: input.argv[0],
      args: input.argv.slice(1),
      display: input.argv.join(" "),
    };
  }
  const command = input.command?.trim();
  if (command && input.shell === true) {
    return { program: "/bin/sh", args: ["-lc", command], display: command };
  }
  throw new Error("provide argv, or provide command with shell=true");
}

function normalizedLoopbackUrl(input: BrowserWorkStartInput): string {
  if (input.url) {
    const parsed = new URL(input.url);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("url must use http or https");
    return parsed.toString();
  }
  const host = String(input.host ?? "127.0.0.1").trim();
  if (!host || /[\s/]/.test(host)) throw new Error("host is invalid");
  return `http://${host}:${safePort(input.port)}/`;
}

function withReadyPath(base: string, readyPath: string): string {
  const url = new URL(base);
  url.pathname = readyPath;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function killTree(child: ChildProcess | null | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to the direct child.
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already have exited.
  }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const merged = current + chunk;
  const bytes = Buffer.from(merged, "utf8");
  if (bytes.length <= maxBytes) return merged;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function latestLoopbackUrl(...values: string[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    for (const match of value.matchAll(URL_RE)) latest = match[0];
  }
  return latest;
}

export function createPursrBrowserAdapters(
  discovery: BrowserDiscoveryResult,
  driver: PlaywrightChromiumDriver = chromium as unknown as PlaywrightChromiumDriver,
) {
  const launchBrowser = async (options: Record<string, unknown> = {}) => {
    const executablePath =
      typeof options.executablePath === "string" ? options.executablePath : discovery.preferred;
    if (!executablePath) {
      throw new Error("Chrome-compatible browser not found; install one or set PURSR_BROWSER_PATH");
    }
    return driver.launch({
      headless: options.headless !== false,
      executablePath,
      slowMo: Math.max(0, Number(options.slowMo) || 0),
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
  };
  const connectBrowser = async (endpointURL: string, options: Record<string, unknown> = {}) => {
    return driver.connectOverCDP(endpointURL, {
      timeout: Math.max(1, Number(options.timeoutMs) || 30_000),
    });
  };
  return { launchBrowser, connectBrowser };
}

async function loadPursrRuntime(outputDir: string): Promise<{
  version: string;
  discovery: BrowserDiscoveryResult;
  manager: PursrBrowserSessionManager;
}> {
  const [{ BrowserSessionManager }, { discoverBrowsers }, pursr] = await Promise.all([
    import("pursr/session"),
    import("pursr/browser-discovery"),
    import("pursr"),
  ]);
  const discovery = discoverBrowsers() as BrowserDiscoveryResult;
  const { launchBrowser, connectBrowser } = createPursrBrowserAdapters(discovery);
  return {
    version: String(pursr.VERSION ?? "unknown"),
    discovery,
    manager: new BrowserSessionManager({
      outputDir,
      launchBrowser,
      connectBrowser,
    }) as PursrBrowserSessionManager,
  };
}

export async function browserDoctor(): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  const outputDir = path.join(cfg.dataDir, "browser-work");
  try {
    const runtime = await loadPursrRuntime(outputDir);
    let playwrightCore = "available";
    try {
      const resolved = require.resolve("playwright-core");
      if (typeof resolved === "string") playwrightCore = resolved;
    } catch {
      // The static import above is the authoritative runtime dependency.
    }
    return {
      status: runtime.discovery.preferred && playwrightCore ? "ready" : "needs_setup",
      pursrVersion: runtime.version,
      playwrightCore,
      browser: runtime.discovery,
      outputDir,
      activeSessions: getBrowserWorkSessionManager().list(),
      setupHints: [
        ...(playwrightCore ? [] : ["Install playwright-core in Purr Verify MCP."]),
        ...(runtime.discovery.preferred
          ? []
          : ["Install Chrome, Chromium, Edge, or Brave, or set PURSR_BROWSER_PATH for the Verify service."]),
      ],
    };
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
      outputDir,
      setupHints: ["Install pursr and playwright-core in Purr Verify MCP."],
    };
  }
}

export class BrowserWorkSessionManager {
  private readonly records = new Map<string, BrowserWorkRecord>();
  private readonly spawnProcess: typeof spawn;
  private readonly fetchImpl: typeof fetch;
  private readonly canonicalize: typeof canonicalDirectory;
  private readonly loadPursr: typeof loadPursrRuntime;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: BrowserWorkDependencies = {}) {
    this.spawnProcess = deps.spawnProcess ?? spawn;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.canonicalize = deps.canonicalize ?? canonicalDirectory;
    this.loadPursr = deps.loadPursr ?? loadPursrRuntime;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  list(): BrowserWorkSummary[] {
    return [...this.records.values()].map((record) => this.summary(record));
  }

  status(sessionId: string): BrowserWorkSummary {
    return this.summary(this.get(sessionId));
  }

  async start(input: BrowserWorkStartInput): Promise<BrowserWorkSummary> {
    if (!input.cwd) throw new Error("cwd is required");
    const id = cleanSessionId(input.sessionId);
    const existing = this.records.get(id);
    if (existing) {
      if (!new Set<BrowserWorkStatus>(["failed", "stopped"]).has(existing.status)) {
        throw new Error(`work session already exists: ${id}`);
      }
      await this.close(id);
      this.records.delete(id);
    }
    const cwd = (await this.canonicalize(input.cwd)).canonicalPath;
    const command = commandSpec(input);
    const environmentOverrides = validateEnvironment(input.environmentOverrides);
    const environmentSecrets = Object.values(environmentOverrides).filter((value) => value.length >= 6);
    const cfg = getConfig();
    const outputDir = path.join(cfg.dataDir, "browser-work", id);
    await fs.mkdir(outputDir, { recursive: true });
    const mode = input.browserMode ?? "headless";
    if (!new Set<BrowserWorkMode>(["headless", "visible", "cdp", "none"]).has(mode)) {
      throw new Error("browserMode must be headless, visible, cdp, or none");
    }
    const baseUrl = normalizedLoopbackUrl(input);
    const readyPath = normalizeReadyPath(input.readyPath);
    const startedAt = this.now().toISOString();
    const child = this.spawnProcess(command.program, command.args, {
      cwd,
      env: createProjectProcessEnvironment(environmentOverrides),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    const record: BrowserWorkRecord = {
      sessionId: id,
      cwd,
      status: "starting",
      command: command.display,
      pid: child.pid ?? null,
      url: null,
      browserMode: mode,
      browserAttached: false,
      browserSessionId: null,
      outputDir,
      startedAt,
      updatedAt: startedAt,
      exitCode: null,
      warning: null,
      error: null,
      child,
      stdout: "",
      stderr: "",
      browserResult: null,
      browserManager: null,
      environmentSecrets,
    };
    this.records.set(id, record);
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = redactText(String(chunk), environmentSecrets);
      record[stream] = appendBounded(record[stream], text, cfg.maxLogBytes);
      record.updatedAt = this.now().toISOString();
    };
    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      record.status = "failed";
      record.error = `failed to start dev server: ${error.message}`;
      record.updatedAt = this.now().toISOString();
    });
    child.on("close", (code) => {
      record.exitCode = code;
      if (!new Set<BrowserWorkStatus>(["stopping", "stopped"]).has(record.status)) {
        record.status = code === 0 ? "stopped" : "failed";
        if (code !== 0 && !record.error) record.error = `dev server exited with code ${code}`;
      }
      record.updatedAt = this.now().toISOString();
    });

    try {
      const startupTimeoutMs = Math.max(
        1_000,
        Math.min(
          Number(input.startupTimeoutMs ?? process.env.PURR_WORK_SESSION_STARTUP_TIMEOUT_MS ?? 120_000),
          MAX_LONG_RUN_TIMEOUT_MS,
        ),
      );
      const deadline = Date.now() + startupTimeoutMs;
      let readyUrl: string | null = null;
      let lastProbeError = "dev server is not ready";
      while (Date.now() < deadline) {
        if (record.status === "failed") throw new Error(record.error ?? "dev server failed during startup");
        if (record.status === "stopped") {
          throw new Error(`dev server exited before readiness with code ${record.exitCode ?? "unknown"}`);
        }
        const detected = latestLoopbackUrl(record.stdout, record.stderr);
        const candidates = [...new Set([detected, baseUrl].filter((value): value is string => Boolean(value)))];
        for (const candidate of candidates) {
          try {
            const probeUrl = withReadyPath(candidate, readyPath);
            const response = await this.fetchImpl(probeUrl, { signal: AbortSignal.timeout(3_000) });
            if (response.status < 500) {
              readyUrl = new URL(candidate).toString();
              break;
            }
            lastProbeError = `received HTTP ${response.status} from ${probeUrl}`;
          } catch (error) {
            lastProbeError = error instanceof Error ? error.message : String(error);
          }
        }
        if (readyUrl) break;
        await this.sleep(350);
      }
      if (!readyUrl) throw new Error(`dev server readiness timed out: ${lastProbeError}`);
      record.url = readyUrl;

      if (mode === "none") {
        record.status = "ready";
        record.updatedAt = this.now().toISOString();
        return this.summary(record);
      }

      try {
        const runtime = await this.loadPursr(outputDir);
        if (mode !== "cdp" && !runtime.discovery.preferred) {
          throw new Error("Chrome-compatible browser not found; install one or set PURSR_BROWSER_PATH");
        }
        const browserSessionId = `${id}-browser`;
        const browserResult = await runtime.manager.open({
          sessionId: browserSessionId,
          url: readyUrl,
          flags: {
            mode,
            cdpUrl: input.cdpUrl,
            preset: input.preset,
            width: input.width,
            height: input.height,
            dpr: input.dpr,
            visual: input.visual ?? mode === "visible",
            slowMo: input.slowMo,
            recordVideoDir: input.recordVideo ? path.join(outputDir, "video") : undefined,
          },
          storageState: input.storageState,
        });
        record.browserManager = runtime.manager;
        record.browserSessionId = browserSessionId;
        record.browserAttached = true;
        record.browserResult = browserResult;
        record.status = "ready";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (input.browserRequired === true) throw error;
        record.status = "degraded";
        record.warning = `dev server is ready, but browser attachment is unavailable: ${message}`;
      }
      record.updatedAt = this.now().toISOString();
      return this.summary(record);
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.updatedAt = this.now().toISOString();
      await this.stopProcess(record);
      throw error;
    }
  }

  async snapshot(sessionId: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const record = this.requireBrowser(sessionId);
    return record.browserManager!.snapshot(record.browserSessionId!, options);
  }

  async act(sessionId: string, actions: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (!Array.isArray(actions) || actions.length === 0) throw new Error("actions must be a non-empty array");
    const record = this.requireBrowser(sessionId);
    const result = await record.browserManager!.act(record.browserSessionId!, actions);
    record.updatedAt = this.now().toISOString();
    return result;
  }

  async screenshot(
    sessionId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ metadata: Record<string, unknown>; data: string; mimeType: string }> {
    const record = this.requireBrowser(sessionId);
    const result = await record.browserManager!.screenshot(record.browserSessionId!, options);
    record.updatedAt = this.now().toISOString();
    return {
      metadata: { sessionId, browserSessionId: record.browserSessionId, out: result.out, url: result.url },
      data: result.data,
      mimeType: result.mimeType,
    };
  }

  async inspect(sessionId: string, selector: string): Promise<Record<string, unknown>> {
    if (!selector?.trim()) throw new Error("selector is required");
    const record = this.requireBrowser(sessionId);
    return record.browserManager!.inspect(record.browserSessionId!, selector);
  }

  diagnostics(sessionId: string, clear = false): Record<string, unknown> {
    const record = this.get(sessionId);
    const browser = record.browserAttached
      ? record.browserManager!.diagnostics(record.browserSessionId!, { clear })
      : null;
    const result = {
      session: this.summary(record),
      devServer: {
        stdout: record.stdout,
        stderr: record.stderr,
      },
      browser,
    };
    if (clear) {
      record.stdout = "";
      record.stderr = "";
    }
    return result;
  }

  async close(sessionId: string): Promise<Record<string, unknown>> {
    const record = this.get(sessionId);
    const processAlive = record.child.exitCode === null && record.child.signalCode === null;
    if (record.status === "stopped" && !record.browserAttached && !processAlive) {
      return { ...this.summary(record), closed: false };
    }
    record.status = "stopping";
    record.updatedAt = this.now().toISOString();
    let browser: Record<string, unknown> | null = null;
    if (record.browserAttached && record.browserManager && record.browserSessionId) {
      try {
        browser = await record.browserManager.close(record.browserSessionId);
      } catch (error) {
        record.warning = `browser close warning: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await this.stopProcess(record);
    record.status = "stopped";
    record.browserAttached = false;
    record.browserManager = null;
    record.browserSessionId = null;
    record.updatedAt = this.now().toISOString();
    return { ...this.summary(record), closed: true, browser };
  }

  closeAllSync(): void {
    for (const record of this.records.values()) killTree(record.child, "SIGTERM");
  }

  private get(sessionId: string): BrowserWorkRecord {
    const record = this.records.get(String(sessionId ?? ""));
    if (!record) throw new Error(`unknown work session: ${sessionId}`);
    return record;
  }

  private requireBrowser(sessionId: string): BrowserWorkRecord {
    const record = this.get(sessionId);
    if (!record.browserAttached || !record.browserManager || !record.browserSessionId) {
      throw new Error(record.warning ?? "browser is not attached to this work session");
    }
    return record;
  }

  private summary(record: BrowserWorkRecord): BrowserWorkSummary {
    return {
      sessionId: record.sessionId,
      cwd: record.cwd,
      status: record.status,
      command: record.command,
      pid: record.pid,
      url: record.url,
      browserMode: record.browserMode,
      browserAttached: record.browserAttached,
      browserSessionId: record.browserSessionId,
      outputDir: record.outputDir,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      exitCode: record.exitCode,
      warning: record.warning,
      error: record.error,
    };
  }

  private async stopProcess(record: BrowserWorkRecord): Promise<void> {
    if (record.child.exitCode !== null || record.child.signalCode !== null) return;
    killTree(record.child, "SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => record.child.once("close", () => resolve())),
      this.sleep(3_000),
    ]);
    if (record.child.exitCode === null && record.child.signalCode === null) killTree(record.child, "SIGKILL");
  }
}

export function getBrowserWorkSessionManager(): BrowserWorkSessionManager {
  const state = globalState();
  if (!state.__purrBrowserWorkManager) {
    state.__purrBrowserWorkManager = new BrowserWorkSessionManager();
  }
  if (!state.__purrBrowserWorkExitHookInstalled) {
    state.__purrBrowserWorkExitHookInstalled = true;
    process.once("exit", () => state.__purrBrowserWorkManager?.closeAllSync());
  }
  return state.__purrBrowserWorkManager;
}
