import { MAX_LONG_RUN_TIMEOUT_MS, getConfig } from "./config";
import { requestCancel } from "./executor";
import { getJobDurable } from "./store";
import { canonicalDirectory, inspectProject, planDeployment } from "./operator-inspection";
import { enqueueOperatorJob } from "./operator-executor";
import { classifyDestructiveCommand } from "./operator-runtime";
import type {
  DirtyStrategy,
  OperatorCommandStep,
  OperatorHealthCheck,
  OperatorRestartStep,
  OperatorStep,
  ServiceManager,
} from "./operator-operation-types";

export interface OperatorMutationToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

export interface OperatorMutationToolResult {
  handled: boolean;
  payload?: unknown;
  isError?: boolean;
}

const CWD = {
  type: "string",
  description: "Absolute local project cwd. Symlinks are resolved to a canonical project identity.",
};
const ASYNC_NOTE =
  "Returns a durable asynchronous job immediately. Use purr_get_job_status, purr_get_job_logs, or purr_cancel_job.";

export const OPERATOR_MUTATION_MCP_TOOLS: OperatorMutationToolDefinition[] = [
  {
    name: "purr_run_command",
    description:
      `Run a generic private command directly in a local VPS project. argv is preferred; command requires shell=true. ${ASYNC_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        argv: { type: "array", items: { type: "string" } },
        command: { type: "string" },
        shell: { type: "boolean", default: false },
        timeoutMs: { type: "number" },
        jobTimeoutMs: { type: "number" },
        longRun: { type: "boolean", default: false },
        environmentOverrides: { type: "object", additionalProperties: { type: "string" } },
        background: { type: "boolean", default: false },
        expectedExitCodes: { type: "array", items: { type: "number" }, default: [0] },
        lockProject: { type: "boolean", default: true },
        confirmDestructive: {
          type: "boolean",
          default: false,
          description: "Explicit one-call confirmation for commands classified as destructive.",
        },
      },
      required: ["cwd"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "purr_verify_project",
    description:
      `Run install, verify, and optional build commands directly against the exact local working tree instead of cloning a disposable workspace. ${ASYNC_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        install: { type: "boolean", default: true },
        verifyCommands: { type: "array", items: { type: "string" } },
        build: { type: "boolean", default: false },
        buildCommands: { type: "array", items: { type: "string" } },
        environmentOverrides: { type: "object", additionalProperties: { type: "string" } },
        commandTimeoutMs: { type: "number" },
        jobTimeoutMs: { type: "number" },
        longRun: { type: "boolean", default: false },
      },
      required: ["cwd"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "purr_create_deploy_snapshot",
    description:
      `Create a persistent pre-deploy snapshot containing Git HEAD, dirty patches, untracked files, project config, environment key inventory, and detected service state. ${ASYNC_NOTE}`,
    inputSchema: {
      type: "object",
      properties: { cwd: CWD, reason: { type: "string" } },
      required: ["cwd"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "purr_deploy_project",
    description:
      `Deploy an exact local project through snapshot, Git activation, install, verify, build, restart, health checks, and automatic rollback. One approved=true covers the complete planned lifecycle. ${ASYNC_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        approved: { type: "boolean", description: "Approve the complete deploy lifecycle once." },
        targetRef: { type: "string" },
        expectedHead: { type: "string" },
        dirtyStrategy: {
          type: "string",
          enum: ["reject", "stash", "preserve", "discard"],
          default: "reject",
        },
        installCommands: { type: "array", items: { type: "string" } },
        skipInstall: { type: "boolean", default: false },
        verifyCommands: { type: "array", items: { type: "string" } },
        buildCommands: { type: "array", items: { type: "string" } },
        serviceManager: {
          type: "string",
          enum: ["auto", "pm2", "systemd", "docker_compose", "custom"],
          default: "auto",
        },
        serviceName: { type: "string" },
        composeFile: { type: "string" },
        customRestartArgv: { type: "array", items: { type: "string" } },
        healthChecks: { type: "array", items: { type: "object" } },
        rollbackOnFailure: { type: "boolean", default: true },
        environmentOverrides: { type: "object", additionalProperties: { type: "string" } },
        commandTimeoutMs: { type: "number" },
        jobTimeoutMs: { type: "number" },
        longRun: { type: "boolean", default: false },
      },
      required: ["cwd", "approved"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "purr_restart_service",
    description:
      `Restart or reload a PM2, systemd, Docker Compose, or custom service associated with a local project. ${ASYNC_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        manager: {
          type: "string",
          enum: ["auto", "pm2", "systemd", "docker_compose", "custom"],
          default: "auto",
        },
        serviceName: { type: "string" },
        composeFile: { type: "string" },
        action: { type: "string", enum: ["restart", "reload", "up"], default: "restart" },
        customArgv: { type: "array", items: { type: "string" } },
      },
      required: ["cwd"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "purr_check_health",
    description:
      `Run HTTP, TCP, process, PM2, systemd, Docker, JSON-RPC, or custom command health checks as a durable job. ${ASYNC_NOTE}`,
    inputSchema: {
      type: "object",
      properties: { cwd: CWD, checks: { type: "array", items: { type: "object" } } },
      required: ["cwd", "checks"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "purr_rollback_deployment",
    description:
      `Restore a persistent deployment snapshot, optionally restart the service, and run health checks. ${ASYNC_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD,
        snapshotId: { type: "string" },
        approved: { type: "boolean" },
        manager: {
          type: "string",
          enum: ["auto", "pm2", "systemd", "docker_compose", "custom"],
          default: "auto",
        },
        serviceName: { type: "string" },
        composeFile: { type: "string" },
        customRestartArgv: { type: "array", items: { type: "string" } },
        healthChecks: { type: "array", items: { type: "object" } },
      },
      required: ["cwd", "snapshotId", "approved"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: "purr_get_job_status",
    description: "Get the full durable status of any verification or private operator job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "purr_get_job_logs",
    description: "Read bounded stdout/stderr chunks from a durable verification or operator job.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        commandIndex: { type: "number" },
        stream: { type: "string", enum: ["stdout", "stderr", "both"], default: "both" },
        offset: { type: "number", default: 0 },
        limit: { type: "number", default: 20000 },
      },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "purr_cancel_job",
    description: "Cancel a running or queued verification/operator job and terminate its active process tree.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

function valueString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry))
    .filter((entry) => entry >= 0 && entry <= 255);
  return out.length ? Array.from(new Set(out)) : undefined;
}

function error(message: string, extra: Record<string, unknown> = {}): OperatorMutationToolResult {
  return {
    handled: true,
    isError: true,
    payload: { error: "validation_failed", message, ...extra },
  };
}

function validateEnvironment(value: unknown): { ok: true; env: Record<string, string> } | { ok: false; message: string } {
  if (value == null) return { ok: true, env: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "environmentOverrides must be an object of string values" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 50) return { ok: false, message: "environmentOverrides supports max 50 keys" };
  const reserved = new Set([
    "PATH",
    "NODE_PATH",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
  ]);
  const env: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, message: `invalid environment key: ${key}` };
    if (reserved.has(key.toUpperCase())) return { ok: false, message: `environment key is reserved: ${key}` };
    if (typeof raw !== "string") return { ok: false, message: `environment value for ${key} must be a string` };
    if (raw.length > 16_384) return { ok: false, message: `environment value for ${key} is too long` };
    env[key] = raw;
  }
  return { ok: true, env };
}

function timeoutPolicy(args: Record<string, unknown>, commandCount: number) {
  const cfg = getConfig();
  const longRun = args.longRun === true;
  const commandRequested = Number(args.commandTimeoutMs ?? args.timeoutMs ?? cfg.commandTimeoutMs);
  const commandTimeoutMs = Number.isFinite(commandRequested) && commandRequested > 0
    ? Math.floor(commandRequested)
    : cfg.commandTimeoutMs;
  const defaultJob = Math.max(cfg.jobTimeoutMs, commandTimeoutMs * Math.max(1, commandCount));
  const jobRequested = Number(args.jobTimeoutMs ?? defaultJob);
  const jobTimeoutMs = Number.isFinite(jobRequested) && jobRequested > 0
    ? Math.floor(jobRequested)
    : defaultJob;
  if (!longRun && (commandTimeoutMs > cfg.jobTimeoutMs || jobTimeoutMs > cfg.jobTimeoutMs)) {
    return { ok: false as const, message: "timeouts above normal JOB_TIMEOUT_MS require longRun=true" };
  }
  if (commandTimeoutMs > MAX_LONG_RUN_TIMEOUT_MS || jobTimeoutMs > MAX_LONG_RUN_TIMEOUT_MS) {
    return { ok: false as const, message: `timeout exceeds max ${MAX_LONG_RUN_TIMEOUT_MS} ms` };
  }
  if (commandTimeoutMs > jobTimeoutMs) {
    return { ok: false as const, message: "command timeout cannot exceed job timeout" };
  }
  return {
    ok: true as const,
    policy: {
      longRun,
      commandTimeoutMs,
      jobTimeoutMs,
      maxLongRunTimeoutMs: MAX_LONG_RUN_TIMEOUT_MS,
    },
  };
}

function parseHealthChecks(value: unknown): OperatorHealthCheck[] | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set(["http", "tcp", "process", "pm2", "systemd", "docker", "json_rpc", "custom"]);
  const checks: OperatorHealthCheck[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const check = entry as OperatorHealthCheck;
    if (!allowed.has(String(check.type))) return null;
    checks.push(check);
  }
  return checks;
}

function commandSteps(cwd: string, commands: string[], prefix: string): OperatorCommandStep[] {
  return commands.map((command, index) => ({
    type: "command",
    label: `${prefix} ${index + 1}: ${command}`,
    cwd,
    command,
    shell: true,
    expectedExitCodes: [0],
  }));
}

function restartInput(args: Record<string, unknown>, cwd: string, action: "restart" | "reload" | "up" = "restart"): OperatorRestartStep {
  return {
    type: "restart",
    label: `restart service (${valueString(args.serviceName) ?? "auto"})`,
    cwd,
    manager: (valueString(args.serviceManager ?? args.manager) ?? "auto") as ServiceManager,
    serviceName: valueString(args.serviceName),
    composeFile: valueString(args.composeFile),
    action,
    customArgv: stringArray(args.customRestartArgv ?? args.customArgv),
  };
}

function queued(job: { jobId: string; status: string; ref: string }, extra: Record<string, unknown> = {}) {
  return {
    jobId: job.jobId,
    status: job.status,
    cwd: job.ref,
    statusTool: "purr_get_job_status",
    logsTool: "purr_get_job_logs",
    cancelTool: "purr_cancel_job",
    ...extra,
  };
}

export async function handleOperatorMutationMcpTool(
  name: string | undefined,
  args: Record<string, unknown>
): Promise<OperatorMutationToolResult> {
  try {
    if (name === "purr_get_job_status") {
      const jobId = valueString(args.jobId);
      if (!jobId) return error("jobId is required");
      const job = await getJobDurable(jobId);
      return job
        ? { handled: true, payload: job }
        : { handled: true, isError: true, payload: { error: "not_found", message: `Job not found: ${jobId}` } };
    }
    if (name === "purr_get_job_logs") {
      const jobId = valueString(args.jobId);
      if (!jobId) return error("jobId is required");
      const job = await getJobDurable(jobId);
      if (!job) return { handled: true, isError: true, payload: { error: "not_found", message: `Job not found: ${jobId}` } };
      const index = Number.isInteger(args.commandIndex) ? Number(args.commandIndex) : undefined;
      const selected = index === undefined ? job.commands : job.commands[index] ? [job.commands[index]] : [];
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const limit = Math.max(1, Math.min(100_000, Math.floor(Number(args.limit) || 20_000)));
      const stream = valueString(args.stream) ?? "both";
      return {
        handled: true,
        payload: {
          jobId,
          status: job.status,
          offset,
          limit,
          commands: selected.map((command, selectedIndex) => ({
            commandIndex: index ?? selectedIndex,
            command: command.command,
            status: command.status,
            stdout: stream === "stderr" ? undefined : command.stdout.slice(offset, offset + limit),
            stderr: stream === "stdout" ? undefined : command.stderr.slice(offset, offset + limit),
            stdoutLength: command.stdout.length,
            stderrLength: command.stderr.length,
          })),
        },
      };
    }
    if (name === "purr_cancel_job") {
      const jobId = valueString(args.jobId);
      if (!jobId) return error("jobId is required");
      const canceled = requestCancel(jobId);
      return { handled: true, payload: { jobId, canceled } };
    }

    const requiresCwd = new Set([
      "purr_run_command",
      "purr_verify_project",
      "purr_create_deploy_snapshot",
      "purr_deploy_project",
      "purr_restart_service",
      "purr_check_health",
      "purr_rollback_deployment",
    ]);
    if (!requiresCwd.has(name ?? "")) return { handled: false };
    const requestedCwd = valueString(args.cwd);
    if (!requestedCwd) return error("cwd is required");
    const cwd = (await canonicalDirectory(requestedCwd)).canonicalPath;
    const envResult = validateEnvironment(args.environmentOverrides);
    if (!envResult.ok) return error(envResult.message);

    if (name === "purr_run_command") {
      const argv = stringArray(args.argv);
      const command = valueString(args.command);
      const shell = args.shell === true;
      if (!argv?.length && !(command && shell)) {
        return error("provide argv, or provide command with shell=true");
      }
      const display = argv?.join(" ") ?? command ?? "";
      const destructive = classifyDestructiveCommand(display);
      if (destructive && args.confirmDestructive !== true) {
        return error("destructive command requires confirmDestructive=true", {
          classification: destructive,
          command: display,
        });
      }
      const policy = timeoutPolicy(args, 1);
      if (!policy.ok) return error(policy.message);
      const job = await enqueueOperatorJob({
        kind: "command",
        cwd,
        lockProject: args.lockProject !== false,
        env: envResult.env,
        timeoutPolicy: policy.policy,
        steps: [
          {
            type: "command",
            label: display,
            cwd,
            argv,
            command,
            shell,
            timeoutMs: Number(args.timeoutMs) || undefined,
            expectedExitCodes: numberArray(args.expectedExitCodes) ?? [0],
            background: args.background === true,
          },
        ],
      });
      return { handled: true, payload: queued(job, { destructiveClassification: destructive }) };
    }

    if (name === "purr_verify_project") {
      const project = await inspectProject(cwd);
      const commands = [
        ...(args.install === false ? [] : project.suggestedCommands.install),
        ...(stringArray(args.verifyCommands) ?? project.suggestedCommands.verify),
        ...(args.build === true ? stringArray(args.buildCommands) ?? project.suggestedCommands.build : []),
      ];
      if (!commands.length) return error("no install, verify, or build commands were discovered or supplied");
      const policy = timeoutPolicy(args, commands.length);
      if (!policy.ok) return error(policy.message);
      const job = await enqueueOperatorJob({
        kind: "local_verify",
        cwd,
        env: envResult.env,
        timeoutPolicy: policy.policy,
        steps: commandSteps(cwd, commands, "local verify"),
      });
      return { handled: true, payload: queued(job, { commands }) };
    }

    if (name === "purr_create_deploy_snapshot") {
      const policy = timeoutPolicy({ ...args, longRun: false }, 1);
      if (!policy.ok) return error(policy.message);
      const job = await enqueueOperatorJob({
        kind: "snapshot",
        cwd,
        timeoutPolicy: policy.policy,
        steps: [
          {
            type: "snapshot",
            label: "create deployment snapshot",
            cwd,
            reason: valueString(args.reason),
          },
        ],
      });
      return { handled: true, payload: queued(job) };
    }

    if (name === "purr_restart_service") {
      const restart = restartInput(args, cwd, (valueString(args.action) ?? "restart") as "restart" | "reload" | "up");
      const policy = timeoutPolicy(args, 1);
      if (!policy.ok) return error(policy.message);
      const job = await enqueueOperatorJob({
        kind: "restart",
        cwd,
        timeoutPolicy: policy.policy,
        steps: [restart],
      });
      return { handled: true, payload: queued(job) };
    }

    if (name === "purr_check_health") {
      const checks = parseHealthChecks(args.checks);
      if (!checks?.length) return error("checks must contain at least one supported health check");
      const policy = timeoutPolicy(args, checks.length);
      if (!policy.ok) return error(policy.message);
      const job = await enqueueOperatorJob({
        kind: "health_check",
        cwd,
        lockProject: false,
        timeoutPolicy: policy.policy,
        steps: checks.map((check, index) => ({
          type: "health",
          label: `health ${index + 1}: ${check.name ?? check.type}`,
          cwd,
          check,
        })),
      });
      return { handled: true, payload: queued(job) };
    }

    if (name === "purr_rollback_deployment") {
      if (args.approved !== true) return error("rollback requires approved=true");
      const snapshotId = valueString(args.snapshotId);
      if (!snapshotId) return error("snapshotId is required");
      const checks = parseHealthChecks(args.healthChecks) ?? [];
      const restart = restartInput(args, cwd);
      const policy = timeoutPolicy({ ...args, longRun: args.longRun === true }, checks.length + 2);
      if (!policy.ok) return error(policy.message);
      const job = await enqueueOperatorJob({
        kind: "rollback",
        cwd,
        timeoutPolicy: policy.policy,
        steps: [
          {
            type: "rollback",
            label: `rollback snapshot ${snapshotId}`,
            cwd,
            snapshotId,
            restart,
            healthChecks: checks,
          },
        ],
      });
      return { handled: true, payload: queued(job, { snapshotId }) };
    }

    if (name === "purr_deploy_project") {
      if (args.approved !== true) return error("deployment requires approved=true");
      const dirtyStrategy = (valueString(args.dirtyStrategy) ?? "reject") as DirtyStrategy;
      if (!new Set(["reject", "stash", "preserve", "discard"]).has(dirtyStrategy)) {
        return error(`invalid dirtyStrategy: ${dirtyStrategy}`);
      }
      const targetRef = valueString(args.targetRef);
      const expectedHead = valueString(args.expectedHead);
      const checks = parseHealthChecks(args.healthChecks) ?? [];
      const plan = await planDeployment({
        cwd,
        targetRef,
        expectedHead,
        verifyCommands: stringArray(args.verifyCommands),
        buildCommands: stringArray(args.buildCommands),
        serviceName: valueString(args.serviceName),
        healthChecks: checks as unknown as Array<Record<string, unknown>>,
        allowDirty: dirtyStrategy !== "reject",
      });
      const installCommands = args.skipInstall === true
        ? []
        : stringArray(args.installCommands) ?? plan.commands.install;
      const verifyCommands = stringArray(args.verifyCommands) ?? plan.commands.verify;
      const buildCommands = stringArray(args.buildCommands) ?? plan.commands.build;
      const manager = (valueString(args.serviceManager) ?? "auto") as ServiceManager;
      const restart = restartInput(
        { ...args, serviceManager: manager },
        cwd,
        manager === "docker_compose" || plan.strategy === "docker_compose" ? "up" : "restart"
      );
      const steps: OperatorStep[] = [
        {
          type: "snapshot",
          label: "capture pre-deploy snapshot",
          cwd,
          reason: `deploy ${targetRef ?? expectedHead ?? "current target"}`,
          plan: plan as unknown as Record<string, unknown>,
        },
      ];
      if (plan.project.repository) {
        steps.push({
          type: "git_deploy",
          label: `activate Git target ${expectedHead ?? targetRef ?? "FETCH_HEAD"}`,
          cwd,
          targetRef,
          expectedHead,
          dirtyStrategy,
        });
      }
      steps.push(...commandSteps(cwd, installCommands, "install"));
      steps.push(...commandSteps(cwd, verifyCommands, "verify"));
      steps.push(...commandSteps(cwd, buildCommands, "build"));
      if (manager !== "custom" || restart.customArgv?.length || plan.service.manager !== "none") {
        steps.push(restart);
      }
      steps.push(
        ...checks.map((check, index) => ({
          type: "health" as const,
          label: `post-deploy health ${index + 1}: ${check.name ?? check.type}`,
          cwd,
          check,
        }))
      );
      const policy = timeoutPolicy(args, steps.length);
      if (!policy.ok) return error(policy.message);
      const job = await enqueueOperatorJob({
        kind: "deployment",
        cwd,
        env: envResult.env,
        timeoutPolicy: policy.policy,
        steps,
        rollbackOnFailure: args.rollbackOnFailure !== false,
        restartAfterRollback: restart,
        healthAfterRollback: checks,
        plan: plan as unknown as Record<string, unknown>,
      });
      return {
        handled: true,
        payload: queued(job, {
          plan,
          rollbackOnFailure: args.rollbackOnFailure !== false,
        }),
      };
    }

    return { handled: false };
  } catch (caught) {
    return {
      handled: true,
      isError: true,
      payload: {
        error: "operator_tool_failed",
        message: caught instanceof Error ? caught.message : String(caught),
      },
    };
  }
}
