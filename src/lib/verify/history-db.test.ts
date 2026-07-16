import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VerificationHistoryDatabase } from "./history-db";
import type { Job, JobStatus } from "./types";

const databases: VerificationHistoryDatabase[] = [];
const roots: string[] = [];

function iso(index: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function job(index: number, status: JobStatus = "success"): Job {
  const queuedAt = iso(index);
  const terminal = status !== "queued" && status !== "running";
  return {
    jobId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    repo: index % 2 === 0 ? "owner/even" : "owner/odd",
    ref: index % 3 === 0 ? "main" : "feature/history",
    expected_head: "abc1234",
    actual_head: `abc${String(index).padStart(5, "0")}`,
    status,
    queuedAt,
    startedAt: status === "queued" ? null : queuedAt,
    finishedAt: terminal ? iso(index + 1) : null,
    durationMs: terminal ? 1000 : null,
    commands: [
      {
        command: index % 2 === 0 ? "bun test" : "bun run typecheck",
        effectiveCommand: index % 2 === 0 ? "bun test --isolate" : "bun run typecheck",
        status: terminal ? (status === "success" ? "success" : "failed") : status === "running" ? "running" : "pending",
        exitCode: terminal ? (status === "success" ? 0 : 1) : null,
        durationMs: terminal ? 500 : null,
        stdout: `stdout evidence ${index}`,
        stderr: status === "failed" ? `failure evidence ${index}` : "",
        startedAt: status === "queued" ? null : queuedAt,
        finishedAt: terminal ? iso(index + 1) : null,
        truncated: false,
      },
    ],
    summary: {
      passed: status === "success",
      failedCommand: status === "failed" ? (index % 2 === 0 ? "bun test" : "bun run typecheck") : null,
    },
    continue_on_error: false,
    metadata: { index, purpose: "durable-history-test" },
    error: status === "failed" ? "test failure" : null,
    cleanupStatus: terminal ? "done" : "pending",
    cleanup: terminal
      ? {
          status: "done",
          startedAt: iso(index + 1),
          finishedAt: iso(index + 1),
          workspaceRemoved: true,
          cacheRemoved: true,
          workspaceError: null,
          cacheError: null,
        }
      : { status: "pending", startedAt: null, finishedAt: null },
    execution: {
      requestedMode: "auto",
      effectiveMode: terminal && index % 2 === 0 ? "async" : "sync",
      routingReason: "test",
      autoRouted: true,
    },
    tags: [index % 2 === 0 ? "even" : "odd", "history"],
    installStrategies: [],
    resolutionProbe: [],
    runnerRecommendations: [],
    timeoutPolicy: {
      longRun: status === "running",
      commandTimeoutMs: status === "running" ? 32_400_000 : 600_000,
      jobTimeoutMs: status === "running" ? 32_400_000 : 1_800_000,
      maxLongRunTimeoutMs: 32_400_000,
    },
  };
}

async function database(): Promise<{ db: VerificationHistoryDatabase; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "purr-history-db-"));
  const db = new VerificationHistoryDatabase(path.join(root, "history.sqlite"));
  roots.push(root);
  databases.push(db);
  await db.init();
  return { db, root };
}

afterEach(async () => {
  while (databases.length > 0) {
    await databases.pop()?.close().catch(() => {});
  }
  while (roots.length > 0) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("VerificationHistoryDatabase", () => {
  test("uses SQLite WAL and round-trips full job evidence", async () => {
    const { db } = await database();
    const input = job(1, "failed");
    await db.upsert(input);

    expect(db.status()).toMatchObject({
      backend: "sqlite-wal",
      ready: true,
      journalMode: "wal",
      lastError: null,
    });
    expect(await db.get(input.jobId)).toEqual(input);
  });

  test("retains more than 200 jobs with deterministic cursor pagination", async () => {
    const { db } = await database();
    for (let index = 1; index <= 225; index++) {
      await db.upsert(job(index));
    }

    expect(await db.count()).toBe(225);
    const first = await db.listSummaries({ limit: 100 });
    const second = await db.listSummaries({ limit: 100, cursor: first.nextCursor ?? undefined });
    const third = await db.listSummaries({ limit: 100, cursor: second.nextCursor ?? undefined });
    const ids = [...first.jobs, ...second.jobs, ...third.jobs].map((entry) => entry.jobId);

    expect(first.jobs).toHaveLength(100);
    expect(second.jobs).toHaveLength(100);
    expect(third.jobs).toHaveLength(25);
    expect(new Set(ids).size).toBe(225);
    expect(first.jobs[0]?.jobId).toBe(job(225).jobId);
    expect(third.nextCursor).toBeNull();
  });

  test("retains queued and nine-hour running jobs independently of terminal history", async () => {
    const { db } = await database();
    for (let index = 1; index <= 205; index++) {
      await db.upsert(job(index));
    }
    const queued = job(300, "queued");
    const running = job(301, "running");
    await db.upsert(queued);
    await db.upsert(running);

    const queuedPage = await db.listSummaries({ status: "queued", limit: 10 });
    const runningPage = await db.listSummaries({ status: "running", limit: 10 });

    expect(queuedPage.jobs.map((entry) => entry.jobId)).toContain(queued.jobId);
    expect(runningPage.jobs.map((entry) => entry.jobId)).toContain(running.jobId);
    expect((await db.get(running.jobId))?.timeoutPolicy?.jobTimeoutMs).toBe(32_400_000);
    expect(await db.count()).toBe(207);
  });

  test("filters by repository, status, command, tag, text, and latest match", async () => {
    const { db } = await database();
    await db.upsert(job(10, "success"));
    await db.upsert(job(11, "failed"));
    await db.upsert(job(12, "failed"));

    const filtered = await db.listSummaries({
      repo: "owner/even",
      status: "failed",
      command: "bun test",
      tag: "even",
      query: "durable-history-test",
      limit: 20,
    });
    const latest = await db.latest({ repo: "owner/even", status: "failed" });

    expect(filtered.jobs.map((entry) => entry.jobId)).toEqual([job(12).jobId]);
    expect(latest?.jobId).toBe(job(12).jobId);
  });

  test("migrates legacy JSON idempotently without deleting source evidence", async () => {
    const { db, root } = await database();
    const legacyDir = path.join(root, "jobs");
    await fs.mkdir(legacyDir);
    const legacy = job(44, "failed");
    const legacyFile = path.join(legacyDir, `${legacy.jobId}.json`);
    await fs.writeFile(legacyFile, JSON.stringify(legacy), "utf8");

    expect(await db.migrateLegacyDirectory(legacyDir)).toBe(1);
    expect(await db.migrateLegacyDirectory(legacyDir)).toBe(1);
    expect(await db.count()).toBe(1);
    expect(await db.get(legacy.jobId)).toEqual(legacy);
    expect(await fs.readFile(legacyFile, "utf8")).toContain(legacy.jobId);
  });

  test("deleteFinished preserves active work", async () => {
    const { db } = await database();
    const finished = job(70, "success");
    const queued = job(71, "queued");
    const running = job(72, "running");
    await db.upsert(finished);
    await db.upsert(queued);
    await db.upsert(running);

    expect(await db.deleteFinished()).toBe(1);
    expect(await db.get(finished.jobId)).toBeNull();
    expect(await db.get(queued.jobId)).not.toBeNull();
    expect(await db.get(running.jobId)).not.toBeNull();
  });
});
