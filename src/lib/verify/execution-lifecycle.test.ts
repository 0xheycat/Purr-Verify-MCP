import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { effectiveDefaultTimeouts } from "./config";
import { resolveExecutionMode } from "./execution-policy";
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
