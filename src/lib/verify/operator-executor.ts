import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { MAX_LONG_RUN_TIMEOUT_MS, getConfig } from "./config";
import {
  createJob,
  flushJobPersistence,
  getJob,
  getRuntime,
  listJobs,
  loadPersisted,
  setJobStatus,
  trimOldJobs,
  updateJob,
} from "./store";
import type { CommandResult, Job, JobStatus } from "./types";
import type {
  OperatorEnqueueInput,
  OperatorOperationRecord,
  OperatorStep,
  OperatorStepResult,
} from "./operator-operation-types";
import {
  acquireProjectLock,
  createDeploymentSnapshot,
  deployGitRevision,
  restartService,
  rollbackDeploymentSnapshot,
  runHealthCheck,
  runOperatorCommand,
} from "./operator-runtime";

let operatorSchedulerRunning = false;

function nowIso(): string {
  return new Date().toISOString();
}

export function operatorOperation(job: Job): OperatorOperationRecord | null {
  const raw = job.metadata?._purrOperatorOperation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const operation = raw as Partial<OperatorOperationRecord>;
  if (
    operation.version !== 1 ||
    typeof operation.kind !== "string" ||
    typeof operation.cwd !== "string" ||
    !Array.isArray(operation.steps)
  ) {
    return null;
  }
  return operation as OperatorOperationRecord;
}

export function isOperatorJob(job: Job): boolean {
  return operatorOperation(job) !== null;
}

function stepLabel(step: OperatorStep): string {
  return step.label || step.type;
}

function updateOperatorCommand(jobId: string, index: number, patch: Partial<CommandResult>): void {
  const job = getJob(jobId);
  const command = job?.commands[index];
  if (!job || !command) return;
  Object.assign(command, patch);
  updateJob(jobId, { commands: [...job.commands] });
}

function finishOperatorJob(
  jobId: string,
  status: JobStatus,
  error: string | null,
  failedCommand: string | null = null
): void {
  const job = getJob(jobId);
  if (!job || job.finishedAt) return;
  const finishedAt = nowIso();
  const startMs = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
  for (const command of job.commands) {
    if (command.status === "pending" || command.status === "running") {
      command.status = "skipped";
    }
  }
  updateJob(jobId, {
    status,
    finishedAt,
    durationMs: Math.max(0, Date.now() - startMs),
    error,
    commands: [...job.commands],
    summary: {
      passed: status === "success",
      failedCommand:
        failedCommand ??
        job.commands.find((command) => command.status === "failed" || command.status === "timeout")
          ?.command ??
        null,
    },
  });
}

function killRuntimeChild(child: ChildProcess | null | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back below.
  }
  try {
    child.kill(signal);
  } catch {
    // Child may already have exited.
  }
}

async function executeStep(
  jobId: string,
  step: OperatorStep,
  commandIndex: number,
  runtimeEnv: Record<string, string>,
  commandTimeoutMs: number
): Promise<OperatorStepResult> {
  const runtime = getRuntime(jobId);
  if (step.type === "command") {
    return runOperatorCommand(step, runtimeEnv, commandTimeoutMs, {
      onChild: (child) => {
        const current = getRuntime(jobId);
        if (current) current.currentChild = child;
      },
      onProgress: (stdout, stderr, truncated) => {
        updateOperatorCommand(jobId, commandIndex, { stdout, stderr, truncated });
      },
    });
  }
  if (step.type === "snapshot") {
    const snapshot = await createDeploymentSnapshot(step.cwd, {
      reason: step.reason,
      plan: step.plan,
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify(snapshot, null, 2),
      stderr: "",
      truncated: false,
      timedOut: false,
      snapshotId: snapshot.snapshotId,
    };
  }
  if (step.type === "git_deploy") return deployGitRevision(step);
  if (step.type === "restart") return restartService(step);
  if (step.type === "health") return runHealthCheck(step.check, step.cwd);
  if (step.type === "rollback") {
    const rolledBack = await rollbackDeploymentSnapshot(step.snapshotId, step.cwd);
    if (!rolledBack.ok) return rolledBack;
    const output = [rolledBack.stdout];
    if (step.restart) {
      const restarted = await restartService(step.restart);
      output.push(restarted.stdout || restarted.stderr);
      if (!restarted.ok) return { ...restarted, stdout: output.join("\n") };
    }
    for (const check of step.healthChecks ?? []) {
      const health = await runHealthCheck(check, step.cwd);
      output.push(health.stdout || health.stderr);
      if (!health.ok) return { ...health, stdout: output.join("\n") };
    }
    return { ...rolledBack, stdout: output.filter(Boolean).join("\n") };
  }
  runtime?.currentChild?.kill();
  return {
    ok: false,
    exitCode: 2,
    stdout: "",
    stderr: `unsupported operator step: ${(step as { type?: string }).type ?? "unknown"}`,
    truncated: false,
    timedOut: false,
  };
}

async function rollbackAfterFailure(
  jobId: string,
  operation: OperatorOperationRecord,
  snapshotId: string
): Promise<Record<string, unknown>> {
  const result = await rollbackDeploymentSnapshot(snapshotId, operation.cwd);
  const evidence: Record<string, unknown> = {
    attempted: true,
    snapshotId,
    rollback: result,
    restart: null,
    health: [],
  };
  if (!result.ok) return evidence;
  if (operation.restartAfterRollback) {
    const restarted = await restartService(operation.restartAfterRollback);
    evidence.restart = restarted;
  }
  const healthResults: OperatorStepResult[] = [];
  for (const check of operation.healthAfterRollback ?? []) {
    healthResults.push(await runHealthCheck(check, operation.cwd));
  }
  evidence.health = healthResults;
  return evidence;
}

async function runOperatorJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  const operation = job ? operatorOperation(job) : null;
  const runtime = getRuntime(jobId);
  if (!job || !operation || !runtime) return;
  const cfg = getConfig();
  const timeoutPolicy = job.timeoutPolicy ?? {
    longRun: false,
    commandTimeoutMs: cfg.commandTimeoutMs,
    jobTimeoutMs: cfg.jobTimeoutMs,
    maxLongRunTimeoutMs: MAX_LONG_RUN_TIMEOUT_MS,
  };
  const startedAt = nowIso();
  updateJob(jobId, { status: "running", startedAt });
  const runtimeEnv = runtime.env ?? {};
  let timedOut = false;
  let snapshotId = operation.snapshotId;
  let releaseLock: (() => Promise<void>) | null = null;

  runtime.jobTimer = setTimeout(() => {
    timedOut = true;
    runtime.cancelRequested = true;
    killRuntimeChild(runtime.currentChild, "SIGTERM");
    for (const child of runtime.backgroundChildren ?? []) killRuntimeChild(child, "SIGTERM");
    setTimeout(() => {
      killRuntimeChild(runtime.currentChild, "SIGKILL");
      for (const child of runtime.backgroundChildren ?? []) killRuntimeChild(child, "SIGKILL");
    }, 3_000).unref?.();
  }, timeoutPolicy.jobTimeoutMs);

  try {
    if (operation.lockProject) {
      releaseLock = await acquireProjectLock(
        operation.cwd,
        jobId,
        timeoutPolicy.jobTimeoutMs,
        () => runtime.cancelRequested === true
      );
    }

    for (let index = 0; index < operation.steps.length; index++) {
      const step = operation.steps[index];
      if (runtime.cancelRequested) {
        finishOperatorJob(
          jobId,
          timedOut ? "timeout" : "canceled",
          timedOut ? "operator job exceeded total timeout" : "operator job canceled"
        );
        return;
      }
      const commandStartedAt = nowIso();
      const commandStartMs = Date.now();
      updateOperatorCommand(jobId, index, { status: "running", startedAt: commandStartedAt });
      let result: OperatorStepResult;
      try {
        result = await executeStep(
          jobId,
          step,
          index,
          runtimeEnv,
          timeoutPolicy.commandTimeoutMs
        );
      } catch (error) {
        result = {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: (error as Error).message,
          truncated: false,
          timedOut: false,
        };
      }
      if (result.snapshotId) {
        snapshotId = result.snapshotId;
        operation.snapshotId = snapshotId;
        updateJob(jobId, {
          metadata: {
            ...job.metadata,
            _purrOperatorOperation: operation,
            snapshotId,
          },
        });
      }
      if (result.actualHead) updateJob(jobId, { actual_head: result.actualHead });
      updateOperatorCommand(jobId, index, {
        status: result.timedOut ? "timeout" : result.ok ? "success" : "failed",
        exitCode: result.exitCode,
        durationMs: Date.now() - commandStartMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        finishedAt: nowIso(),
        effectiveCommand: stepLabel(step),
      });
      runtime.currentChild = null;

      if (!result.ok) {
        let rollbackEvidence: Record<string, unknown> | null = null;
        if (operation.rollbackOnFailure && snapshotId) {
          rollbackEvidence = await rollbackAfterFailure(jobId, operation, snapshotId);
          updateJob(jobId, {
            metadata: {
              ...job.metadata,
              _purrOperatorOperation: operation,
              snapshotId,
              rollbackEvidence,
            },
          });
        }
        finishOperatorJob(
          jobId,
          result.timedOut || timedOut ? "timeout" : "failed",
          [result.stderr || result.stdout || `operator step failed: ${stepLabel(step)}`,
            rollbackEvidence ? "automatic rollback attempted" : ""].filter(Boolean).join("; "),
          stepLabel(step)
        );
        return;
      }
    }
    finishOperatorJob(jobId, "success", null);
  } catch (error) {
    finishOperatorJob(
      jobId,
      timedOut ? "timeout" : runtime.cancelRequested ? "canceled" : "failed",
      (error as Error).message
    );
  } finally {
    if (runtime.jobTimer) clearTimeout(runtime.jobTimer);
    runtime.jobTimer = null;
    runtime.currentChild = null;
    runtime.env = null;
    await releaseLock?.().catch(() => {});
    await flushJobPersistence(jobId);
  }
}

async function drainOperatorQueue(): Promise<void> {
  const cfg = getConfig();
  const all = listJobs(Number.MAX_SAFE_INTEGER);
  const running = all.filter((job) => job.status === "running").length;
  const queued = all
    .filter((job) => job.status === "queued" && isOperatorJob(job))
    .sort((a, b) =>
      a.queuedAt === b.queuedAt
        ? a.jobId.localeCompare(b.jobId)
        : a.queuedAt.localeCompare(b.queuedAt)
    );
  let slots = cfg.maxConcurrentJobs - running;
  for (const job of queued) {
    if (slots <= 0) break;
    slots--;
    setJobStatus(job.jobId, "running");
    void runOperatorJob(job.jobId).catch((error) => {
      finishOperatorJob(job.jobId, "failed", `Unhandled operator error: ${error.message}`);
    });
  }
  trimOldJobs();
}

export async function ensureOperatorScheduler(): Promise<void> {
  await loadPersisted();
  if (operatorSchedulerRunning) return;
  operatorSchedulerRunning = true;
  const tick = () => {
    void drainOperatorQueue().finally(() => setTimeout(tick, 1_000));
  };
  tick();
}

export async function enqueueOperatorJob(input: OperatorEnqueueInput): Promise<Job> {
  await loadPersisted();
  const operation: OperatorOperationRecord = {
    version: 1,
    kind: input.kind,
    cwd: input.cwd,
    lockProject: input.lockProject !== false,
    steps: input.steps,
    rollbackOnFailure: input.rollbackOnFailure,
    restartAfterRollback: input.restartAfterRollback,
    healthAfterRollback: input.healthAfterRollback,
    plan: input.plan,
    createdAt: nowIso(),
  };
  const job = createJob({
    repo: `local/${path.basename(input.cwd) || "root"}`,
    ref: input.cwd,
    commands: input.steps.map(stepLabel),
    continue_on_error: false,
    metadata: {
      purpose: `private operator ${input.kind}`,
      _purrOperatorOperation: operation,
    },
    tags: input.tags ?? ["operator", input.kind],
    env: input.env,
    timeoutPolicy: input.timeoutPolicy,
    execution: {
      requestedMode: "async",
      effectiveMode: "async",
      routingReason: "local_operator_job",
      autoRouted: false,
    },
  });
  updateJob(job.jobId, {
    cleanupStatus: "skipped",
    cleanup: {
      status: "skipped",
      startedAt: null,
      finishedAt: null,
      workspaceRemoved: true,
      cacheRemoved: true,
    },
  });
  await flushJobPersistence(job.jobId);
  void ensureOperatorScheduler();
  return job;
}
