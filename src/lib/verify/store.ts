// Runtime job cache backed by durable SQLite WAL history and legacy JSON files.
//
// Source workspaces remain disposable. Job metadata, redacted logs, cleanup
// evidence, and terminal state are persisted independently so agents can
// inspect prior verification work after cleanup or restart.

import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";
import { resolveInlineServerEnvRefs } from "./server-env-ref";
import {
  getHistoryDatabase,
  historyBackendStatus,
  isTerminalStatus,
  type HistoryBackendStatus,
  type HistoryPage,
  type HistoryQuery,
  type VerificationHistorySummary,
} from "./history-db";
import type {
  ExecutionRoutingRecord,
  Job,
  JobStatus,
  ResolutionProbeModuleRequest,
} from "./types";

interface RuntimeState {
  currentChild?: ChildProcess | null;
  backgroundChildren?: ChildProcess[];
  jobTimer?: NodeJS.Timeout | null;
  cancelRequested?: boolean;
  githubToken?: string | null;
  env?: Record<string, string> | null;
  resolutionProbePackages?: string[];
  resolutionProbeModules?: ResolutionProbeModuleRequest[];
}

interface StoreGlobal {
  __purrVerifyJobs?: Map<string, Job>;
  __purrVerifyRuntime?: Map<string, RuntimeState>;
  __purrVerifyLoadPromise?: Promise<void>;
  __purrVerifyLoaded?: boolean;
  __purrVerifyPendingPersistence?: Map<string, Job>;
  __purrVerifyPersistenceTimers?: Map<string, NodeJS.Timeout>;
  __purrVerifyPersistenceChains?: Map<string, Promise<void>>;
  __purrVerifyPersistenceError?: string | null;
  __purrVerifyPersistenceFallback?: "none" | "legacy-json";
}

function storeGlobal(): StoreGlobal {
  return globalThis as StoreGlobal;
}

const globalStore = storeGlobal();
const jobs = globalStore.__purrVerifyJobs ?? new Map<string, Job>();
const runtime = globalStore.__purrVerifyRuntime ?? new Map<string, RuntimeState>();
const pendingPersistence =
  globalStore.__purrVerifyPendingPersistence ?? new Map<string, Job>();
const persistenceTimers =
  globalStore.__purrVerifyPersistenceTimers ?? new Map<string, NodeJS.Timeout>();
const persistenceChains =
  globalStore.__purrVerifyPersistenceChains ?? new Map<string, Promise<void>>();

globalStore.__purrVerifyJobs = jobs;
globalStore.__purrVerifyRuntime = runtime;
globalStore.__purrVerifyPendingPersistence = pendingPersistence;
globalStore.__purrVerifyPersistenceTimers = persistenceTimers;
globalStore.__purrVerifyPersistenceChains = persistenceChains;

const MAX_MEMORY_TERMINAL_JOBS = 500;
// Keep active state durable without rewriting a potentially large job record
// for every stdout chunk during an 8-9 hour smoke or soak run.
const PERSIST_DEBOUNCE_MS = 5_000;

function jobsDir(): string {
  return path.join(getConfig().dataDir, "jobs");
}

async function ensureLegacyDir(): Promise<void> {
  await fs.mkdir(jobsDir(), { recursive: true });
}

function cloneJob(job: Job): Job {
  return JSON.parse(JSON.stringify(job)) as Job;
}

async function writeLegacyJson(job: Job): Promise<void> {
  await ensureLegacyDir();
  const file = path.join(jobsDir(), `${job.jobId}.json`);
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(temp, file);
}

async function persistSnapshot(job: Job): Promise<void> {
  try {
    await (await getHistoryDatabase()).upsert(job);
    globalStore.__purrVerifyPersistenceError = null;
    globalStore.__purrVerifyPersistenceFallback = "none";
    return;
  } catch (error) {
    const sqliteError = error instanceof Error ? error.message : String(error);
    try {
      await writeLegacyJson(job);
      globalStore.__purrVerifyPersistenceError = sqliteError;
      globalStore.__purrVerifyPersistenceFallback = "legacy-json";
      return;
    } catch (fallbackError) {
      const jsonError =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      globalStore.__purrVerifyPersistenceError = `${sqliteError}; legacy JSON fallback failed: ${jsonError}`;
      globalStore.__purrVerifyPersistenceFallback = "legacy-json";
      throw new Error(globalStore.__purrVerifyPersistenceError);
    }
  }
}

function startPersistenceFlush(jobId: string): Promise<void> {
  const timer = persistenceTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    persistenceTimers.delete(jobId);
  }
  const snapshot = pendingPersistence.get(jobId);
  if (!snapshot) return persistenceChains.get(jobId) ?? Promise.resolve();
  pendingPersistence.delete(jobId);
  const previous = persistenceChains.get(jobId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => persistSnapshot(snapshot))
    .catch(() => {
      // Persistence status is exposed through health. Runtime execution must
      // continue even when both history backends are temporarily unavailable.
    })
    .then(async () => {
      if (pendingPersistence.has(jobId)) {
        await startPersistenceFlush(jobId);
      }
    })
    .finally(() => {
      if (!pendingPersistence.has(jobId) && persistenceChains.get(jobId) === next) {
        persistenceChains.delete(jobId);
      }
    });
  persistenceChains.set(jobId, next);
  return next;
}

function schedulePersistence(job: Job, immediate = false): void {
  pendingPersistence.set(job.jobId, cloneJob(job));
  if (immediate) {
    void startPersistenceFlush(job.jobId);
    return;
  }
  if (persistenceTimers.has(job.jobId)) return;
  const timer = setTimeout(() => {
    persistenceTimers.delete(job.jobId);
    void startPersistenceFlush(job.jobId);
  }, PERSIST_DEBOUNCE_MS);
  timer.unref?.();
  persistenceTimers.set(job.jobId, timer);
}

export async function flushJobPersistence(jobId: string): Promise<void> {
  await startPersistenceFlush(jobId);
  while (pendingPersistence.has(jobId) || persistenceChains.has(jobId)) {
    const chain = persistenceChains.get(jobId);
    if (chain) await chain;
    if (pendingPersistence.has(jobId)) await startPersistenceFlush(jobId);
  }
}

function cacheJob(job: Job): Job {
  jobs.set(job.jobId, job);
  if (!runtime.has(job.jobId)) {
    runtime.set(job.jobId, {
      currentChild: null,
      backgroundChildren: [],
      jobTimer: null,
      cancelRequested: false,
      githubToken: null,
      env: null,
      resolutionProbePackages: [],
      resolutionProbeModules: [],
    });
  }
  return job;
}

async function readLegacyJobs(): Promise<Job[]> {
  const files = await fs.readdir(jobsDir()).catch(() => [] as string[]);
  const loaded: Job[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(jobsDir(), file), "utf8");
      const job = JSON.parse(raw) as Job;
      if (job?.jobId && job?.queuedAt && Array.isArray(job.commands)) loaded.push(job);
    } catch {
      // Keep corrupt files untouched for manual recovery.
    }
  }
  return loaded.sort((a, b) =>
    a.queuedAt === b.queuedAt
      ? b.jobId.localeCompare(a.jobId)
      : b.queuedAt.localeCompare(a.queuedAt)
  );
}

async function markInterrupted(job: Job): Promise<Job> {
  if (job.status === "queued") {
    cacheJob(job);
    return job;
  }
  if (job.status !== "running") return job;
  job.status = "failed";
  job.error = "Job was interrupted by server restart";
  job.finishedAt = job.finishedAt || new Date().toISOString();
  if (job.startedAt) {
    job.durationMs = Math.max(
      0,
      new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
    );
  }
  for (const command of job.commands) {
    if (command.status === "pending" || command.status === "running") {
      command.status = "skipped";
    }
  }
  job.summary = {
    passed: false,
    failedCommand: job.summary?.failedCommand ?? null,
  };
  cacheJob(job);
  schedulePersistence(job, true);
  await flushJobPersistence(job.jobId);
  return job;
}

async function loadAllActiveFromDatabase(
  status: "queued" | "running"
): Promise<Job[]> {
  const database = await getHistoryDatabase();
  const active: Job[] = [];
  let cursor: string | undefined;
  do {
    const page = await database.listFull({ status, limit: 200, cursor });
    active.push(...page.jobs);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return active;
}

export async function loadPersisted(): Promise<void> {
  if (globalStore.__purrVerifyLoaded) return;
  if (globalStore.__purrVerifyLoadPromise) {
    await globalStore.__purrVerifyLoadPromise;
    return;
  }
  globalStore.__purrVerifyLoadPromise = (async () => {
    let loadedFromSqlite = false;
    try {
      const db = await getHistoryDatabase();
      await db.migrateLegacyDirectory(jobsDir());
      const [recent, running, queued] = await Promise.all([
        db.listFull({ limit: 200 }),
        loadAllActiveFromDatabase("running"),
        loadAllActiveFromDatabase("queued"),
      ]);
      const merged = new Map<string, Job>();
      for (const job of recent.jobs) merged.set(job.jobId, job);
      for (const job of running) merged.set(job.jobId, job);
      for (const job of queued) merged.set(job.jobId, job);
      for (const job of merged.values()) cacheJob(job);
      loadedFromSqlite = true;
    } catch (error) {
      globalStore.__purrVerifyPersistenceError =
        error instanceof Error ? error.message : String(error);
    }

    if (!loadedFromSqlite) {
      const legacy = await readLegacyJobs();
      const active = legacy.filter(
        (job) => job.status === "running" || job.status === "queued"
      );
      const recentTerminal = legacy
        .filter((job) => job.status !== "running" && job.status !== "queued")
        .slice(0, MAX_MEMORY_TERMINAL_JOBS);
      for (const job of [...active, ...recentTerminal]) cacheJob(job);
    }

    for (const job of Array.from(jobs.values())) {
      if (job.status === "running" || job.status === "queued") {
        await markInterrupted(job);
      }
    }
    trimOldJobs();
    globalStore.__purrVerifyLoaded = true;
  })().finally(() => {
    delete globalStore.__purrVerifyLoadPromise;
  });
  await globalStore.__purrVerifyLoadPromise;
}

export function createJob(input: {
  repo: string;
  ref: string;
  expected_head?: string;
  commands: string[];
  continue_on_error: boolean;
  metadata: Record<string, unknown>;
  callback_url?: string;
  tags?: string[];
  githubToken?: string;
  env?: Record<string, string>;
  resolutionProbePackages?: string[];
  resolutionProbeModules?: ResolutionProbeModuleRequest[];
  timeoutPolicy?: Job["timeoutPolicy"];
  execution?: ExecutionRoutingRecord;
}): Job {
  const now = new Date().toISOString();
  const job: Job = {
    jobId: randomUUID(),
    repo: input.repo,
    ref: input.ref,
    expected_head: input.expected_head,
    status: "queued",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    queuedAt: now,
    commands: input.commands.map((command) => ({
      command,
      status: "pending",
      exitCode: null,
      durationMs: null,
      stdout: "",
      stderr: "",
      startedAt: null,
      finishedAt: null,
      truncated: false,
    })),
    summary: { passed: false, failedCommand: null },
    continue_on_error: input.continue_on_error,
    metadata: input.metadata,
    callback_url: input.callback_url,
    error: null,
    cleanupStatus: "pending",
    cleanup: { status: "pending", startedAt: null, finishedAt: null },
    execution:
      input.execution ??
      (input.metadata._purrExecution as ExecutionRoutingRecord | undefined),
    tags: input.tags ?? [],
    installStrategies: [],
    resolutionProbe: [],
    runnerRecommendations: [],
    timeoutPolicy: input.timeoutPolicy,
  };
  jobs.set(job.jobId, job);
  runtime.set(job.jobId, {
    currentChild: null,
    backgroundChildren: [],
    jobTimer: null,
    cancelRequested: false,
    githubToken: input.githubToken ?? null,
    env: input.env ?? null,
    resolutionProbePackages: input.resolutionProbePackages ?? [],
    resolutionProbeModules: input.resolutionProbeModules ?? [],
  });
  schedulePersistence(job, true);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export async function getJobDurable(jobId: string): Promise<Job | undefined> {
  await loadPersisted();
  const cached = jobs.get(jobId);
  if (cached) return cached;
  try {
    const job = await (await getHistoryDatabase()).get(jobId);
    if (job) {
      cacheJob(job);
      trimOldJobs();
      return job;
    }
  } catch {
    // Fall through to legacy JSON.
  }
  try {
    const raw = await fs.readFile(path.join(jobsDir(), `${jobId}.json`), "utf8");
    const job = JSON.parse(raw) as Job;
    cacheJob(job);
    trimOldJobs();
    return job;
  } catch {
    return undefined;
  }
}

export function listJobs(limit = 50): Job[] {
  return Array.from(jobs.values())
    .sort((a, b) =>
      a.queuedAt === b.queuedAt
        ? b.jobId.localeCompare(a.jobId)
        : b.queuedAt.localeCompare(a.queuedAt)
    )
    .slice(0, limit);
}

export async function listHistorySummaries(
  query: HistoryQuery = {}
): Promise<HistoryPage<VerificationHistorySummary>> {
  await loadPersisted();
  return (await getHistoryDatabase()).listSummaries(query);
}

export async function listHistoryJobs(
  query: HistoryQuery = {}
): Promise<HistoryPage<Job>> {
  await loadPersisted();
  return (await getHistoryDatabase()).listFull(query);
}

export async function getLatestHistoryJob(
  query: Omit<HistoryQuery, "limit" | "cursor"> = {}
): Promise<Job | undefined> {
  await loadPersisted();
  return (await getHistoryDatabase()).latest(query).then((job) => job ?? undefined);
}

export function updateJob(jobId: string, patch: Partial<Job>): Job | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  Object.assign(job, patch);
  const immediate =
    isTerminalStatus(job.status) ||
    patch.status === "running" ||
    patch.cleanupStatus === "done" ||
    patch.cleanupStatus === "partial" ||
    patch.cleanupStatus === "failed";
  schedulePersistence(job, immediate);
  return job;
}

export function getRuntime(jobId: string): RuntimeState | undefined {
  return runtime.get(jobId);
}

export function setJobStatus(jobId: string, status: JobStatus): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  schedulePersistence(job, status === "running" || isTerminalStatus(status));
}

export function activeJobCount(): number {
  let count = 0;
  for (const job of jobs.values()) if (job.status === "running") count++;
  return count;
}

export function queuedJobCount(): number {
  let count = 0;
  for (const job of jobs.values()) if (job.status === "queued") count++;
  return count;
}

export function getQueuePosition(jobId: string): number | null {
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued") return null;
  const queued = Array.from(jobs.values())
    .filter((candidate) => candidate.status === "queued")
    .sort((a, b) =>
      a.queuedAt === b.queuedAt
        ? a.jobId.localeCompare(b.jobId)
        : a.queuedAt.localeCompare(b.queuedAt)
    );
  const index = queued.findIndex((candidate) => candidate.jobId === jobId);
  return index === -1 ? null : index + 1;
}

export function getQueuedTotal(): number {
  return queuedJobCount();
}

export function getAverageJobDurationMs(): number | null {
  let sum = 0;
  let count = 0;
  for (const job of jobs.values()) {
    if (isTerminalStatus(job.status) && typeof job.durationMs === "number") {
      sum += job.durationMs;
      count++;
    }
  }
  return count === 0 ? null : Math.round(sum / count);
}

export function totalJobCount(): number {
  return jobs.size;
}

export async function totalDurableJobCount(): Promise<number> {
  await loadPersisted();
  try {
    return await (await getHistoryDatabase()).count();
  } catch {
    return jobs.size;
  }
}

export async function verificationHistoryStatus(): Promise<
  HistoryBackendStatus & {
    pendingWrites: number;
    lastPersistenceError: string | null;
    fallback: "none" | "legacy-json";
    progressCheckpointMs: number;
  }
> {
  let status: HistoryBackendStatus;
  try {
    status = await historyBackendStatus();
  } catch (error) {
    status = {
      backend: "sqlite-wal",
      databasePath: path.join(getConfig().dataDir, "verify-history.sqlite"),
      ready: false,
      journalMode: null,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    ...status,
    pendingWrites: pendingPersistence.size + persistenceChains.size,
    lastPersistenceError:
      globalStore.__purrVerifyPersistenceError ?? status.lastError ?? null,
    fallback: globalStore.__purrVerifyPersistenceFallback ?? "none",
    progressCheckpointMs: PERSIST_DEBOUNCE_MS,
  };
}

export function clearRuntime(jobId: string): void {
  const state = runtime.get(jobId);
  if (!state) return;
  if (state.jobTimer) {
    clearTimeout(state.jobTimer);
    state.jobTimer = null;
  }
  state.currentChild = null;
  for (const child of state.backgroundChildren ?? []) {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  state.backgroundChildren = [];
  state.githubToken = null;
  state.env = null;
}

export function trimOldJobs(): void {
  const terminal = Array.from(jobs.values())
    .filter((job) => isTerminalStatus(job.status))
    .sort((a, b) =>
      a.queuedAt === b.queuedAt
        ? b.jobId.localeCompare(a.jobId)
        : b.queuedAt.localeCompare(a.queuedAt)
    );
  for (const job of terminal.slice(MAX_MEMORY_TERMINAL_JOBS)) {
    jobs.delete(job.jobId);
    runtime.delete(job.jobId);
  }
}

export async function deleteJob(jobId: string): Promise<boolean> {
  const job = await getJobDurable(jobId);
  if (!job) return false;
  if (job.status === "running" || job.status === "queued") return false;
  jobs.delete(jobId);
  runtime.delete(jobId);
  pendingPersistence.delete(jobId);
  const timer = persistenceTimers.get(jobId);
  if (timer) clearTimeout(timer);
  persistenceTimers.delete(jobId);
  await (await getHistoryDatabase()).delete(jobId).catch(() => false);
  await fs.unlink(path.join(jobsDir(), `${jobId}.json`)).catch(() => {});
  return true;
}

export async function deleteAllFinishedJobs(): Promise<number> {
  await loadPersisted();
  let memoryDeleted = 0;
  for (const [jobId, job] of Array.from(jobs.entries())) {
    if (job.status === "running" || job.status === "queued") continue;
    jobs.delete(jobId);
    runtime.delete(jobId);
    pendingPersistence.delete(jobId);
    const timer = persistenceTimers.get(jobId);
    if (timer) clearTimeout(timer);
    persistenceTimers.delete(jobId);
    memoryDeleted++;
  }
  const databaseDeleted = await (await getHistoryDatabase()).deleteFinished().catch(() => 0);
  const files = await fs.readdir(jobsDir()).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(jobsDir(), file), "utf8");
      const job = JSON.parse(raw) as Job;
      if (job.status !== "running" && job.status !== "queued") {
        await fs.unlink(path.join(jobsDir(), file)).catch(() => {});
      }
    } catch {
      // Leave corrupt legacy files for manual recovery.
    }
  }
  return Math.max(memoryDeleted, databaseDeleted);
}
