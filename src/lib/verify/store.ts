// In-memory job store with lightweight JSON file persistence.
//
// MVP note: state lives in module memory. Completed/failed jobs are also written
// to <dataDir>/jobs/<jobId>.json so they survive dev-server restarts. Running
// jobs that were interrupted by a restart cannot be resumed (they are marked
// "failed" with an interruption note on next startup).

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { getConfig } from "./config";
import type {
  ExecutionRoutingRecord,
  Job,
  JobStatus,
  ResolutionProbeModuleRequest,
} from "./types";

// Internal runtime tracking (not serialized).
interface RuntimeState {
  currentChild?: ChildProcess | null;
  backgroundChildren?: ChildProcess[];
  jobTimer?: NodeJS.Timeout | null;
  cancelRequested?: boolean;
  /**
   * Per-request GitHub clone token (github_passthrough mode). In-memory ONLY —
   * NEVER persisted to disk. When set, the executor uses it to clone private
   * repos via https://x-access-token:<token>@github.com/...; when undefined,
   * the executor falls back to env GITHUB_TOKEN. Cleared in clearRuntime.
   */
  githubToken?: string | null;
  /**
   * Per-job environment variables (first-class env injection). In-memory ONLY —
   * never persisted (values may contain secrets). The executor injects these
   * into each command's process env; redactText scrubs them from captured
   * logs. Cleared in clearRuntime.
   */
  env?: Record<string, string> | null;
  resolutionProbePackages?: string[];
  resolutionProbeModules?: ResolutionProbeModuleRequest[];
}

const jobs = new Map<string, Job>();
const runtime = new Map<string, RuntimeState>();

// Use globalThis so the flag survives HMR module re-evaluation in dev mode.
// Module-level `let loaded = false` would reset on every HMR update, causing
// every freshly-queued job to be incorrectly marked as "interrupted by server
// restart" when loadPersisted runs. globalThis persists across HMR but is
// reset on actual process restart (server start), which is exactly what we
// want.
interface PurrVerifyGlobal {
  __purrVerifyLoaded?: boolean;
}
function getPurrGlobal(): PurrVerifyGlobal {
  return globalThis as PurrVerifyGlobal;
}

let loaded = false;

const MAX_STORED_JOBS = 200;

function dataDir(): string {
  return getConfig().dataDir;
}

function jobsDir(): string {
  return path.join(dataDir(), "jobs");
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(jobsDir(), { recursive: true });
}

async function persist(job: Job): Promise<void> {
  try {
    await ensureDirs();
    const file = path.join(jobsDir(), `${job.jobId}.json`);
    await fs.writeFile(file, JSON.stringify(job, null, 2), "utf8");
  } catch {
    // Persistence is best-effort; never let it break the API.
  }
}

export async function loadPersisted(): Promise<void> {
  // Always re-read from disk to pick up new/changed/deleted jobs.
  // This is important for dev-mode HMR resilience.
  // CRITICAL: only mark interrupted jobs on the FIRST load (server startup
  // or after a real process restart). On subsequent loads (including HMR
  // re-evaluations), the in-memory store is the source of truth for
  // running/queued jobs — marking them as failed here would race with the
  // executor and kill freshly-created jobs.
  // We use globalThis to persist the "loaded" flag across HMR re-evaluations.
  const g = getPurrGlobal();
  const isFirstLoad = !g.__purrVerifyLoaded;
  g.__purrVerifyLoaded = true;
  loaded = true;
  try {
    const dir = jobsDir();
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const recent = files.filter((f) => f.endsWith(".json")).slice(-MAX_STORED_JOBS);
    // Build a set of job IDs that exist on disk.
    const diskIds = new Set(recent.map((f) => f.replace(/\.json$/, "")));
    // Remove any in-memory jobs whose files no longer exist.
    // CRITICAL: Never delete "running" or "queued" jobs even if they're not
    // on disk yet — a newly created job (via createJob) writes to disk
    // asynchronously (`void persist(job)`), so there's a window where the
    // job exists in memory but not on disk. If another route calls
    // loadPersisted() during this window and deletes the job, the executor
    // will fail to find it. This is especially important for sync mode,
    // where runJobSync creates a job and immediately tries to run it.
    for (const id of jobs.keys()) {
      const j = jobs.get(id);
      const isActive = j && (j.status === "running" || j.status === "queued");
      if (!diskIds.has(id) && !isActive) {
        jobs.delete(id);
        runtime.delete(id);
      }
    }
    for (const f of recent) {
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const job = JSON.parse(raw) as Job;
        // Only mark interrupted running/queued jobs as failed on the first
        // load (server startup). After that, the in-memory store may be
        // actively running these jobs, so we must not touch their status.
        if (isFirstLoad && (job.status === "running" || job.status === "queued")) {
          job.status = "failed";
          job.error = "Job was interrupted by server restart";
          job.finishedAt = job.finishedAt || new Date().toISOString();
          // Also mark any still-pending commands as skipped so the UI shows
          // them as never-run rather than stuck-pending.
          for (const c of job.commands) {
            if (c.status === "pending" || c.status === "running") {
              c.status = "skipped";
            }
          }
          // Persist the updated state so future loads are consistent.
          void persist(job);
        }
        // Skip only if the in-memory copy is fully equivalent to disk.
        // Comparing finishedAt + durationMs + status + command count catches
        // cases where commands were updated but top-level status didn't change.
        // We also compare webhookDeliveries.length + tags length so that
        // cross-route-module updates (e.g., a webhook retry fired from the
        // /api/verify/[jobId]/webhook/retry route, which has its own copy of
        // the store in dev mode) are visible to other routes on their next
        // loadPersisted() call.
        const existing = jobs.get(job.jobId);
        const existingDeliveries = existing?.webhookDeliveries?.length ?? 0;
        const diskDeliveries = job.webhookDeliveries?.length ?? 0;
        const existingTags = existing?.tags?.length ?? 0;
        const diskTags = job.tags?.length ?? 0;
        const existingAnnotations = existing?.annotations?.length ?? 0;
        const diskAnnotations = job.annotations?.length ?? 0;
        if (
          existing &&
          existing.status === job.status &&
          existing.finishedAt === job.finishedAt &&
          existing.durationMs === job.durationMs &&
          existing.commands.length === job.commands.length &&
          existing.commands.every((c, i) => c.status === job.commands[i].status) &&
          existingDeliveries === diskDeliveries &&
          existingTags === diskTags &&
          existingAnnotations === diskAnnotations
        ) {
          continue;
        }
        jobs.set(job.jobId, job);
        if (!runtime.has(job.jobId)) {
          // Restored jobs have no transient githubToken (we never persist it);
          // they fall back to env GITHUB_TOKEN if re-cloned (rare — restored
          // jobs are already terminal).
          runtime.set(job.jobId, {
            currentChild: null,
            jobTimer: null,
            cancelRequested: false,
            githubToken: null,
            env: null,
            resolutionProbePackages: [],
          });
        }
      } catch {
        // skip corrupt file
      }
    }
  } catch {
    // ignore
  }
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
  /**
   * Transient per-request GitHub clone token (github_passthrough mode).
   * Stored in the in-memory runtime ONLY — never written to the persisted
   * Job JSON. The executor reads it via getRuntime(jobId).githubToken.
   */
  githubToken?: string;
  /**
   * Transient per-job environment variables. Stored in the in-memory runtime
   * ONLY — never written to the persisted Job JSON.
   */
  env?: Record<string, string>;
  resolutionProbePackages?: string[];
  resolutionProbeModules?: ResolutionProbeModuleRequest[];
  timeoutPolicy?: Job["timeoutPolicy"];
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
    tags: input.tags ?? [],
    installStrategies: [],
    resolutionProbe: [],
    runnerRecommendations: [],
    timeoutPolicy: input.timeoutPolicy,
  };
  jobs.set(job.jobId, job);
  // githubToken and env live ONLY in memory — they are deliberately NOT on the
  // Job object, so persist(job) below can never write them to disk.
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
  void persist(job);
  return job;
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function listJobs(limit = 50): Job[] {
  return Array.from(jobs.values())
    .sort((a, b) => (b.queuedAt > a.queuedAt ? 1 : -1))
    .slice(0, limit);
}

export function updateJob(jobId: string, patch: Partial<Job>): Job | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  Object.assign(job, patch);
  void persist(job);
  return job;
}

export function getRuntime(jobId: string): RuntimeState | undefined {
  return runtime.get(jobId);
}

export function setJobStatus(jobId: string, status: JobStatus): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = status;
  void persist(job);
}

export function activeJobCount(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status === "running") n++;
  }
  return n;
}

export function queuedJobCount(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status === "queued") n++;
  }
  return n;
}

// Returns the 1-based position of the job among currently queued jobs (sorted
// by queuedAt ascending — i.e. FIFO order). Returns null if the job is not
// queued (or doesn't exist).
export function getQueuePosition(jobId: string): number | null {
  const job = jobs.get(jobId);
  if (!job || job.status !== "queued") return null;
  const queued = Array.from(jobs.values())
    .filter((j) => j.status === "queued")
    .sort((a, b) => (a.queuedAt > b.queuedAt ? 1 : a.queuedAt < b.queuedAt ? -1 : 0));
  const idx = queued.findIndex((j) => j.jobId === jobId);
  return idx === -1 ? null : idx + 1;
}

// Returns the total count of currently queued jobs.
export function getQueuedTotal(): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status === "queued") n++;
  }
  return n;
}

// Returns the average durationMs across all finished jobs (success/failed/
// canceled/timeout) that have a non-null durationMs. Returns null if there
// is no history.
export function getAverageJobDurationMs(): number | null {
  let sum = 0;
  let count = 0;
  for (const j of jobs.values()) {
    if (
      (j.status === "success" ||
        j.status === "failed" ||
        j.status === "canceled" ||
        j.status === "timeout") &&
      typeof j.durationMs === "number"
    ) {
      sum += j.durationMs;
      count++;
    }
  }
  return count === 0 ? null : Math.round(sum / count);
}

export function totalJobCount(): number {
  return jobs.size;
}

export function clearRuntime(jobId: string): void {
  const rt = runtime.get(jobId);
  if (!rt) return;
  if (rt?.jobTimer) {
    clearTimeout(rt.jobTimer);
    rt.jobTimer = null;
  }
  rt.currentChild = null;
  for (const child of rt.backgroundChildren ?? []) {
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
  rt.backgroundChildren = [];
  // Drop the transient GitHub token so it isn't held in memory after the job
  // finishes. (The token was only needed for cloning, which is done by now.)
  if (rt) rt.githubToken = null;
  // Drop per-job env (may contain secrets) once the job is finished.
  if (rt) rt.env = null;
}

// Periodically trim very old finished jobs from memory.
export function trimOldJobs(): void {
  if (jobs.size <= MAX_STORED_JOBS) return;
  const sorted = Array.from(jobs.values()).sort((a, b) =>
    a.queuedAt > b.queuedAt ? 1 : -1
  );
  const toRemove = sorted.slice(0, jobs.size - MAX_STORED_JOBS);
  for (const j of toRemove) {
    jobs.delete(j.jobId);
    runtime.delete(j.jobId);
  }
}

// Delete a single job by ID (only if not running/queued).
export async function deleteJob(jobId: string): Promise<boolean> {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status === "running" || job.status === "queued") return false;
  jobs.delete(jobId);
  runtime.delete(jobId);
  try {
    const file = path.join(jobsDir(), `${jobId}.json`);
    await fs.unlink(file).catch(() => {});
  } catch {
    // best-effort
  }
  return true;
}

// Delete all finished jobs (not running/queued). Returns count deleted.
export async function deleteAllFinishedJobs(): Promise<number> {
  let count = 0;
  const toDelete: string[] = [];
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.status !== "queued") {
      toDelete.push(id);
    }
  }
  for (const id of toDelete) {
    jobs.delete(id);
    runtime.delete(id);
    count++;
    try {
      const file = path.join(jobsDir(), `${id}.json`);
      await fs.unlink(file).catch(() => {});
    } catch {
      // best-effort
    }
  }
  return count;
}
