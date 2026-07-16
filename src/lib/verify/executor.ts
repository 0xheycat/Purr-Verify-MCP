// Verification job executor.
//
// Runs jobs asynchronously in the background (same Node process as the API).
// Each job:
//   1. Creates a fresh temp workspace.
//   2. Clones the repo/branch (shallow).
//   3. Verifies expected_head if provided.
//   4. Runs allowlisted commands sequentially (no shell).
//   5. Captures + redacts logs, enforces per-command and per-job timeouts.
//   6. Cleans up the workspace unconditionally.
//
// Concurrency is capped by MAX_CONCURRENT_JOBS via a small scheduler.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getConfig, isRepoAllowed, isValidHead, isValidRef } from "./config";
import { parseCommand } from "./parse";
import { redactText } from "./redact";
import { cleanupJobDirectories, runWorkspaceJanitor } from "./workspace-cleanup";
import {
  buildToolchainEnv,
  installStrategy,
  normalizeBunx,
  prepareToolchain,
} from "./toolchain";
import {
  clearRuntime,
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
import type {
  CommandResult,
  EffectiveToolchain,
  InstallStrategy,
  Job,
  JobStatus,
  ResolutionProbeModuleRequest,
  ResolutionProbeResult,
  WebhookDelivery,
} from "./types";

let schedulerRunning = false;
let janitorRunning = false;
let lastJanitorRunMs = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function buildCloneUrl(repo: string, runtimeToken?: string): string {
  // Prefer the per-request token (github_passthrough mode: the bearer GitHub
  // PAT). Fall back to the server's env GITHUB_TOKEN (server_token mode).
  const token = runtimeToken || getConfig().githubToken;
  if (token) {
    return `https://x-access-token:${token}@github.com/${repo}.git`;
  }
  return `https://github.com/${repo}.git`;
}

function killChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the direct child below.
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

async function terminateRuntimeProcesses(jobId: string, graceMs = 3000): Promise<void> {
  const rt = getRuntime(jobId);
  if (!rt) return;
  const children = new Set<ChildProcess>();
  if (rt.currentChild) children.add(rt.currentChild);
  for (const child of rt.backgroundChildren ?? []) children.add(child);
  if (children.size === 0) return;

  for (const child of children) killChildTree(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      killChildTree(child, "SIGKILL");
    }
  }
}

async function sweepOrphanWorkspaces(force = false): Promise<void> {
  const cfg = getConfig();
  const intervalMs = Math.max(60_000, Math.min(cfg.cleanupAfterMs, 15 * 60_000));
  if (janitorRunning || (!force && Date.now() - lastJanitorRunMs < intervalMs)) return;
  janitorRunning = true;
  lastJanitorRunMs = Date.now();
  try {
    const activeJobIds = new Set(
      listJobs(1000)
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) => job.jobId)
    );
    const entries = await runWorkspaceJanitor({
      root: cfg.workdirBase,
      activeJobIds,
      olderThanMs: cfg.cleanupAfterMs,
    });
    const byJob = new Map<string, typeof entries>();
    for (const entry of entries) {
      byJob.set(entry.jobId, [...(byJob.get(entry.jobId) ?? []), entry]);
    }
    for (const [jobId, jobEntries] of byJob) {
      const job = getJob(jobId);
      if (!job || activeJobIds.has(jobId)) continue;
      const failed = jobEntries.filter((entry) => !entry.removed);
      const workspaceEntries = jobEntries.filter((entry) => entry.kind === "workspace");
      const cacheEntries = jobEntries.filter((entry) => entry.kind === "cache");
      const status = failed.length === 0 ? "done" : "partial";
      updateJob(jobId, {
        cleanupStatus: status,
        cleanup: {
          status,
          startedAt: job.cleanup?.startedAt ?? null,
          finishedAt: nowIso(),
          workspaceRemoved:
            workspaceEntries.length > 0
              ? workspaceEntries.every((entry) => entry.removed)
              : job.cleanup?.workspaceRemoved,
          cacheRemoved:
            cacheEntries.length > 0
              ? cacheEntries.every((entry) => entry.removed)
              : job.cleanup?.cacheRemoved,
          workspaceError:
            workspaceEntries.find((entry) => entry.error)?.error ?? null,
          cacheError: cacheEntries.find((entry) => entry.error)?.error ?? null,
        },
      });
    }
  } finally {
    janitorRunning = false;
  }
}

// Run a single program (no shell) with stdout/stderr capture + redaction.
//
// `opts.cleanNodeEnv` (used for the repo's OWN commands: bun install / bun test
// / next build / prisma generate) strips NODE_PATH / NODE_OPTIONS from the
// child's environment so module resolution is driven purely by the isolated
// per-job workspace's node_modules and never inherits the server bundle's
// resolution hints — a root cause of the runner's false-negative failures.
function runSpawn(
  program: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  onChild: (child: ChildProcess) => void,
  opts?: {
    cleanNodeEnv?: boolean;
    onStdout?: (stdout: string, truncated: boolean) => void;
    onStderr?: (stderr: string, truncated: boolean) => void;
  }
): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const baseEnv: Record<string, string | undefined> = opts?.cleanNodeEnv
      ? {
          HOME: process.env.HOME,
          USER: process.env.USER,
          LOGNAME: process.env.LOGNAME,
          SHELL: process.env.SHELL,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PATH: process.env.PATH,
          PWD: cwd,
        }
      : { ...process.env };
    if (opts?.cleanNodeEnv) {
      delete baseEnv.NODE_PATH;
      delete baseEnv.NODE_OPTIONS;
      delete baseEnv.NODE_ENV;
    }
    const child = spawn(program, args, {
      cwd,
      env: { ...baseEnv, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    onChild(child);

    let stdoutLen = 0;
    let stderrLen = 0;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let done = false;

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, truncated, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child, "SIGTERM");
      setTimeout(() => killChildTree(child, "SIGKILL"), 3000).unref?.();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen >= maxBytes) {
        truncated = true;
        return;
      }
      const s = chunk.toString("utf8");
      const remaining = maxBytes - stdoutLen;
      if (s.length > remaining) {
        stdout += s.slice(0, remaining);
        stdoutLen = maxBytes;
        truncated = true;
      } else {
        stdout += s;
        stdoutLen += s.length;
      }
      opts?.onStdout?.(stdout, truncated);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen >= maxBytes) {
        truncated = true;
        return;
      }
      const s = chunk.toString("utf8");
      const remaining = maxBytes - stderrLen;
      if (s.length > remaining) {
        stderr += s.slice(0, remaining);
        stderrLen = maxBytes;
        truncated = true;
      } else {
        stderr += s;
        stderrLen += s.length;
      }
      opts?.onStderr?.(stderr, truncated);
    });

    child.on("error", (err) => {
      stderr += `\n[executor] failed to spawn: ${err.message}`;
      finish(127);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

function runBackgroundSpawn(
  program: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
  maxBytes: number,
  onChild: (child: ChildProcess) => void,
  opts?: {
    cleanNodeEnv?: boolean;
    onStdout?: (stdout: string, truncated: boolean) => void;
    onStderr?: (stderr: string, truncated: boolean) => void;
  }
): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const baseEnv: Record<string, string | undefined> = opts?.cleanNodeEnv
      ? {
          HOME: process.env.HOME,
          USER: process.env.USER,
          LOGNAME: process.env.LOGNAME,
          SHELL: process.env.SHELL,
          LANG: process.env.LANG,
          LC_ALL: process.env.LC_ALL,
          TMPDIR: process.env.TMPDIR,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PATH: process.env.PATH,
          PWD: cwd,
        }
      : { ...process.env };
    if (opts?.cleanNodeEnv) {
      delete baseEnv.NODE_PATH;
      delete baseEnv.NODE_OPTIONS;
      delete baseEnv.NODE_ENV;
    }
    const child = spawn(program, args, {
      cwd,
      env: { ...baseEnv, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    onChild(child);

    let stdout = "";
    let stderr = "";
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let resolved = false;

    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(readyTimer);
      resolve({ code, stdout, stderr, truncated, timedOut: false });
    };

    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const s = chunk.toString("utf8");
      if (kind === "stdout") {
        const remaining = maxBytes - stdoutLen;
        if (remaining <= 0) {
          truncated = true;
        } else if (s.length > remaining) {
          stdout += s.slice(0, remaining);
          stdoutLen = maxBytes;
          truncated = true;
        } else {
          stdout += s;
          stdoutLen += s.length;
        }
        opts?.onStdout?.(stdout, truncated);
      } else {
        const remaining = maxBytes - stderrLen;
        if (remaining <= 0) {
          truncated = true;
        } else if (s.length > remaining) {
          stderr += s.slice(0, remaining);
          stderrLen = maxBytes;
          truncated = true;
        } else {
          stderr += s;
          stderrLen += s.length;
        }
        opts?.onStderr?.(stderr, truncated);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (err) => {
      stderr += `\n[executor] failed to spawn background process: ${err.message}`;
      finish(127);
    });
    child.on("exit", (code) => {
      if (!resolved) finish(code ?? 1);
    });

    const readyTimer = setTimeout(() => {
      finish(0);
    }, 5000);
  });
}

interface CloneResult {
  ok: boolean;
  error?: string;
  head?: string;
}

async function cloneRepo(
  repo: string,
  ref: string,
  workdir: string,
  runtimeToken?: string
): Promise<CloneResult> {
  const url = buildCloneUrl(repo, runtimeToken);
  const args = ["clone", "--depth=1", "--branch", ref, url, workdir];
  const res = await runSpawn("git", args, {}, process.cwd(), 120_000, 200_000, () => {});
  if (res.code !== 0) {
    // Fallback: clone default then checkout ref (handles raw SHAs / some tags).
    const res2 = await runSpawn(
      "git",
      ["clone", "--depth=1", url, workdir],
      {},
      process.cwd(),
      120_000,
      200_000,
      () => {}
    );
    if (res2.code !== 0) {
      return { ok: false, error: redactText(`git clone failed: ${res2.stderr || res2.stdout || "unknown error"}`) };
    }
    let co = await runSpawn("git", ["checkout", ref], {}, workdir, 60_000, 100_000, () => {});
    if (co.code !== 0) {
      const exactSha = /^[0-9a-fA-F]{40}$/.test(ref);
      if (exactSha) {
        await runSpawn("git", ["fetch", "--depth=1", "origin", ref], {}, workdir, 120_000, 200_000, () => {});
      } else {
        await runSpawn(
          "git",
          ["fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/remotes/origin/*"],
          {},
          workdir,
          180_000,
          300_000,
          () => {}
        );
        await runSpawn("git", ["fetch", "--unshallow", "origin"], {}, workdir, 300_000, 300_000, () => {});
      }
      co = await runSpawn("git", ["checkout", ref], {}, workdir, 60_000, 100_000, () => {});
    }
    if (co.code !== 0) {
      return { ok: false, error: redactText(`git checkout ${ref} failed: ${co.stderr || co.stdout}`) };
    }
  }
  // Resolve HEAD.
  const rev = await runSpawn("git", ["rev-parse", "HEAD"], {}, workdir, 30_000, 10_000, () => {});
  const short = await runSpawn("git", ["rev-parse", "--short", "HEAD"], {}, workdir, 30_000, 10_000, () => {});
  const full = (rev.stdout || "").trim();
  const shortSha = (short.stdout || "").trim();
  return { ok: true, head: full || shortSha || undefined };
}

function publicToolchain(toolchain: EffectiveToolchain): EffectiveToolchain {
  return {
    declared: toolchain.declared,
    nodeVersion: toolchain.nodeVersion,
    bunVersion: toolchain.bunVersion,
    warnings: toolchain.warnings,
    recommendations: toolchain.recommendations,
    defaults: toolchain.defaults,
  };
}

function commandLine(program: string, args: string[]): string {
  return [program, ...args].join(" ");
}

function normalizeTestCommand(program: string, args: string[]): { program: string; args: string[] } {
  if (program === "bun" && args.length === 1 && args[0] === "test") {
    return { program, args: ["test", "--isolate"] };
  }
  return { program, args };
}

function commandWorkflowRecommendations(commands: string[]): string[] {
  const recommendations: string[] = [];
  if (commands.includes("bun run ci:check")) {
    recommendations.push(
      "For long Next.js repos, prefer split commands (`bun run typecheck`, `bun run lint`, `bun run build`) instead of one `bun run ci:check` so agents get isolated logs, clearer failures, and less wasted rerun time."
    );
  }
  if (commands.includes("bun test")) {
    recommendations.push(
      "Bare `bun test` is executed as `bun test --isolate` by default so test-file globals and module mocks cannot leak across the full suite."
    );
  }
  return recommendations;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function repoCommandEnv(
  toolchain: EffectiveToolchain,
  jobCacheEnv: Record<string, string>,
  jobEnv: Record<string, string>,
  parsedEnv: Record<string, string> = {},
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  return {
    ...buildToolchainEnv(toolchain.pathPrefix ?? [], { PATH: process.env.PATH }),
    ...jobCacheEnv,
    ...jobEnv,
    ...parsedEnv,
    NEXT_TELEMETRY_DISABLED: "1",
    ...extraEnv,
  };
}

function extractFailedTestFiles(stderr: string, stdout: string): string[] {
  const text = `${stderr}\n${stdout}`;
  const files = new Set<string>();
  let currentFile: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^((?:scripts|src)\/[^\n\r:]+(?:\.test|\.spec)\.[cm]?[jt]sx?):$/);
    if (heading) {
      currentFile = heading[1];
      continue;
    }
    if (
      currentFile &&
      (line.includes("(fail)") ||
        line.includes("# Unhandled error between tests") ||
        /^\w*Error:/.test(line) ||
        /^SyntaxError:/.test(line) ||
        /^TypeError:/.test(line))
    ) {
      files.add(currentFile);
    }
  }
  return Array.from(files).slice(0, 8);
}

function isBunTestCommand(program: string, args: string[]): boolean {
  return program === "bun" && args[0] === "test" && args.length === 1;
}

function isNextBuildFailure(commandStr: string, stdout: string, stderr: string): boolean {
  const text = `${commandStr}\n${stdout}\n${stderr}`;
  return /\bnext build\b/.test(text) || /Build error occurred/i.test(text);
}

async function runFailureDiagnostics(args: {
  commandStr: string;
  parsedProgram: string;
  parsedArgs: string[];
  parsedEnv: Record<string, string>;
  workdir: string;
  toolchain: EffectiveToolchain;
  jobCacheEnv: Record<string, string>;
  jobEnv: Record<string, string>;
  envSecrets: string[];
  commandTimeoutMs: number;
  maxLogBytes: number;
  stdout: string;
  stderr: string;
}): Promise<string> {
  const diagnostics: string[] = [];
  const commonEnv = repoCommandEnv(args.toolchain, args.jobCacheEnv, args.jobEnv, args.parsedEnv, {
    NODE_OPTIONS: "--enable-source-maps --trace-uncaught --trace-warnings",
  });

  if (isBunTestCommand(args.parsedProgram, args.parsedArgs)) {
    const files = extractFailedTestFiles(args.stderr, args.stdout);
    if (files.length > 0) {
      diagnostics.push(`[runner diagnostic] bun test failed; rerunning ${files.length} failing test file(s) individually to detect full-suite mock/module leakage.`);
      for (const file of files) {
        const result = await runSpawn(
          "bun",
          ["test", file],
          commonEnv,
          args.workdir,
          Math.min(args.commandTimeoutMs, 180_000),
          Math.min(args.maxLogBytes, 120_000),
          () => {},
          { cleanNodeEnv: true }
        );
        diagnostics.push(
          [
            `[runner diagnostic] bun test ${file} -> exit ${result.code}${result.timedOut ? " (timeout)" : ""}`,
            result.stdout ? redactText(result.stdout, args.envSecrets).trim() : "",
            result.stderr ? redactText(result.stderr, args.envSecrets).trim() : "",
          ].filter(Boolean).join("\n")
        );
      }
    }
  }

  if (isNextBuildFailure(args.commandStr, args.stdout, args.stderr)) {
    diagnostics.push("[runner diagnostic] next build failed; rerunning `next build --debug` with source maps and trace flags to expose the first real module/call-site.");
    const result = await runSpawn(
      "bun",
      ["run", "next", "build", "--debug"],
      {
        ...commonEnv,
        NODE_ENV: "production",
        NEXT_DEBUG_BUILD: "1",
        DEBUG: "next:*,turbopack:*",
      },
      args.workdir,
      Math.min(args.commandTimeoutMs, 240_000),
      Math.min(args.maxLogBytes, 200_000),
      () => {},
      { cleanNodeEnv: true }
    );
    diagnostics.push(
      [
        `[runner diagnostic] bun run next build --debug -> exit ${result.code}${result.timedOut ? " (timeout)" : ""}`,
        result.stdout ? redactText(result.stdout, args.envSecrets).trim() : "",
        result.stderr ? redactText(result.stderr, args.envSecrets).trim() : "",
      ].filter(Boolean).join("\n")
    );
  }

  return diagnostics.join("\n\n");
}

async function runResolutionProbe(
  workdir: string,
  packages: string[],
  modules: ResolutionProbeModuleRequest[],
  toolchain: EffectiveToolchain,
  jobEnv: Record<string, string>,
  envSecrets: string[]
): Promise<ResolutionProbeResult[]> {
  if (packages.length === 0 && modules.length === 0) return [];
  const probeDir = path.join(workdir, "node_modules", ".purr-verify-probe");
  await fs.mkdir(probeDir, { recursive: true });
  const probeFile = path.join(probeDir, "resolution-probe.mjs");
  const script = [
    "import { createRequire } from 'node:module';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "import { spawnSync } from 'node:child_process';",
    "const requireFromWorkspace = createRequire(path.join(process.cwd(), 'package.json'));",
    "const input = JSON.parse(process.argv[2] || '{}');",
    "const pkgs = Array.isArray(input) ? input : (input.packages || []);",
    "const modules = Array.isArray(input.modules) ? input.modules : [];",
    "const probeDir = path.dirname(new URL(import.meta.url).pathname);",
    "const runtimeExecutable = process.argv[0] || process.execPath;",
    "const out = [];",
    "function inferFormat(resolved) {",
    "  if (!resolved) return 'unknown';",
    "  if (/\\.mjs$/i.test(resolved)) return 'esm';",
    "  if (/\\.cjs$/i.test(resolved)) return 'cjs';",
    "  if (/\\.js$/i.test(resolved)) {",
    "    let dir = resolved;",
    "    while (dir && dir !== path.dirname(dir)) {",
    "      dir = path.dirname(dir);",
    "      const pkg = path.join(dir, 'package.json');",
    "      if (fs.existsSync(pkg)) {",
    "        try { return JSON.parse(fs.readFileSync(pkg, 'utf8')).type === 'module' ? 'esm' : 'cjs'; } catch {}",
    "        break;",
    "      }",
    "    }",
    "  }",
    "  return 'unknown';",
    "}",
    "for (const name of pkgs) {",
    "  const row = { packageName: name, probeType: 'package', ok: false };",
    "  try {",
    "    const requireResolved = requireFromWorkspace.resolve(name);",
    "    row.require = { ok: true, resolved: requireResolved, format: inferFormat(requireResolved) };",
    "  } catch (e) {",
    "    row.require = { ok: false, error: e && e.message ? e.message : String(e) };",
    "  }",
    "  try {",
    "    const importResolved = await import.meta.resolve(name);",
    "    const mod = await import(name);",
    "    const namedExports = Object.keys(mod).filter((key) => key !== 'default').slice(0, 100);",
    "    row.import = { ok: true, resolved: importResolved, format: inferFormat(importResolved), namedExports, hasDefault: Object.prototype.hasOwnProperty.call(mod, 'default') };",
    "    const staticNames = namedExports.filter((key) => /^[$A-Z_a-z][$\\w]*$/.test(key)).slice(0, 40);",
    "    if (staticNames.length > 0) {",
    "      const staticProbe = path.join(probeDir, `static-${Buffer.from(name).toString('base64url')}.mjs`);",
    "      fs.writeFileSync(staticProbe, `import { ${staticNames.join(', ')} } from ${JSON.stringify(name)};\\nconsole.log('ok');\\n`);",
    "      const child = spawnSync(runtimeExecutable, [staticProbe], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    "      row.staticNamedImport = child.status === 0 ? { ok: true, tested: staticNames, runtime: 'bun', executable: runtimeExecutable } : { ok: false, tested: staticNames, runtime: 'bun', executable: runtimeExecutable, error: (child.stderr || child.stdout || `exit ${child.status}`).trim() };",
    "      const testProbe = path.join(probeDir, `static-${Buffer.from(name).toString('base64url')}.test.ts`);",
    "      fs.writeFileSync(testProbe, `import { test, expect } from 'bun:test';\\nimport { ${staticNames.join(', ')} } from ${JSON.stringify(name)};\\ntest('static named imports from ${name.replace(/'/g, \"\\\\'\")}', () => { expect(typeof ${staticNames[0]}).not.toBe('undefined'); });\\n`);",
    "      const testChild = spawnSync(runtimeExecutable, ['test', testProbe], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    "      row.bunTestStaticNamedImport = testChild.status === 0 ? { ok: true, tested: staticNames, runtime: 'bun:test', executable: runtimeExecutable } : { ok: false, tested: staticNames, runtime: 'bun:test', executable: runtimeExecutable, error: (testChild.stderr || testChild.stdout || `exit ${testChild.status}`).trim() };",
    "    } else {",
    "      row.staticNamedImport = { ok: true, tested: [], runtime: 'bun', executable: runtimeExecutable };",
    "      row.bunTestStaticNamedImport = { ok: true, tested: [], runtime: 'bun:test', executable: runtimeExecutable };",
    "    }",
  "  } catch (e) {",
    "    row.import = { ok: false, error: e && e.message ? e.message : String(e) };",
    "    row.staticNamedImport = { ok: false, error: row.import.error };",
    "    row.bunTestStaticNamedImport = { ok: false, error: row.import.error };",
    "  }",
    "  row.ok = Boolean(row.import?.ok || row.require?.ok);",
    "  row.resolved = row.import?.resolved || row.require?.resolved;",
    "  row.format = row.import?.format || row.require?.format || 'unknown';",
    "  if (!row.ok) row.error = row.import?.error || row.require?.error || 'resolution failed';",
    "  out.push(row);",
    "}",
    "function moduleImportSpecifier(specifier) {",
    "  if (specifier.startsWith('./')) return new URL(specifier.slice(2), pathToFileURL(process.cwd() + '/')).href;",
    "  if (specifier.startsWith('src/')) return new URL(specifier, pathToFileURL(process.cwd() + '/')).href;",
    "  return specifier;",
    "}",
    "for (const entry of modules) {",
    "  const specifier = String(entry.specifier || '');",
    "  const importSpecifier = moduleImportSpecifier(specifier);",
    "  const requestedExports = Array.isArray(entry.exports) ? entry.exports : [];",
    "  const row = { packageName: specifier, specifier, probeType: 'module', ok: false, requestedExports };",
    "  try {",
    "    const importResolved = await import.meta.resolve(importSpecifier);",
    "    const mod = await import(importSpecifier);",
    "    const namedExports = Object.keys(mod).filter((key) => key !== 'default').slice(0, 200);",
    "    const missingExports = requestedExports.filter((key) => !Object.prototype.hasOwnProperty.call(mod, key));",
    "    row.import = { ok: true, resolved: importResolved, format: inferFormat(importResolved), namedExports, hasDefault: Object.prototype.hasOwnProperty.call(mod, 'default') };",
    "    row.resolved = importResolved;",
    "    row.format = row.import.format;",
    "    row.missingExports = missingExports;",
    "    const staticNames = (requestedExports.length > 0 ? requestedExports : namedExports).filter((key) => /^[$A-Z_a-z][$\\w]*$/.test(key)).slice(0, 50);",
    "    if (staticNames.length > 0) {",
    "      const staticProbe = path.join(probeDir, `module-${Buffer.from(specifier).toString('base64url')}.mjs`);",
    "      fs.writeFileSync(staticProbe, `import { ${staticNames.join(', ')} } from ${JSON.stringify(importSpecifier)};\\nconsole.log('ok');\\n`);",
    "      const child = spawnSync(runtimeExecutable, [staticProbe], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    "      row.staticNamedImport = child.status === 0 ? { ok: true, tested: staticNames, runtime: 'bun', executable: runtimeExecutable } : { ok: false, tested: staticNames, runtime: 'bun', executable: runtimeExecutable, error: (child.stderr || child.stdout || `exit ${child.status}`).trim() };",
    "      const testProbe = path.join(probeDir, `module-${Buffer.from(specifier).toString('base64url')}.test.ts`);",
    "      fs.writeFileSync(testProbe, `import { test, expect } from 'bun:test';\\nimport { ${staticNames.join(', ')} } from ${JSON.stringify(importSpecifier)};\\ntest('static named imports from ${specifier.replace(/'/g, \"\\\\'\")}', () => { expect(typeof ${staticNames[0]}).not.toBe('undefined'); });\\n`);",
    "      const testChild = spawnSync(runtimeExecutable, ['test', testProbe], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });",
    "      row.bunTestStaticNamedImport = testChild.status === 0 ? { ok: true, tested: staticNames, runtime: 'bun:test', executable: runtimeExecutable } : { ok: false, tested: staticNames, runtime: 'bun:test', executable: runtimeExecutable, error: (testChild.stderr || testChild.stdout || `exit ${testChild.status}`).trim() };",
    "    } else {",
    "      row.staticNamedImport = { ok: true, tested: [], runtime: 'bun', executable: runtimeExecutable };",
    "      row.bunTestStaticNamedImport = { ok: true, tested: [], runtime: 'bun:test', executable: runtimeExecutable };",
    "    }",
    "    row.ok = missingExports.length === 0 && row.staticNamedImport?.ok !== false && row.bunTestStaticNamedImport?.ok !== false;",
    "    if (!row.ok) row.error = missingExports.length > 0 ? `missing exports: ${missingExports.join(', ')}` : (row.bunTestStaticNamedImport?.error || row.staticNamedImport?.error || 'module probe failed');",
    "  } catch (e) {",
    "    row.import = { ok: false, error: e && e.message ? e.message : String(e) };",
    "    row.staticNamedImport = { ok: false, error: row.import.error };",
    "    row.bunTestStaticNamedImport = { ok: false, error: row.import.error };",
    "    row.error = row.import.error;",
    "  }",
    "  out.push(row);",
    "}",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  await fs.writeFile(probeFile, script, "utf8");

  const result = await runSpawn(
    "bun",
    [probeFile, JSON.stringify({ packages, modules })],
    {
      ...buildToolchainEnv(toolchain.pathPrefix ?? [], { PATH: process.env.PATH }),
      ...jobEnv,
    } as Record<string, string>,
    workdir,
    30_000,
    200_000,
    () => {},
    { cleanNodeEnv: true }
  );
  if (result.code !== 0) {
    return packages.map((packageName) => ({
      packageName,
      ok: false,
      error: redactText(result.stderr || result.stdout || "resolution probe failed", envSecrets),
    }));
  }
  try {
    return JSON.parse(result.stdout) as ResolutionProbeResult[];
  } catch {
    return packages.map((packageName) => ({
      packageName,
      ok: false,
      error: "resolution probe returned invalid JSON",
    }));
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) return;
  const cfg = getConfig();
  const rt = getRuntime(jobId);
  if (!rt) return;

  // Per-job environment variables (first-class env injection). In-memory only;
  // values are scrubbed from captured logs via envSecrets below.
  const jobEnv: Record<string, string> = rt.env ?? {};
  const envSecrets = Object.entries(jobEnv)
    .filter(([key, value]) => {
      if (typeof value !== "string" || value.length < 8) return false;
      if (/^(?:true|false|null|undefined|mock|fork|mainnet|devnet|live_tiny|live_degen|dry_run)$/i.test(value)) return false;
      if (/^(?:PURR_ENV|PURR_PROFILE|PURR_ARMED|PURR_EMERGENCY_STOP|PURR_HARD_STOP|PURR_MAX_OPEN_POSITIONS|PURR_MAX_POSITION_USD|PURR_DAILY_LOSS_CAP_USD|PURR_MAX_MAINNET_SLIPPAGE_BPS)$/i.test(key)) return false;
      return true;
    })
    .map(([, value]) => value);
  const resolutionProbePackages = rt.resolutionProbePackages ?? [];
  const resolutionProbeModules = rt.resolutionProbeModules ?? [];

  const startedAt = nowIso();
  const startMs = Date.now();
  const timeoutPolicy = job.timeoutPolicy ?? {
    longRun: false,
    commandTimeoutMs: cfg.commandTimeoutMs,
    jobTimeoutMs: cfg.jobTimeoutMs,
    maxLongRunTimeoutMs: 9 * 60 * 60 * 1000,
  };
  updateJob(jobId, { status: "running", startedAt });

  // Job-level timeout.
  rt.jobTimer = setTimeout(() => {
    void terminateRuntimeProcesses(jobId);
    const j = getJob(jobId);
    if (j && (j.status === "running")) {
      finalize(jobId, "timeout", `Job exceeded timeout (${timeoutPolicy.jobTimeoutMs} ms)`);
    }
  }, timeoutPolicy.jobTimeoutMs);

  const workspaceName = `${jobId}-${randomUUID().slice(0, 8)}`;
  const workdir = path.join(cfg.workdirBase, workspaceName);
  const cacheDir = path.join(cfg.workdirBase, `${workspaceName}-cache`);

  try {
    // Validate inputs again (defense in depth).
    if (!isRepoAllowed(job.repo)) {
      finalize(jobId, "failed", `Repo not allowed: ${job.repo}`);
      return;
    }
    if (!isValidRef(job.ref)) {
      finalize(jobId, "failed", `Invalid ref: ${job.ref}`);
      return;
    }
    if (job.expected_head && !isValidHead(job.expected_head)) {
      finalize(jobId, "failed", `Invalid expected_head: ${job.expected_head}`);
      return;
    }

    await fs.mkdir(cfg.workdirBase, { recursive: true });

    // Clone. Pass the per-request GitHub token (github_passthrough mode) so
    // private repos can be cloned with the caller's PAT. Falls back to env
    // GITHUB_TOKEN inside buildCloneUrl when undefined.
    const clone = await cloneRepo(job.repo, job.ref, workdir, rt.githubToken ?? undefined);
    if (!clone.ok) {
      finalize(jobId, "failed", clone.error || "git clone failed");
      return;
    }
    const actualHead = clone.head || "";
    updateJob(jobId, { actual_head: actualHead });

    // Verify expected head.
    if (job.expected_head) {
      const eh = job.expected_head.toLowerCase();
      const ah = actualHead.toLowerCase();
      const matchesShort = ah.startsWith(eh) || eh.startsWith(ah.slice(0, Math.min(eh.length, ah.length)));
      const matchesFull = ah === eh || ah.startsWith(eh);
      if (!(matchesShort || matchesFull)) {
        finalize(
          jobId,
          "failed",
          `HEAD mismatch: expected ${job.expected_head} but got ${actualHead.slice(0, 12)}`
        );
        return;
      }
    }

    const toolchain = await prepareToolchain(workdir);
    const toolchainPublic = publicToolchain(toolchain);
    updateJob(jobId, {
      toolchain: toolchainPublic,
      runnerRecommendations: uniqueStrings([
        ...toolchain.recommendations,
        ...commandWorkflowRecommendations(job.commands.map((cmd) => cmd.command)),
      ]),
    });
    const jobCacheEnv: Record<string, string> = {
      BUN_INSTALL_CACHE_DIR: process.env.PURR_VERIFY_BUN_CACHE_DIR || process.env.BUN_INSTALL_CACHE_DIR || path.join(cacheDir, "bun"),
      npm_config_cache: process.env.PURR_VERIFY_NPM_CACHE_DIR || process.env.npm_config_cache || path.join(cacheDir, "npm"),
      XDG_CACHE_HOME: process.env.PURR_VERIFY_XDG_CACHE_HOME || process.env.XDG_CACHE_HOME || path.join(cacheDir, "xdg"),
    };

    // Check cancel before running commands.
    if (rt.cancelRequested) {
      finalize(jobId, "canceled", "canceled before commands");
      return;
    }

    // Run commands sequentially.
    let failed = false;
    let failedCommand: string | null = null;
    const installStrategies: InstallStrategy[] = [];
    let resolutionProbeDone = false;

    for (let i = 0; i < job.commands.length; i++) {
      const cmd = job.commands[i];
      const commandStr = cmd.command;
      const rt2 = getRuntime(jobId);
      if (rt2?.cancelRequested) {
        // mark remaining as skipped
        for (let k = i; k < job.commands.length; k++) {
          updateCommand(jobId, k, { status: "skipped" });
        }
        finalize(jobId, "canceled", "canceled during run");
        return;
      }

      const cmdStart = nowIso();
      const cmdStartMs = Date.now();
      updateCommand(jobId, i, { status: "running", startedAt: cmdStart });

      const strategy = await installStrategy(workdir, commandStr);
      if (strategy.mode !== "not-install") {
        installStrategies.push(strategy);
        updateJob(jobId, { installStrategies: [...installStrategies] });
      }
      const effectiveCommandStr = strategy.effectiveCommand;
      const parsedRaw = parseCommand(effectiveCommandStr);
      const normalized = normalizeBunx(parsedRaw.program, parsedRaw.args);
      const parsed = {
        ...parsedRaw,
        program: normalized.program,
        args: normalized.args,
      };
      const isolatedTest = normalizeTestCommand(parsed.program, parsed.args);
      parsed.program = isolatedTest.program;
      parsed.args = isolatedTest.args;
      let result: {
        code: number | null;
        stdout: string;
        stderr: string;
        truncated: boolean;
        timedOut: boolean;
      };

      if (parsed.readFile) {
        // `cat reports/<file>` -> read directly.
        const filePath = path.join(workdir, parsed.readFile);
        try {
          if (!existsSync(filePath)) {
            result = { code: 1, stdout: "", stderr: `File not found: ${parsed.readFile}`, truncated: false, timedOut: false };
          } else {
            const stat = await fs.stat(filePath);
            let content = await fs.readFile(filePath, "utf8");
            let truncated = false;
            if (Buffer.byteLength(content, "utf8") > cfg.maxLogBytes) {
              content = Buffer.from(content, "utf8").slice(0, cfg.maxLogBytes).toString("utf8");
              truncated = true;
            }
            result = { code: 0, stdout: content, stderr: `(${stat.size} bytes)`, truncated, timedOut: false };
          }
        } catch (e) {
          result = { code: 1, stdout: "", stderr: `Failed to read ${parsed.readFile}: ${(e as Error).message}`, truncated: false, timedOut: false };
        }
      } else if (parsed.program === "surfpool" && parsed.args.length === 1 && parsed.args[0] === "start") {
        result = await runBackgroundSpawn(
          parsed.program,
          parsed.args,
          repoCommandEnv(
            toolchain,
            jobCacheEnv,
            jobEnv,
            parsed.env
          ),
          workdir,
          cfg.maxLogBytes,
          (child) => {
            const rt3 = getRuntime(jobId);
            if (rt3) {
              rt3.currentChild = child;
              rt3.backgroundChildren = [...(rt3.backgroundChildren ?? []), child];
            }
          },
          {
            cleanNodeEnv: true,
            onStdout: (stdout, truncated) => updateCommand(jobId, i, { stdout: redactText(stdout, envSecrets), truncated }),
            onStderr: (stderr, truncated) => updateCommand(jobId, i, { stderr: redactText(stderr, envSecrets), truncated }),
          }
        );
        const rt3 = getRuntime(jobId);
        if (rt3) rt3.currentChild = null;
        if (result.code === 0) {
          result.stdout = [
            "[runner] background process started: surfpool start",
            result.stdout.trim(),
          ].filter(Boolean).join("\n");
        }
      } else {
        // Merge job-level env with any inline ENV=VALUE prefix parsed from the
        // command (inline values win). cleanNodeEnv ensures module resolution
        // uses only the isolated workspace's node_modules.
        result = await runSpawn(
          parsed.program,
          parsed.args,
          repoCommandEnv(
            toolchain,
            jobCacheEnv,
            jobEnv,
            parsed.env
          ),
          workdir,
          timeoutPolicy.commandTimeoutMs,
          cfg.maxLogBytes,
          (child) => {
            const rt3 = getRuntime(jobId);
            if (rt3) rt3.currentChild = child;
          },
          {
            cleanNodeEnv: true,
            onStdout: (stdout, truncated) => updateCommand(jobId, i, { stdout: redactText(stdout, envSecrets), truncated }),
            onStderr: (stderr, truncated) => updateCommand(jobId, i, { stderr: redactText(stderr, envSecrets), truncated }),
          }
        );
        const rt3 = getRuntime(jobId);
        if (rt3) rt3.currentChild = null;
      }

      if (
        result.code !== 0 &&
        !result.timedOut &&
        strategy.mode !== "not-install" &&
        /Fail extracting tarball|failed to extract|ECONNRESET|ETIMEDOUT|fetch failed|network error/i.test(`${result.stdout}\n${result.stderr}`)
      ) {
        const retryCache = path.join(cacheDir, "bun-retry");
        const retry = await runSpawn(
          parsed.program,
          parsed.args,
          repoCommandEnv(toolchain, jobCacheEnv, jobEnv, parsed.env, { BUN_INSTALL_CACHE_DIR: retryCache }),
          workdir,
          timeoutPolicy.commandTimeoutMs,
          cfg.maxLogBytes,
          (child) => {
            const rt3 = getRuntime(jobId);
            if (rt3) rt3.currentChild = child;
          },
          {
            cleanNodeEnv: true,
            onStdout: (stdout, truncated) => updateCommand(jobId, i, { stdout: redactText(stdout, envSecrets), truncated }),
            onStderr: (stderr, truncated) => updateCommand(jobId, i, { stderr: redactText(stderr, envSecrets), truncated }),
          }
        );
        const rt3 = getRuntime(jobId);
        if (rt3) rt3.currentChild = null;
        retry.stdout = [
          "[runner] transient install failure detected; retried once with a fresh Bun cache.",
          retry.stdout,
        ].filter(Boolean).join("\n");
        result = retry;
      }

      const cmdEndMs = Date.now();
      const durationMs = cmdEndMs - cmdStartMs;
      const status = result.timedOut
        ? "timeout"
        : result.code === 0
        ? "success"
        : "failed";

      const stdoutRed = redactText(result.stdout, envSecrets);
      let stderrRed = redactText(result.stderr, envSecrets);

      if (status === "failed") {
        const diagnostic = await runFailureDiagnostics({
          commandStr,
          parsedProgram: parsed.program,
          parsedArgs: parsed.args,
          parsedEnv: parsed.env,
          workdir,
          toolchain,
          jobCacheEnv,
          jobEnv,
          envSecrets,
          commandTimeoutMs: timeoutPolicy.commandTimeoutMs,
          maxLogBytes: cfg.maxLogBytes,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        if (diagnostic) {
          stderrRed = [stderrRed.trim(), diagnostic].filter(Boolean).join("\n\n");
        }
      }

      updateCommand(jobId, i, {
        effectiveCommand: commandLine(parsed.program, parsed.args),
        status,
        exitCode: result.code,
        durationMs,
        stdout:
          strategy.mode !== "not-install"
            ? [
                `[runner] install mode: ${strategy.mode}; lockfile: ${strategy.lockfile ?? "none"}; lockfile honored: ${strategy.lockfileHonored}`,
                `[runner] toolchain: node ${toolchain.nodeVersion}; bun ${toolchain.bunVersion ?? "unavailable"}`,
                stdoutRed,
              ].filter(Boolean).join("\n")
            : stdoutRed,
        stderr: stderrRed,
        truncated: result.truncated,
        installStrategy: strategy.mode !== "not-install" ? strategy : undefined,
        finishedAt: nowIso(),
      });

      if (
        status === "success" &&
        strategy.mode !== "not-install" &&
        (resolutionProbePackages.length > 0 || resolutionProbeModules.length > 0) &&
        !resolutionProbeDone
      ) {
        resolutionProbeDone = true;
        const probe = await runResolutionProbe(workdir, resolutionProbePackages, resolutionProbeModules, toolchain, jobEnv, envSecrets);
        updateJob(jobId, { resolutionProbe: probe });
      }

      if (status !== "success") {
        failed = true;
        failedCommand = commandStr;
        if (!job.continue_on_error) {
          // mark remaining as skipped
          for (let k = i + 1; k < job.commands.length; k++) {
            updateCommand(jobId, k, { status: "skipped" });
          }
          break;
        }
      }
    }

    if (rt.cancelRequested) {
      finalize(jobId, "canceled", "canceled");
      return;
    }

    const finalStatus: JobStatus = failed ? "failed" : "success";
    finalize(jobId, finalStatus, failed ? `Command failed: ${failedCommand}` : null, failedCommand);
  } catch (e) {
    finalize(jobId, "failed", `Executor error: ${(e as Error).message}`);
  } finally {
    const cleanupStartedAt = nowIso();
    updateJob(jobId, {
      cleanupStatus: "running",
      cleanup: {
        status: "running",
        startedAt: cleanupStartedAt,
        finishedAt: null,
      },
    });
    await terminateRuntimeProcesses(jobId, 1000);
    clearRuntime(jobId);
    const cleanup = await cleanupJobDirectories(workdir, cacheDir);
    if (getJob(jobId)) {
      updateJob(jobId, {
        cleanupStatus: cleanup.status,
        cleanup,
      });
      await flushJobPersistence(jobId);
    }
  }
}

function updateCommand(jobId: string, index: number, patch: Partial<CommandResult>): void {
  const job = getJob(jobId);
  if (!job) return;
  const cmd = job.commands[index];
  if (!cmd) return;
  Object.assign(cmd, patch);
  // Light-touch persist handled by periodic flush; to be safe, persist here too.
  void updateJob(jobId, {});
}

function finalize(
  jobId: string,
  status: JobStatus,
  error: string | null,
  failedCommand: string | null = null
): void {
  const job = getJob(jobId);
  if (!job) return;
  if (
    job.finishedAt &&
    (job.status === "success" || job.status === "failed" || job.status === "canceled" || job.status === "timeout")
  ) {
    return;
  }
  const finishedAt = nowIso();
  const startMs = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
  const durationMs = Date.now() - startMs;
  const passed = status === "success";
  const summary = {
    passed,
    failedCommand: failedCommand ?? (passed ? null : (job.commands.find((c) => c.status === "failed" || c.status === "timeout")?.command ?? null)),
  };
  // If the job reached a terminal state without running all commands (e.g.,
  // clone failure, HEAD mismatch, cancel before commands, invalid repo/ref),
  // mark any still-pending commands as skipped so the UI doesn't show them
  // as "waiting to run" forever. Running commands are left alone because
  // their close handler may still update them.
  let commandsChanged = false;
  for (const c of job.commands) {
    if (c.status === "pending") {
      c.status = "skipped";
      commandsChanged = true;
    }
  }
  updateJob(jobId, {
    status,
    finishedAt,
    durationMs,
    error,
    summary,
    ...(commandsChanged ? { commands: [...job.commands] } : {}),
  });
  // Fire webhook callback if configured.
  if (job.callback_url) {
    void fireCallback(job.callback_url, jobId);
  }
}

// Redact a callback URL for safe storage in delivery history.
// Strips the query string (which often contains tokens) and masks any
// embedded userinfo (user:password@ or token@). If URL parsing fails,
// returns the original value as-is.
function redactCallbackUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Attempt a single webhook POST. Records the outcome as a WebhookDelivery
// entry on the job (via updateJob). Returns true on success (2xx response),
// false otherwise.
async function attemptDelivery(
  jobId: string,
  url: string,
  redactedUrl: string,
  attempt: number,
  payload: Record<string, unknown>
): Promise<boolean> {
  const sentAt = nowIso();
  const startMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let status: WebhookDelivery["status"] = "failed";
  let statusCode: number | null = null;
  let errorMsg: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    statusCode = res.status;
    if (res.ok) {
      status = "success";
    } else {
      status = "failed";
      errorMsg = `HTTP ${res.status} ${res.statusText}`.trim();
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      status = "timeout";
      errorMsg = "request timed out (>5s)";
    } else {
      status = "failed";
      errorMsg = err.message || "network error";
    }
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - startMs;
  const delivery: WebhookDelivery = {
    attempt,
    url: redactedUrl,
    status,
    statusCode,
    sentAt,
    durationMs,
    error: errorMsg,
  };
  // Append to job.webhookDeliveries (best-effort; never throw).
  try {
    const job = getJob(jobId);
    if (job) {
      const existing = job.webhookDeliveries ?? [];
      updateJob(jobId, { webhookDeliveries: [...existing, delivery] });
    }
  } catch {
    // ignore persistence failures
  }
  return status === "success";
}

async function fireCallback(url: string, jobId: string): Promise<void> {
  try {
    const job = getJob(jobId);
    if (!job) return;
    // Validate URL is https or http (no file:// etc).
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (!["https:", "http:"].includes(parsed.protocol)) return;

    // Send a lightweight POST with the job result (redacted).
    const payload = {
      event: "job_completed",
      jobId: job.jobId,
      repo: job.repo,
      ref: job.ref,
      status: job.status,
      durationMs: job.durationMs,
      summary: job.summary,
      error: job.error,
      finishedAt: job.finishedAt,
      statusUrl: `/api/verify/${job.jobId}`,
    };

    const redactedUrl = redactCallbackUrl(url);

    // First attempt; if it fails (network error OR non-2xx), retry up to 2
    // more times with exponential backoff (1s, 3s). Best-effort; never throw.
    const maxAttempts = 3;
    const backoffMs = [0, 1000, 3000];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Wait before retry (no wait on first attempt).
      if (attempt > 1) {
        await sleep(backoffMs[attempt - 1] ?? 3000);
      }
      // Re-check job still exists.
      if (!getJob(jobId)) return;
      const ok = await attemptDelivery(jobId, url, redactedUrl, attempt, payload);
      if (ok) return;
    }
  } catch {
    // Best-effort; never block or fail the job.
  }
}

// Manually re-fire the webhook for a job. Used by the "Retry webhook" button
// in the UI. Returns the result of the single attempt (does NOT auto-retry
// — the user can click retry again if it fails). The delivery is logged in
// the job's webhookDeliveries history with an `attempt` counter that
// continues from the previous max (so the manual attempt is distinguishable
// from the automatic ones).
export async function retryCallback(jobId: string): Promise<{
  ok: boolean;
  status: "success" | "failed" | "timeout";
  statusCode: number | null;
  error: string | null;
  attempt: number;
}> {
  await loadPersisted();
  const job = getJob(jobId);
  if (!job) {
    return { ok: false, status: "failed", statusCode: null, error: "job not found", attempt: 0 };
  }
  if (!job.callback_url) {
    return { ok: false, status: "failed", statusCode: null, error: "no callback_url on job", attempt: 0 };
  }
  let parsed: URL;
  try {
    parsed = new URL(job.callback_url);
  } catch {
    return { ok: false, status: "failed", statusCode: null, error: "invalid callback_url", attempt: 0 };
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    return { ok: false, status: "failed", statusCode: null, error: "unsupported protocol", attempt: 0 };
  }

  const payload = {
    event: "job_completed",
    jobId: job.jobId,
    repo: job.repo,
    ref: job.ref,
    status: job.status,
    durationMs: job.durationMs,
    summary: job.summary,
    error: job.error,
    finishedAt: job.finishedAt,
    statusUrl: `/api/verify/${job.jobId}`,
    manualRetry: true,
  };

  const redactedUrl = redactCallbackUrl(job.callback_url);
  const prevAttempts = job.webhookDeliveries?.length ?? 0;
  const attemptNum = prevAttempts + 1;

  const ok = await attemptDelivery(jobId, job.callback_url, redactedUrl, attemptNum, payload);
  const updated = getJob(jobId);
  const lastDelivery = updated?.webhookDeliveries?.[updated.webhookDeliveries.length - 1];
  return {
    ok,
    status: lastDelivery?.status ?? "failed",
    statusCode: lastDelivery?.statusCode ?? null,
    error: lastDelivery?.error ?? null,
    attempt: attemptNum,
  };
}

// ---- Scheduler / queue ----

export async function ensureScheduler(): Promise<void> {
  await loadPersisted();
  if (schedulerRunning) return;
  await sweepOrphanWorkspaces(true);
  schedulerRunning = true;
  // Loop forever, draining the queue subject to concurrency.
  // Use setImmediate to yield between iterations.
  const tick = () => {
    void drain().then(() => {
      setTimeout(tick, 1000);
    });
  };
  tick();
}

async function drain(): Promise<void> {
  const cfg = getConfig();
  const all = listJobs(500);
  const running = all.filter((j) => j.status === "running").length;
  const queued = all.filter((j) => j.status === "queued");
  let slots = cfg.maxConcurrentJobs - running;
  for (const job of queued) {
    if (slots <= 0) break;
    slots--;
    // Mark running immediately to avoid double-start.
    setJobStatus(job.jobId, "running");
    // Fire and forget; runJob manages its own lifecycle.
    void runJob(job.jobId).catch(() => {
      finalize(job.jobId, "failed", "Unhandled executor error");
    });
  }
  trimOldJobs();
  void sweepOrphanWorkspaces();
}

export interface CreateJobInput {
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
   * Forwarded to createJob → runtime (in-memory, never persisted). The
   * executor uses it to clone private repos; redact.ts scrubs it from any
   * captured stderr.
   */
  githubToken?: string;
  /**
   * Optional per-job environment variables injected into every command's
   * process environment. In-memory only (never persisted); values are redacted
   * from captured logs. Validated in mcp.validateEnv.
   */
  env?: Record<string, string>;
  resolutionProbePackages?: string[];
  resolutionProbeModules?: ResolutionProbeModuleRequest[];
  timeoutPolicy?: Job["timeoutPolicy"];
  execution?: Job["execution"];
}

export async function enqueueJob(input: CreateJobInput): Promise<Job> {
  await loadPersisted();
  const job = createJob(input);
  await flushJobPersistence(job.jobId);
  void ensureScheduler();
  return job;
}

/**
 * Run a verification job synchronously (inline within the caller's request).
 *
 * Unlike `enqueueJob` (which queues the job for the background scheduler),
 * this function:
 *   1. Creates the job record (status = "queued").
 *   2. Immediately marks it as "running" so the background scheduler does NOT
 *      pick it up (the scheduler only drains "queued" jobs).
 *   3. Calls `runJob(jobId)` directly and awaits completion.
 *   4. Returns the final job state (success / failed / timeout / canceled).
 *
 * The workspace is always cleaned up in `runJob`'s finally block, so
 * `cleanupStatus` will be "done" by the time this returns.
 *
 * Respects COMMAND_TIMEOUT_MS (per-command) and JOB_TIMEOUT_MS (overall job)
 * via the timers set inside `runJob`. If the job exceeds JOB_TIMEOUT_MS, it
 * is finalized with status "timeout".
 *
 * This is used by `POST /api/verify?mode=sync` and MCP
 * `create_verification_job` with `mode: "sync"`.
 *
 * NOTE: We intentionally do NOT call `ensureScheduler()` here. The scheduler
 * internally calls `loadPersisted()`, which can race with `createJob` and
 * delete the newly created job (which hasn't been persisted to disk yet)
 * before `runJob` picks it up. The scheduler is started separately by the
 * async endpoints and the health check.
 */
export async function runJobSync(input: CreateJobInput): Promise<Job> {
  await loadPersisted();
  const job = createJob(input);
  await flushJobPersistence(job.jobId);
  // Mark running immediately to prevent the background scheduler from also
  // picking up this job on its next drain tick (1s interval). The scheduler
  // only drains jobs with status "queued".
  setJobStatus(job.jobId, "running");
  // Run the job inline and wait for it to fully complete (including cleanup).
  try {
    await runJob(job.jobId);
  } catch {
    // runJob's finally block always finalizes + cleans up, but if something
    // unexpected throws before the finally, ensure the job is marked failed.
    const cur = getJob(job.jobId);
    if (cur && (cur.status === "running" || cur.status === "queued")) {
      finalize(job.jobId, "failed", "Sync executor error");
    }
  }
  const final = getJob(job.jobId);
  // final is guaranteed to exist because we created it above and runJob
  // never deletes jobs. Fall back to the original job object as a safety net.
  return final ?? job;
}

// Update the tags array on a stored job. Returns the updated job or null if
// the job does not exist. Persists the change to disk (best-effort).
export async function updateJobTags(jobId: string, tags: string[]): Promise<Job | null> {
  await loadPersisted();
  const updated = updateJob(jobId, { tags });
  return updated ?? null;
}

export function requestCancel(jobId: string): boolean {
  const job = getJob(jobId);
  if (!job) return false;
  if (job.status !== "running" && job.status !== "queued") return false;
  const rt = getRuntime(jobId);
  if (rt) {
    rt.cancelRequested = true;
    void terminateRuntimeProcesses(jobId);
  }
  if (job.status === "queued") {
    // Queued jobs can be canceled immediately.
    finalize(jobId, "canceled", "canceled while queued");
  } else {
    updateJob(jobId, { error: "cancel requested" });
  }
  void flushJobPersistence(jobId);
  return true;
}
