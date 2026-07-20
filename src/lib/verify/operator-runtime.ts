import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { getConfig } from "./config";
import { redactText } from "./redact";
import {
  canonicalDirectory,
  inspectEnvironment,
  inspectProject,
  inspectRuntime,
} from "./operator-inspection";
import type {
  DeploymentSnapshot,
  DeploymentSnapshotFile,
  OperatorCommandStep,
  OperatorGitDeployStep,
  OperatorHealthCheck,
  OperatorRestartStep,
  OperatorStepResult,
  ServiceManager,
} from "./operator-operation-types";

interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

interface RunCallbacks {
  onChild?: (child: ChildProcess | null) => void;
  onProgress?: (stdout: string, stderr: string, truncated: boolean) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function deploymentsRoot(): string {
  return path.join(getConfig().dataDir, "deployments");
}

function snapshotsRoot(): string {
  return path.join(deploymentsRoot(), "snapshots");
}

function locksRoot(): string {
  return path.join(deploymentsRoot(), "locks");
}

function boundedAppend(current: string, chunk: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= maxBytes) return { value: current, truncated: true };
  const remaining = maxBytes - currentBytes;
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.length <= remaining) return { value: current + chunk, truncated: false };
  return {
    value: current + bytes.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
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
    // Process may already be gone.
  }
}

export function sanitizeGitRemote(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return raw.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
  }
}

export function classifyDestructiveCommand(display: string): string | null {
  const value = display.trim();
  const rules: Array<[RegExp, string]> = [
    [/\brm\s+-[^\n]*r[^\n]*f\b/i, "recursive_force_delete"],
    [/\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f)/i, "destructive_git_reset"],
    [/\bdocker\s+compose\b[^\n]*\bdown\b[^\n]*\s-v\b/i, "docker_volume_delete"],
    [/\bsystemctl\s+(?:disable|mask|stop)\b/i, "service_disable_or_stop"],
    [/\b(?:drop|truncate)\s+(?:database|table)\b/i, "database_destructive_statement"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive_permission_change"],
    [/\bmkfs(?:\.|\s)|\bdd\s+if=/i, "filesystem_overwrite"],
  ];
  return rules.find(([rule]) => rule.test(value))?.[1] ?? null;
}

const PROJECT_PROCESS_ENV_KEYS_TO_CLEAR = [
  "NEXT_DEPLOYMENT_ID",
  "TURBOPACK",
  "__NEXT_PRIVATE_ORIGIN",
  "__NEXT_PRIVATE_STANDALONE_CONFIG",
] as const;

export function createProjectProcessEnvironment(
  runtimeEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROJECT_PROCESS_ENV_KEYS_TO_CLEAR) delete env[key];
  return { ...env, ...runtimeEnv };
}

export async function runOperatorCommand(
  step: OperatorCommandStep,
  runtimeEnv: Record<string, string>,
  timeoutMs: number,
  callbacks: RunCallbacks = {}
): Promise<OperatorStepResult> {
  const envSecrets = Object.values(runtimeEnv).filter((value) => value.length >= 6);
  const maxBytes = getConfig().maxLogBytes;
  const effectiveTimeout = Math.max(1_000, Math.min(timeoutMs, step.timeoutMs ?? timeoutMs));
  let program: string;
  let args: string[];
  if (step.argv?.length) {
    program = step.argv[0];
    args = step.argv.slice(1);
  } else if (step.command && step.shell === true) {
    program = "/bin/sh";
    args = ["-lc", step.command];
  } else {
    return {
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: "argv is required unless command is used with shell=true",
      truncated: false,
      timedOut: false,
    };
  }

  if (step.background) {
    try {
      const child = spawn(program, args, {
        cwd: step.cwd,
        env: createProjectProcessEnvironment(runtimeEnv),
        stdio: "ignore",
        shell: false,
        detached: process.platform !== "win32",
      });
      child.unref();
      await new Promise((resolve) => setTimeout(resolve, 750));
      const alive = child.exitCode === null && child.signalCode === null;
      return {
        ok: alive,
        exitCode: alive ? 0 : child.exitCode,
        stdout: alive ? `[operator] background process started pid=${child.pid}` : "",
        stderr: alive ? "" : "background process exited during startup",
        truncated: false,
        timedOut: false,
        backgroundPid: child.pid,
      };
    } catch (error) {
      return {
        ok: false,
        exitCode: 127,
        stdout: "",
        stderr: `failed to start background process: ${(error as Error).message}`,
        truncated: false,
        timedOut: false,
      };
    }
  }

  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd: step.cwd,
      env: createProjectProcessEnvironment(runtimeEnv),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    callbacks.onChild?.(child);
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let finished = false;

    const publish = () => {
      callbacks.onProgress?.(
        redactText(stdout, envSecrets),
        redactText(stderr, envSecrets),
        truncated
      );
    };
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callbacks.onChild?.(null);
      const expected = step.expectedExitCodes?.length ? step.expectedExitCodes : [0];
      resolve({
        ok: !timedOut && code !== null && expected.includes(code),
        exitCode: code,
        stdout: redactText(stdout, envSecrets),
        stderr: redactText(stderr, envSecrets),
        truncated,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 3_000).unref?.();
    }, effectiveTimeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = boundedAppend(stdout, chunk.toString("utf8"), maxBytes);
      stdout = next.value;
      truncated ||= next.truncated;
      publish();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = boundedAppend(stderr, chunk.toString("utf8"), maxBytes);
      stderr = next.value;
      truncated ||= next.truncated;
      publish();
    });
    child.on("error", (error) => {
      stderr += `\n[operator] failed to spawn: ${error.message}`;
      finish(127);
    });
    child.on("close", (code) => finish(code));
  });
}

function execCapture(
  program: string,
  args: string[],
  cwd?: string,
  timeoutMs = 60_000
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    execFile(
      program,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({
          code: typeof err?.code === "number" ? err.code : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: Boolean(err?.killed),
          truncated: false,
        });
      }
    );
  });
}

function safeRelative(relative: string): boolean {
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    !relative.split(/[\\/]/).includes("..")
  );
}

async function copySnapshotFile(
  cwd: string,
  destinationRoot: string,
  relativePath: string,
  kind: DeploymentSnapshotFile["kind"]
): Promise<DeploymentSnapshotFile | null> {
  if (!safeRelative(relativePath)) return null;
  const source = path.join(cwd, relativePath);
  const destination = path.join(destinationRoot, relativePath);
  try {
    const stat = await fs.lstat(source);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(source);
      await fs.symlink(target, destination).catch(async () => {
        await fs.rm(destination, { recursive: true, force: true });
        await fs.symlink(target, destination);
      });
    } else if (stat.isDirectory()) {
      await fs.cp(source, destination, { recursive: true, force: true });
    } else if (stat.isFile()) {
      await fs.copyFile(source, destination);
    } else {
      return null;
    }
    return { relativePath, kind, size: stat.size };
  } catch {
    return null;
  }
}

function snapshotId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${randomUUID().slice(0, 12)}`;
}

export async function createDeploymentSnapshot(
  cwdInput: string,
  options: { reason?: string; plan?: Record<string, unknown> } = {}
): Promise<DeploymentSnapshot> {
  const resolved = await canonicalDirectory(cwdInput);
  const cwd = resolved.canonicalPath;
  const [project, runtime, environment] = await Promise.all([
    inspectProject(cwd),
    inspectRuntime(cwd, { includeProcesses: false }),
    inspectEnvironment(cwd, { revealValues: false }),
  ]);
  const id = snapshotId();
  const root = path.join(snapshotsRoot(), id);
  const configRoot = path.join(root, "files");
  const untrackedRoot = path.join(root, "untracked");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(untrackedRoot, { recursive: true });

  const files: DeploymentSnapshotFile[] = [];
  const configNames = new Set([
    "package.json",
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.toml",
    "Cargo.lock",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "go.sum",
    ...project.environmentFiles,
    ...project.composeFiles,
    ...project.pm2Files,
    ...project.manifestFiles,
  ]);
  for (const name of configNames) {
    const copied = await copySnapshotFile(cwd, configRoot, name, "config");
    if (copied) files.push(copied);
  }

  let completeRollback = false;
  if (project.git.present && project.git.head) {
    const [workingPatch, stagedPatch, untracked] = await Promise.all([
      execCapture("git", ["diff", "--binary"], cwd),
      execCapture("git", ["diff", "--cached", "--binary"], cwd),
      execCapture("git", ["ls-files", "--others", "--exclude-standard", "-z"], cwd),
    ]);
    await fs.writeFile(path.join(root, "worktree.patch"), workingPatch.stdout, "utf8");
    await fs.writeFile(path.join(root, "staged.patch"), stagedPatch.stdout, "utf8");
    for (const relative of untracked.stdout.split("\0").filter(Boolean)) {
      const copied = await copySnapshotFile(cwd, untrackedRoot, relative, "untracked");
      if (copied) files.push(copied);
    }
    completeRollback = true;
  }

  const service = runtime.pm2[0]
    ? { manager: "pm2" as const, name: runtime.pm2[0].name, composeFile: null }
    : runtime.systemd[0]
      ? { manager: "systemd" as const, name: runtime.systemd[0].name, composeFile: null }
      : runtime.dockerCompose[0]
        ? {
            manager: "docker_compose" as const,
            name: runtime.dockerCompose[0].service,
            composeFile: runtime.dockerCompose[0].composeFile,
          }
        : { manager: "none" as const, name: null, composeFile: null };
  const metadataPath = path.join(root, "snapshot.json");
  const snapshot: DeploymentSnapshot = {
    snapshotVersion: 1,
    snapshotId: id,
    createdAt: nowIso(),
    cwd,
    reason: options.reason ?? null,
    completeRollback,
    git: {
      present: project.git.present,
      head: project.git.head,
      branch: project.git.branch,
      origin: sanitizeGitRemote(project.git.origin),
      dirty: project.git.dirty,
    },
    service,
    files,
    environmentKeys: environment.entries.map((entry) => entry.key),
    plan: options.plan,
    metadataPath,
  };
  await fs.writeFile(metadataPath, JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}

export async function readDeploymentSnapshot(id: string): Promise<DeploymentSnapshot> {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("invalid snapshotId");
  const metadataPath = path.join(snapshotsRoot(), id, "snapshot.json");
  const parsed = JSON.parse(await fs.readFile(metadataPath, "utf8")) as DeploymentSnapshot;
  if (parsed.snapshotId !== id || parsed.snapshotVersion !== 1) {
    throw new Error("snapshot metadata mismatch");
  }
  return parsed;
}

async function restoreTree(sourceRoot: string, cwd: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, source);
      if (!safeRelative(relative)) continue;
      const destination = path.join(cwd, relative);
      if (entry.isDirectory()) {
        await fs.mkdir(destination, { recursive: true });
        await walk(source);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(source);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rm(destination, { recursive: true, force: true });
        await fs.symlink(target, destination);
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
      }
    }
  };
  await walk(sourceRoot);
}

export async function rollbackDeploymentSnapshot(
  snapshotIdValue: string,
  cwdInput?: string
): Promise<OperatorStepResult> {
  const snapshot = await readDeploymentSnapshot(snapshotIdValue);
  const cwd = cwdInput ? (await canonicalDirectory(cwdInput)).canonicalPath : snapshot.cwd;
  if (cwd !== snapshot.cwd) {
    return {
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: `snapshot cwd mismatch: expected ${snapshot.cwd}, received ${cwd}`,
      truncated: false,
      timedOut: false,
    };
  }
  const root = path.join(snapshotsRoot(), snapshot.snapshotId);
  const output: string[] = [];
  if (snapshot.git.present && snapshot.git.head) {
    const reset = await execCapture("git", ["reset", "--hard", snapshot.git.head], cwd, 120_000);
    if (reset.code !== 0) {
      return {
        ok: false,
        exitCode: reset.code,
        stdout: reset.stdout,
        stderr: reset.stderr,
        truncated: false,
        timedOut: reset.timedOut,
      };
    }
    await execCapture("git", ["clean", "-fd"], cwd, 120_000);
    const staged = path.join(root, "staged.patch");
    const worktree = path.join(root, "worktree.patch");
    if ((await fs.stat(staged).catch(() => null))?.size) {
      const applied = await execCapture("git", ["apply", "--binary", "--index", staged], cwd, 120_000);
      if (applied.code !== 0) throw new Error(`failed to restore staged patch: ${applied.stderr}`);
    }
    if ((await fs.stat(worktree).catch(() => null))?.size) {
      const applied = await execCapture("git", ["apply", "--binary", worktree], cwd, 120_000);
      if (applied.code !== 0) throw new Error(`failed to restore worktree patch: ${applied.stderr}`);
    }
    output.push(`restored Git HEAD ${snapshot.git.head}`);
  }
  await restoreTree(path.join(root, "files"), cwd);
  await restoreTree(path.join(root, "untracked"), cwd);
  output.push(`restored snapshot files from ${snapshot.snapshotId}`);
  return {
    ok: true,
    exitCode: 0,
    stdout: output.join("\n"),
    stderr: snapshot.completeRollback ? "" : "snapshot contained configuration backup only",
    truncated: false,
    timedOut: false,
    snapshotId: snapshot.snapshotId,
  };
}

export async function deployGitRevision(step: OperatorGitDeployStep): Promise<OperatorStepResult> {
  const project = await inspectProject(step.cwd);
  if (!project.git.present) {
    return {
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: "git deployment requires a Git working tree",
      truncated: false,
      timedOut: false,
    };
  }
  const output: string[] = [];
  let stashed = false;
  if (project.git.dirty) {
    if (step.dirtyStrategy === "reject") {
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "working tree is dirty; choose stash, preserve, or discard explicitly",
        truncated: false,
        timedOut: false,
      };
    }
    if (step.dirtyStrategy === "discard") {
      await execCapture("git", ["reset", "--hard"], step.cwd, 120_000);
      await execCapture("git", ["clean", "-fd"], step.cwd, 120_000);
      output.push("discarded dirty working tree after snapshot");
    } else {
      const stash = await execCapture(
        "git",
        ["stash", "push", "--include-untracked", "--message", `purr-deploy-${Date.now()}`],
        step.cwd,
        120_000
      );
      if (stash.code !== 0) throw new Error(`failed to stash dirty tree: ${stash.stderr}`);
      stashed = !/No local changes to save/i.test(stash.stdout);
      output.push("stashed dirty working tree");
    }
  }

  const fetch = await execCapture("git", ["fetch", "--prune", "origin"], step.cwd, 300_000);
  if (fetch.code !== 0) throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`);
  if (step.expectedHead) {
    await execCapture("git", ["fetch", "--depth=1", "origin", step.expectedHead], step.cwd, 300_000);
  }

  if (step.targetRef && !/^[0-9a-fA-F]{40}$/.test(step.targetRef)) {
    let checkout = await execCapture("git", ["checkout", step.targetRef], step.cwd, 120_000);
    if (checkout.code !== 0) {
      checkout = await execCapture(
        "git",
        ["checkout", "-B", step.targetRef, `origin/${step.targetRef}`],
        step.cwd,
        120_000
      );
    }
    if (checkout.code !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`);
  }

  const target = step.expectedHead
    ? step.expectedHead
    : step.targetRef
      ? `origin/${step.targetRef}`
      : "FETCH_HEAD";
  let reset = await execCapture("git", ["reset", "--hard", target], step.cwd, 120_000);
  if (reset.code !== 0 && step.targetRef) {
    reset = await execCapture("git", ["reset", "--hard", step.targetRef], step.cwd, 120_000);
  }
  if (reset.code !== 0) throw new Error(`git reset failed: ${reset.stderr || reset.stdout}`);

  const head = await execCapture("git", ["rev-parse", "HEAD"], step.cwd, 30_000);
  const actualHead = head.stdout.trim();
  if (step.expectedHead && actualHead.toLowerCase() !== step.expectedHead.toLowerCase()) {
    throw new Error(`HEAD mismatch after deployment: expected ${step.expectedHead}, got ${actualHead}`);
  }
  if (stashed && (step.dirtyStrategy === "stash" || step.dirtyStrategy === "preserve")) {
    const pop = await execCapture("git", ["stash", "pop"], step.cwd, 120_000);
    if (pop.code !== 0) throw new Error(`failed to restore stashed changes: ${pop.stderr}`);
    output.push("restored stashed working tree");
  }
  output.push(`activated Git HEAD ${actualHead}`);
  return {
    ok: true,
    exitCode: 0,
    stdout: output.join("\n"),
    stderr: "",
    truncated: false,
    timedOut: false,
    actualHead,
  };
}

async function resolveRestart(step: OperatorRestartStep): Promise<{
  manager: Exclude<ServiceManager, "auto">;
  serviceName?: string;
  composeFile?: string;
}> {
  if (step.manager !== "auto") {
    return { manager: step.manager, serviceName: step.serviceName, composeFile: step.composeFile };
  }
  const runtime = await inspectRuntime(step.cwd, { includeProcesses: false });
  if (runtime.pm2[0]) return { manager: "pm2", serviceName: step.serviceName ?? runtime.pm2[0].name };
  if (runtime.systemd[0]) return { manager: "systemd", serviceName: step.serviceName ?? runtime.systemd[0].name };
  if (runtime.dockerCompose[0]) {
    return {
      manager: "docker_compose",
      serviceName: step.serviceName ?? runtime.dockerCompose[0].service ?? undefined,
      composeFile: step.composeFile ?? runtime.dockerCompose[0].composeFile,
    };
  }
  if (step.customArgv?.length) return { manager: "custom", serviceName: step.serviceName };
  throw new Error("no service manager matched this project");
}

export async function restartService(step: OperatorRestartStep): Promise<OperatorStepResult> {
  const resolved = await resolveRestart(step);
  let argv: string[];
  if (resolved.manager === "pm2") {
    if (!resolved.serviceName) throw new Error("PM2 serviceName is required");
    argv = ["pm2", step.action === "restart" ? "restart" : "reload", resolved.serviceName, "--update-env"];
  } else if (resolved.manager === "systemd") {
    if (!resolved.serviceName) throw new Error("systemd serviceName is required");
    argv = ["systemctl", step.action === "reload" ? "reload" : "restart", resolved.serviceName];
  } else if (resolved.manager === "docker_compose") {
    const composeFile = resolved.composeFile ?? "compose.yml";
    argv = step.action === "up"
      ? ["docker", "compose", "-f", composeFile, "up", "-d", "--build"]
      : ["docker", "compose", "-f", composeFile, "restart"];
  } else if (resolved.manager === "custom" && step.customArgv?.length) {
    argv = step.customArgv;
  } else {
    throw new Error("custom restart requires customArgv");
  }
  return runOperatorCommand(
    {
      type: "command",
      label: step.label,
      cwd: step.cwd,
      argv,
      expectedExitCodes: [0],
      timeoutMs: 10 * 60_000,
    },
    {},
    10 * 60_000
  );
}

async function tcpCheck(host: string, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("TCP health check timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function singleHealthCheck(
  check: OperatorHealthCheck,
  defaultCwd: string
): Promise<Record<string, unknown>> {
  const timeoutMs = Math.max(1_000, Math.min(check.timeoutMs ?? 15_000, 10 * 60_000));
  if (check.type === "http" || check.type === "json_rpc") {
    if (!check.url) throw new Error(`${check.type} check requires url`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = check.type === "json_rpc"
        ? JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: check.jsonRpcMethod ?? "health",
            params: check.jsonRpcParams ?? [],
          })
        : undefined;
      const response = await fetch(check.url, {
        method: check.method ?? (body ? "POST" : "GET"),
        headers: body ? { "content-type": "application/json" } : undefined,
        body,
        signal: controller.signal,
      });
      const text = (await response.text()).slice(0, 8_192);
      const expectedStatus = check.expectedStatus ?? 200;
      if (response.status !== expectedStatus) {
        throw new Error(`expected HTTP ${expectedStatus}, received ${response.status}`);
      }
      if (check.bodyIncludes && !text.includes(check.bodyIncludes)) {
        throw new Error(`response body did not include ${JSON.stringify(check.bodyIncludes)}`);
      }
      return { status: response.status, bodyPreview: text.slice(0, 500) };
    } finally {
      clearTimeout(timer);
    }
  }
  if (check.type === "tcp") {
    if (!check.host || !check.port) throw new Error("TCP check requires host and port");
    await tcpCheck(check.host, check.port, timeoutMs);
    return { host: check.host, port: check.port, connected: true };
  }
  if (check.type === "process") {
    if (!check.pid) throw new Error("process check requires pid");
    process.kill(check.pid, 0);
    return { pid: check.pid, alive: true };
  }
  if (check.type === "pm2") {
    if (!check.serviceName) throw new Error("PM2 check requires serviceName");
    const result = await execCapture("pm2", ["jlist"], defaultCwd, timeoutMs);
    const rows = JSON.parse(result.stdout) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    const service = rows.find((row) => row.name === check.serviceName);
    if (!service || service.pm2_env?.status !== "online") throw new Error("PM2 service is not online");
    return { serviceName: check.serviceName, status: service.pm2_env?.status };
  }
  if (check.type === "systemd") {
    if (!check.serviceName) throw new Error("systemd check requires serviceName");
    const result = await execCapture("systemctl", ["is-active", check.serviceName], defaultCwd, timeoutMs);
    if (result.code !== 0 || result.stdout.trim() !== "active") throw new Error("systemd service is not active");
    return { serviceName: check.serviceName, status: "active" };
  }
  if (check.type === "docker") {
    const composeFile = check.composeFile ?? "compose.yml";
    const result = await execCapture(
      "docker",
      ["compose", "-f", composeFile, "ps", "--format", "json"],
      check.cwd ?? defaultCwd,
      timeoutMs
    );
    if (result.code !== 0) throw new Error(result.stderr || "Docker Compose check failed");
    if (check.serviceName && !result.stdout.includes(check.serviceName)) {
      throw new Error(`Docker service not found: ${check.serviceName}`);
    }
    return { composeFile, serviceName: check.serviceName ?? null, output: result.stdout.slice(0, 2_000) };
  }
  if (check.type === "custom") {
    if (!check.argv?.length) throw new Error("custom health check requires argv");
    const result = await runOperatorCommand(
      {
        type: "command",
        label: check.name ?? "custom health check",
        cwd: check.cwd ?? defaultCwd,
        argv: check.argv,
        timeoutMs,
        expectedExitCodes: [0],
      },
      {},
      timeoutMs
    );
    if (!result.ok) throw new Error(result.stderr || result.stdout || "custom health check failed");
    return { output: result.stdout.slice(0, 2_000) };
  }
  throw new Error(`unsupported health check type: ${check.type}`);
}

export async function runHealthCheck(
  check: OperatorHealthCheck,
  cwd: string
): Promise<OperatorStepResult> {
  const retries = Math.max(1, Math.min(check.retries ?? 1, 60));
  const intervalMs = Math.max(250, Math.min(check.intervalMs ?? 1_000, 60_000));
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const detail = await singleHealthCheck(check, cwd);
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ attempt, check: check.name ?? check.type, detail }, null, 2),
        stderr: "",
        truncated: false,
        timedOut: false,
      };
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr: lastError?.message ?? "health check failed",
    truncated: false,
    timedOut: false,
  };
}

export function projectLockKey(cwd: string): string {
  return createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 32);
}

export async function acquireProjectLock(
  cwd: string,
  jobId: string,
  timeoutMs: number,
  canceled: () => boolean
): Promise<() => Promise<void>> {
  const root = locksRoot();
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, `${projectLockKey(cwd)}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (canceled()) throw new Error("canceled while waiting for project lock");
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ jobId, cwd, pid: process.pid, acquiredAt: nowIso() }));
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(file, "utf8")) as { jobId?: string };
          if (current.jobId === jobId) await fs.unlink(file);
        } catch {
          // Lock may already have been released.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(file);
        if (Date.now() - stat.mtimeMs > 12 * 60 * 60 * 1000) {
          await fs.unlink(file);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`timed out waiting for project lock: ${cwd}`);
}
