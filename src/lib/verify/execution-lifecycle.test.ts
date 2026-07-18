import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_LONG_RUN_TIMEOUT_MS, effectiveDefaultTimeouts } from "./config";
import { resolveExecutionMode } from "./execution-policy";
import {
  decorateMcpResponse,
  routeMcpExecutionBody,
} from "./mcp-execution-routing";
import { validateTimeoutPolicy } from "./mcp";
import { cleanupJobDirectories, runWorkspaceJanitor } from "./workspace-cleanup";

describe("execution routing", () => {
  test("defaults a short smoke command to sync", () => {
    expect(resolveExecutionMode(undefined, ["node --version"])).toMatchObject({
      requestedMode: "auto",
      effectiveMode: "sync",
      routingReason: "auto_short_smoke",
      autoRouted: true,
    });
  });

  test("routes heavy explicit sync work to async instead of rejecting it", () => {
    expect(resolveExecutionMode("sync", ["bun test"])).toMatchObject({
      requestedMode: "sync",
      effectiveMode: "async",
      routingReason: "long_running_commands",
      autoRouted: true,
      detectedLongRunningCommand: "bun test",
    });
  });

  test("keeps explicit async and short explicit sync behavior", () => {
    expect(resolveExecutionMode("async", ["node --version"]).effectiveMode).toBe("async");
    expect(resolveExecutionMode("sync", ["node --version"]).effectiveMode).toBe("sync");
  });

  test("routes multi-command auto jobs to async", () => {
    expect(resolveExecutionMode("auto", ["node --version", "bun --version"])).toMatchObject({
      effectiveMode: "async",
      routingReason: "auto_multi_command",
    });
  });

  test("routes unknown single commands to async while keeping explicit sync available", () => {
    expect(resolveExecutionMode("auto", ["node scripts/smoke.mjs"])).toMatchObject({
      effectiveMode: "async",
      routingReason: "auto_non_smoke",
      autoRouted: true,
    });
    expect(resolveExecutionMode("sync", ["node scripts/smoke.mjs"])).toMatchObject({
      effectiveMode: "sync",
      routingReason: "explicit_sync",
      autoRouted: false,
    });
  });

  test("recognizes Python test tools and long sleeps as long-running", () => {
    expect(resolveExecutionMode("auto", ["python3 -m pytest tests -q"])).toMatchObject({
      effectiveMode: "async",
      routingReason: "long_running_commands",
      detectedLongRunningCommand: "python3 -m pytest tests -q",
    });
    expect(resolveExecutionMode("sync", ["sleep 120"])).toMatchObject({
      effectiveMode: "async",
      routingReason: "long_running_commands",
      detectedLongRunningCommand: "sleep 120",
    });
  });

  test("rewrites an MCP heavy sync request and preserves routing evidence", () => {
    const routed = routeMcpExecutionBody({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_verification_job",
        arguments: {
          repo: "owner/repo",
          ref: "main",
          mode: "sync",
          commands: ["bun test"],
          metadata: { purpose: "proof" },
        },
      },
    });

    const body = routed.body as {
      params: {
        arguments: {
          mode: string;
          metadata: Record<string, unknown>;
        };
      };
    };
    expect(routed.changed).toBe(true);
    expect(routed.routings[0]).toMatchObject({
      requestedMode: "sync",
      effectiveMode: "async",
      routingReason: "long_running_commands",
      autoRouted: true,
    });
    expect(body.params.arguments.mode).toBe("async");
    expect(body.params.arguments.metadata).toMatchObject({
      purpose: "proof",
      _purrExecution: {
        requestedMode: "sync",
        effectiveMode: "async",
      },
    });
  });

  test("decorates the MCP create result with requested and effective modes", () => {
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify({ jobId: "job-1", status: "queued" }) }],
        isError: false,
      },
    };
    const routing = resolveExecutionMode("sync", ["bun test"]);
    const decorated = decorateMcpResponse(
      response,
      [routing],
      ["create_verification_job"]
    ) as typeof response;
    const payload = JSON.parse(decorated.result.content[0].text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      jobId: "job-1",
      requestedMode: "sync",
      effectiveMode: "async",
      routingReason: "long_running_commands",
      autoRouted: true,
    });
  });
});

describe("timeout normalization", () => {
  test("clamps an oversized command timeout to the job timeout", () => {
    expect(
      effectiveDefaultTimeouts({
        configuredCommandTimeoutMs: 6_000_000,
        commandTimeoutMs: 1_800_000,
        jobTimeoutMs: 1_800_000,
      })
    ).toMatchObject({
      configuredCommandTimeoutMs: 6_000_000,
      commandTimeoutMs: 1_800_000,
      jobTimeoutMs: 1_800_000,
      normalized: true,
    });
  });
  test("accepts explicit timeout overrides without requiring long_run", () => {
    const result = validateTimeoutPolicy({
      repo: "owner/repo",
      ref: "main",
      commands: ["bun test"],
      command_timeout_ms: 7_200_000,
    });

    expect(result).toMatchObject({
      ok: true,
      policy: {
        longRun: true,
        commandTimeoutMs: 7_200_000,
        jobTimeoutMs: 7_200_000,
      },
    });
  });

  test("uses a private-friendly long-run max by default", () => {
    expect(MAX_LONG_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(365 * 24 * 60 * 60 * 1000);
  });
});

describe("workspace cleanup", () => {
  test("removes disposable workspace and job cache while returning truthful status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "purr-cleanup-test-"));
    const workspace = path.join(root, "workspace");
    const cache = path.join(root, "cache");
    await fs.mkdir(workspace);
    await fs.mkdir(cache);
    await fs.writeFile(path.join(workspace, "source.txt"), "temporary");
    await fs.writeFile(path.join(cache, "package.bin"), "temporary");

    const result = await cleanupJobDirectories(workspace, cache);
    expect(result).toMatchObject({
      status: "done",
      workspaceRemoved: true,
      cacheRemoved: true,
      workspaceError: null,
      cacheError: null,
    });
    await fs.rm(root, { recursive: true, force: true });
  });

  test("janitor removes old orphan job directories but preserves active jobs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "purr-janitor-test-"));
    const orphanId = "11111111-1111-4111-8111-111111111111";
    const activeId = "22222222-2222-4222-8222-222222222222";
    const orphan = path.join(root, `${orphanId}-aaaaaaaa`);
    const orphanCache = path.join(root, `${orphanId}-aaaaaaaa-cache`);
    const active = path.join(root, `${activeId}-bbbbbbbb`);
    await Promise.all([fs.mkdir(orphan), fs.mkdir(orphanCache), fs.mkdir(active)]);
    const old = new Date(Date.now() - 10_000);
    await Promise.all([fs.utimes(orphan, old, old), fs.utimes(orphanCache, old, old), fs.utimes(active, old, old)]);

    const result = await runWorkspaceJanitor({
      root,
      activeJobIds: new Set([activeId]),
      olderThanMs: 1_000,
    });

    expect(result.filter((entry) => entry.removed)).toHaveLength(2);
    expect(await fs.stat(active).then(() => true).catch(() => false)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});
