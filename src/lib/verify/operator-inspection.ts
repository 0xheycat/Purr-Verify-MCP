import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeGitRemote } from "./operator-sanitize";
import type {
  DeploymentPlan,
  DeploymentPlanInput,
  DeploymentStrategy,
  DiscoveredProject,
  DockerRuntimeService,
  EnvironmentEntry,
  EnvironmentInspection,
  EnvironmentObservation,
  EnvironmentSourceName,
  GitInspection,
  PackageManagerName,
  Pm2RuntimeService,
  ProcessRuntime,
  ProjectInspection,
  ProjectMarker,
  RuntimeInspection,
  RuntimeToolState,
  SystemdRuntimeService,
} from "./operator-types";

const DEFAULT_DISCOVERY_ROOTS = [
  "/opt",
  "/srv",
  "/var/www",
  "/home",
  "/root",
  "/mnt",
  "/data",
  "/var/lib",
  "/usr/local",
  "/workspace",
  "/tmp",
];
const PROJECT_MARKERS: ProjectMarker[] = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "ecosystem.config.js",
  "ecosystem.config.cjs",
  "ecosystem.config.mjs",
];
const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const PM2_FILES = ["ecosystem.config.js", "ecosystem.config.cjs", "ecosystem.config.mjs"];
const MANIFEST_FILES = [".purr-deploy.json", ".purr-verify.json", "purr.config.json"];
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".cache",
  ".turbo",
  ".venv",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  "coverage",
  "releases",
  "backups",
]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface CommandOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
}

interface DiscoverInput {
  roots?: string[];
  maxDepth?: number;
  maxProjects?: number;
  includeNested?: boolean;
}

interface InspectEnvironmentInput {
  sources?: EnvironmentSourceName[];
  keys?: string[];
  revealValues?: boolean;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string }) | null;
        resolve({
          ok: !error,
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
          exitCode: typeof err?.code === "number" ? err.code : error ? 1 : 0,
          error: error ? error.message : null,
        });
      }
    );
  });
}

async function readSmallFile(filePath: string, maxBytes = 1024 * 1024): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await readSmallFile(filePath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function relatedPath(projectRoot: string, candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const normalized = path.resolve(candidate);
  return isInside(projectRoot, normalized);
}

export async function canonicalDirectory(cwd: string): Promise<{
  requestedPath: string;
  canonicalPath: string;
  symlink: boolean;
}> {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const requestedPath = path.resolve(cwd);
  const linkStat = await fs.lstat(requestedPath).catch(() => null);
  if (!linkStat) throw new Error(`cwd does not exist: ${requestedPath}`);
  const canonicalPath = await fs.realpath(requestedPath);
  const stat = await fs.stat(canonicalPath);
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${requestedPath}`);
  return { requestedPath, canonicalPath, symlink: linkStat.isSymbolicLink() };
}

function markersFromNames(names: Set<string>): ProjectMarker[] {
  return PROJECT_MARKERS.filter((marker) => names.has(marker));
}

function detectPackageManagerFromNames(
  names: Set<string>,
  packageManagerDeclaration?: string | null
): PackageManagerName {
  if (names.has("bun.lock") || names.has("bun.lockb")) return "bun";
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("package-lock.json") || names.has("npm-shrinkwrap.json")) return "npm";
  const declaration = packageManagerDeclaration?.trim().toLowerCase() ?? "";
  if (declaration.startsWith("bun@")) return "bun";
  if (declaration.startsWith("pnpm@")) return "pnpm";
  if (declaration.startsWith("yarn@")) return "yarn";
  if (declaration.startsWith("npm@")) return "npm";
  if (names.has("package.json")) return "npm";
  return "unknown";
}

function detectProjectType(names: Set<string>, packageJson: Record<string, unknown> | null): string[] {
  const types: string[] = [];
  if (names.has("package.json")) types.push("node");
  if (names.has("Cargo.toml")) types.push("rust");
  if (names.has("pyproject.toml") || names.has("requirements.txt")) types.push("python");
  if (names.has("go.mod")) types.push("go");
  if (COMPOSE_FILES.some((name) => names.has(name))) types.push("docker_compose");
  const deps = {
    ...((packageJson?.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((packageJson?.devDependencies as Record<string, unknown> | undefined) ?? {}),
  };
  if ("next" in deps) types.push("nextjs");
  if ("vite" in deps) types.push("vite");
  if ("@nestjs/core" in deps) types.push("nestjs");
  if ("prisma" in deps || "@prisma/client" in deps) types.push("prisma");
  return uniqueStrings(types);
}

function envFileName(name: string): boolean {
  return /^\.env(?:\..+)?$/.test(name);
}

function exampleEnvFile(name: string): boolean {
  return /(?:\.example|\.sample|\.template)$/i.test(name);
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]] = value;
  }
  return out;
}

function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function parseAssignments(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) continue;
    const key = value.slice(0, index);
    if (!ENV_KEY_RE.test(key)) continue;
    out[key] = value.slice(index + 1);
  }
  return out;
}

function gitStatusFromPorcelain(output: string): Omit<GitInspection, "present" | "root" | "head" | "origin"> {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim() || null;
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim() || null;
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.startsWith("? ")) untracked++;
    else if (line.startsWith("u ")) conflicted++;
    else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(/\s+/)[1] ?? "..";
      if (xy[0] && xy[0] !== ".") staged++;
      if (xy[1] && xy[1] !== ".") modified++;
    }
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    conflicted,
    dirty: staged + modified + untracked + conflicted > 0,
  };
}

async function inspectGit(cwd: string): Promise<GitInspection> {
  const root = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    return {
      present: false,
      root: null,
      branch: null,
      head: null,
      origin: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicted: 0,
      dirty: false,
    };
  }
  const [head, origin, status] = await Promise.all([
    runCommand("git", ["-C", cwd, "rev-parse", "HEAD"]),
    runCommand("git", ["-C", cwd, "remote", "get-url", "origin"]),
    runCommand("git", ["-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=all"], {
      timeoutMs: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);
  const parsed = gitStatusFromPorcelain(status.stdout);
  return {
    present: true,
    root: root.stdout.trim() || cwd,
    head: head.ok ? head.stdout.trim() || null : null,
    origin: sanitizeGitRemote(origin.ok ? origin.stdout.trim() || null : null),
    ...parsed,
  };
}

function commandPrefix(manager: PackageManagerName): string {
  if (manager === "bun") return "bun run";
  if (manager === "pnpm") return "pnpm run";
  if (manager === "yarn") return "yarn";
  return "npm run";
}

function suggestedCommands(
  manager: PackageManagerName,
  scripts: Record<string, string>,
  names: Set<string>
): ProjectInspection["suggestedCommands"] {
  const install: string[] = [];
  if (manager === "bun") install.push(names.has("bun.lock") || names.has("bun.lockb") ? "bun install --frozen-lockfile" : "bun install");
  else if (manager === "pnpm") install.push("pnpm install --frozen-lockfile");
  else if (manager === "yarn") install.push("yarn install --immutable");
  else if (manager === "npm") install.push(names.has("package-lock.json") ? "npm ci" : "npm install");
  const prefix = commandPrefix(manager);
  const scriptCommand = (name: string) => `${prefix} ${name}`.trim();
  const verifyOrder = ["check", "typecheck", "lint", "test"];
  const verify = verifyOrder.filter((name) => name in scripts).map(scriptCommand);
  const build = "build" in scripts ? [scriptCommand("build")] : [];
  const start = "start" in scripts ? [scriptCommand("start")] : [];
  return { install, verify, build, start };
}

export async function discoverProjects(input: DiscoverInput = {}): Promise<{
  roots: string[];
  projects: DiscoveredProject[];
  truncated: boolean;
  limits: { maxDepth: number; maxProjects: number; includeNested: boolean };
}> {
  const configuredRoots = (process.env.PURR_OPERATOR_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const requestedRoots = input.roots?.length ? input.roots : configuredRoots.length ? configuredRoots : DEFAULT_DISCOVERY_ROOTS;
  const maxDepth = clampInteger(input.maxDepth, 5, 0, 16);
  const maxProjects = clampInteger(input.maxProjects, 250, 1, 2000);
  const includeNested = input.includeNested === true;
  const roots: string[] = [];
  const projects: DiscoveredProject[] = [];
  const visited = new Set<string>();
  const queue: Array<{ dir: string; depth: number; requested: string }> = [];

  for (const root of uniqueStrings(requestedRoots)) {
    if (!path.isAbsolute(root)) throw new Error(`discovery root must be absolute: ${root}`);
    try {
      const canonical = await fs.realpath(root);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) continue;
      roots.push(canonical);
      queue.push({ dir: canonical, depth: 0, requested: path.resolve(root) });
    } catch {
      // Missing roots are ignored so one absent standard directory does not block discovery.
    }
  }

  while (queue.length > 0 && projects.length < maxProjects) {
    const current = queue.shift()!;
    if (visited.has(current.dir)) continue;
    visited.add(current.dir);
    const entries = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.map((entry) => entry.name));
    const markers = markersFromNames(names);
    const packageJson = names.has("package.json")
      ? await readJsonFile(path.join(current.dir, "package.json"))
      : null;
    const declaration = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : null;
    const isProject = markers.length > 0;
    if (isProject) {
      const requestedStat = await fs.lstat(current.requested).catch(() => null);
      projects.push({
        path: current.requested,
        canonicalPath: current.dir,
        name:
          typeof packageJson?.name === "string" && packageJson.name.trim()
            ? packageJson.name.trim()
            : path.basename(current.dir),
        markers,
        packageManager: detectPackageManagerFromNames(names, declaration),
        projectType: detectProjectType(names, packageJson),
        symlink: requestedStat?.isSymbolicLink() ?? false,
      });
      if (!includeNested) continue;
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const requestedChild = path.join(current.requested, entry.name);
      try {
        const child = await fs.realpath(path.join(current.dir, entry.name));
        const stat = await fs.stat(child);
        if (!stat.isDirectory()) continue;
        queue.push({ dir: child, depth: current.depth + 1, requested: requestedChild });
      } catch {
        // Ignore unreadable or broken symlinks.
      }
    }
  }

  projects.sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath));
  return {
    roots,
    projects,
    truncated: queue.length > 0 || projects.length >= maxProjects,
    limits: { maxDepth, maxProjects, includeNested },
  };
}

export async function inspectProject(cwd: string): Promise<ProjectInspection> {
  const resolved = await canonicalDirectory(cwd);
  const entries = await fs.readdir(resolved.canonicalPath, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const packageJson = names.has("package.json")
    ? await readJsonFile(path.join(resolved.canonicalPath, "package.json"))
    : null;
  const packageManagerDeclaration =
    typeof packageJson?.packageManager === "string" ? packageJson.packageManager : null;
  const packageManager = detectPackageManagerFromNames(names, packageManagerDeclaration);
  const scriptsValue = packageJson?.scripts;
  const scripts =
    scriptsValue && typeof scriptsValue === "object" && !Array.isArray(scriptsValue)
      ? Object.fromEntries(
          Object.entries(scriptsValue as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : {};
  const enginesValue = packageJson?.engines;
  const engines =
    enginesValue && typeof enginesValue === "object" && !Array.isArray(enginesValue)
      ? Object.fromEntries(
          Object.entries(enginesValue as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : {};
  const workspacesValue = packageJson?.workspaces;
  const workspaces = Array.isArray(workspacesValue)
    ? workspacesValue.filter((value): value is string => typeof value === "string")
    : workspacesValue && typeof workspacesValue === "object" && Array.isArray((workspacesValue as { packages?: unknown }).packages)
      ? ((workspacesValue as { packages: unknown[] }).packages.filter(
          (value): value is string => typeof value === "string"
        ))
      : [];
  const environmentFiles = entries
    .filter((entry) => entry.isFile() && envFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
  const requiredEnvironmentKeys = new Set<string>();
  for (const envFile of environmentFiles.filter(exampleEnvFile)) {
    const raw = await readSmallFile(path.join(resolved.canonicalPath, envFile));
    if (!raw) continue;
    for (const key of Object.keys(parseDotEnv(raw))) requiredEnvironmentKeys.add(key);
  }
  const composeFiles = COMPOSE_FILES.filter((name) => names.has(name));
  const pm2Files = PM2_FILES.filter((name) => names.has(name));
  const manifestFiles = MANIFEST_FILES.filter((name) => names.has(name));
  const monorepo =
    workspaces.length > 0 ||
    names.has("pnpm-workspace.yaml") ||
    names.has("turbo.json") ||
    names.has("nx.json");
  return {
    requestedPath: resolved.requestedPath,
    canonicalPath: resolved.canonicalPath,
    symlink: resolved.symlink,
    name:
      typeof packageJson?.name === "string" && packageJson.name.trim()
        ? packageJson.name.trim()
        : path.basename(resolved.canonicalPath),
    markers: markersFromNames(names),
    projectType: detectProjectType(names, packageJson),
    git: await inspectGit(resolved.canonicalPath),
    packageManager,
    packageManagerDeclaration,
    packageName: typeof packageJson?.name === "string" ? packageJson.name : null,
    packageVersion: typeof packageJson?.version === "string" ? packageJson.version : null,
    engines,
    scripts,
    workspaces,
    monorepo,
    composeFiles,
    pm2Files,
    manifestFiles,
    environmentFiles,
    requiredEnvironmentKeys: Array.from(requiredEnvironmentKeys).sort(),
    suggestedCommands: suggestedCommands(packageManager, scripts, names),
  };
}

async function executableState(command: string, versionArgs: string[] = ["--version"]): Promise<RuntimeToolState> {
  const located = await runCommand("/bin/sh", ["-lc", `command -v -- ${command}`], { timeoutMs: 5_000 });
  const resolvedPath = located.ok ? located.stdout.trim().split(/\r?\n/)[0] || null : null;
  if (!resolvedPath) return { available: false, path: null, version: null, error: "not found in PATH" };
  const version = await runCommand(command, versionArgs, { timeoutMs: 10_000 });
  return {
    available: true,
    path: resolvedPath,
    version: (version.stdout || version.stderr).trim().split(/\r?\n/)[0] || null,
    error: version.ok ? null : version.error,
  };
}

function parsePm2Services(output: string, cwd: string): Pm2RuntimeService[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return [];
    const services: Pm2RuntimeService[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const proc = item as Record<string, unknown>;
      const env = proc.pm2_env && typeof proc.pm2_env === "object"
        ? (proc.pm2_env as Record<string, unknown>)
        : {};
      const serviceCwd = typeof env.pm_cwd === "string" ? env.pm_cwd : null;
      if (!relatedPath(cwd, serviceCwd)) continue;
      services.push({
        manager: "pm2",
        name: typeof proc.name === "string" ? proc.name : "unknown",
        id: typeof proc.pm_id === "number" ? proc.pm_id : null,
        pid: typeof proc.pid === "number" ? proc.pid : null,
        status: typeof env.status === "string" ? env.status : null,
        cwd: serviceCwd,
        script: typeof env.pm_exec_path === "string" ? env.pm_exec_path : null,
        namespace: typeof env.namespace === "string" ? env.namespace : null,
        interpreter: typeof env.exec_interpreter === "string" ? env.exec_interpreter : null,
        restarts: typeof env.restart_time === "number" ? env.restart_time : null,
      });
    }
    return services;
  } catch {
    return [];
  }
}

function parseSystemdBlocks(output: string, cwd: string): SystemdRuntimeService[] {
  const services: SystemdRuntimeService[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    const values: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const index = line.indexOf("=");
      if (index <= 0) continue;
      values[line.slice(0, index)] = line.slice(index + 1);
    }
    const name = values.Id;
    if (!name) continue;
    const workingDirectory = values.WorkingDirectory || null;
    const execStart = values.ExecStart || null;
    if (!relatedPath(cwd, workingDirectory) && !(execStart && execStart.includes(cwd))) continue;
    services.push({
      manager: "systemd",
      name,
      activeState: values.ActiveState || null,
      subState: values.SubState || null,
      mainPid: Number(values.MainPID) > 0 ? Number(values.MainPID) : null,
      workingDirectory,
      fragmentPath: values.FragmentPath || null,
      execStart,
    });
  }
  return services;
}

function parseDockerPs(output: string, composeFile: string): DockerRuntimeService[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  let items: unknown[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    items = trimmed
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((item): item is unknown => item !== null);
  }
  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      manager: "docker_compose" as const,
      project: typeof item.Project === "string" ? item.Project : typeof item.project === "string" ? item.project : null,
      service: typeof item.Service === "string" ? item.Service : typeof item.service === "string" ? item.service : null,
      name: typeof item.Name === "string" ? item.Name : typeof item.name === "string" ? item.name : null,
      state: typeof item.State === "string" ? item.State : typeof item.state === "string" ? item.state : null,
      status: typeof item.Status === "string" ? item.Status : typeof item.status === "string" ? item.status : null,
      health: typeof item.Health === "string" ? item.Health : typeof item.health === "string" ? item.health : null,
      composeFile,
    }));
}

async function inspectProcesses(cwd: string): Promise<ProcessRuntime[]> {
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const processes: ProcessRuntime[] = [];
  for (const entry of entries) {
    if (processes.length >= 100 || !entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const processCwd = await fs.realpath(`/proc/${pid}/cwd`);
      if (!relatedPath(cwd, processCwd)) continue;
      const raw = await fs.readFile(`/proc/${pid}/cmdline`);
      const command = raw.toString("utf8").split("\0").filter(Boolean).join(" ");
      processes.push({ manager: "process", pid, cwd: processCwd, command });
    } catch {
      // Processes may exit or deny access while being inspected.
    }
  }
  return processes;
}

export async function inspectRuntime(
  cwd: string,
  options: { includeProcesses?: boolean } = {}
): Promise<RuntimeInspection> {
  const project = await inspectProject(cwd);
  const toolEntries = await Promise.all(
    [
      ["node", ["--version"]],
      ["bun", ["--version"]],
      ["npm", ["--version"]],
      ["pnpm", ["--version"]],
      ["yarn", ["--version"]],
      ["pm2", ["--version"]],
      ["docker", ["--version"]],
      ["systemctl", ["--version"]],
    ].map(async ([name, args]) => [name as string, await executableState(name as string, args as string[])] as const)
  );
  const tools = Object.fromEntries(toolEntries);
  const notes: string[] = [];

  let pm2: Pm2RuntimeService[] = [];
  if (tools.pm2?.available) {
    const output = await runCommand("pm2", ["jlist"], { timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 });
    pm2 = output.ok ? parsePm2Services(output.stdout, project.canonicalPath) : [];
    if (!output.ok) notes.push(`PM2 inspection failed: ${output.error}`);
  }

  let systemd: SystemdRuntimeService[] = [];
  if (tools.systemctl?.available) {
    const output = await runCommand(
      "systemctl",
      [
        "show",
        "--all",
        "--type=service",
        "--property=Id,ActiveState,SubState,MainPID,FragmentPath,WorkingDirectory,ExecStart",
        "--no-pager",
      ],
      { timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 }
    );
    systemd = output.ok ? parseSystemdBlocks(output.stdout, project.canonicalPath) : [];
    if (!output.ok) notes.push(`systemd inspection failed: ${output.error}`);
  }

  const dockerCompose: DockerRuntimeService[] = [];
  if (tools.docker?.available) {
    for (const composeFile of project.composeFiles) {
      const output = await runCommand(
        "docker",
        ["compose", "-f", composeFile, "ps", "--format", "json"],
        { cwd: project.canonicalPath, timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 }
      );
      if (output.ok) dockerCompose.push(...parseDockerPs(output.stdout, composeFile));
      else notes.push(`Docker Compose inspection failed for ${composeFile}: ${output.error}`);
    }
  }

  const processes = options.includeProcesses === false ? [] : await inspectProcesses(project.canonicalPath);
  const detectedManagers: RuntimeInspection["detectedManagers"] = [];
  if (pm2.length > 0) detectedManagers.push("pm2");
  if (systemd.length > 0) detectedManagers.push("systemd");
  if (dockerCompose.length > 0) detectedManagers.push("docker_compose");
  if (processes.length > 0) detectedManagers.push("process");
  return {
    cwd: project.canonicalPath,
    tools,
    pm2,
    systemd,
    dockerCompose,
    processes,
    detectedManagers,
    notes,
  };
}

function addEnvironmentObservation(
  map: Map<string, EnvironmentObservation[]>,
  key: string,
  value: string,
  observation: Omit<EnvironmentObservation, "present" | "redacted" | "value">,
  revealValues: boolean,
  requestedKeys: Set<string>
): void {
  if (!ENV_KEY_RE.test(key)) return;
  if (requestedKeys.size > 0 && !requestedKeys.has(key)) return;
  const entries = map.get(key) ?? [];
  entries.push({
    ...observation,
    present: true,
    redacted: !(revealValues && requestedKeys.has(key)),
    ...(revealValues && requestedKeys.has(key) ? { value } : {}),
  });
  map.set(key, entries);
}

async function pm2Environment(cwd: string): Promise<Array<{
  name: string;
  pid: number | null;
  cwd: string | null;
  values: Record<string, string>;
}>> {
  const output = await runCommand("pm2", ["jlist"], { timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 });
  if (!output.ok) return [];
  try {
    const parsed = JSON.parse(output.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result: Array<{ name: string; pid: number | null; cwd: string | null; values: Record<string, string> }> = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const proc = item as Record<string, unknown>;
      const env = proc.pm2_env && typeof proc.pm2_env === "object"
        ? (proc.pm2_env as Record<string, unknown>)
        : {};
      const procCwd = typeof env.pm_cwd === "string" ? env.pm_cwd : null;
      if (!relatedPath(cwd, procCwd)) continue;
      const nested = env.env && typeof env.env === "object" ? (env.env as Record<string, unknown>) : {};
      const values: Record<string, string> = {};
      for (const [key, value] of [...Object.entries(env), ...Object.entries(nested)]) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          values[key] = String(value);
        }
      }
      result.push({
        name: typeof proc.name === "string" ? proc.name : "unknown",
        pid: typeof proc.pid === "number" ? proc.pid : null,
        cwd: procCwd,
        values,
      });
    }
    return result;
  } catch {
    return [];
  }
}

async function systemdEnvironment(service: SystemdRuntimeService): Promise<{
  values: Record<string, string>;
  files: string[];
}> {
  const output = await runCommand(
    "systemctl",
    ["show", service.name, "--property=Environment,EnvironmentFiles", "--no-pager"],
    { timeoutMs: 10_000, maxBuffer: 2 * 1024 * 1024 }
  );
  if (!output.ok) return { values: {}, files: [] };
  const lines = Object.fromEntries(
    output.stdout
      .split(/\r?\n/)
      .map((line) => {
        const index = line.indexOf("=");
        return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, ""];
      })
  );
  const values = parseAssignments(shellWords(lines.Environment ?? ""));
  const files = shellWords(lines.EnvironmentFiles ?? "")
    .map((entry) => entry.replace(/^-/, "").split(";")[0])
    .filter((entry) => path.isAbsolute(entry));
  return { values, files };
}

function composeEnvironmentFromJson(parsed: unknown): Array<{
  service: string;
  values: Record<string, string>;
}> {
  if (!parsed || typeof parsed !== "object") return [];
  const services = (parsed as { services?: unknown }).services;
  if (!services || typeof services !== "object" || Array.isArray(services)) return [];
  const result: Array<{ service: string; values: Record<string, string> }> = [];
  for (const [service, config] of Object.entries(services as Record<string, unknown>)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    const environment = (config as { environment?: unknown }).environment;
    const values: Record<string, string> = {};
    if (Array.isArray(environment)) {
      Object.assign(values, parseAssignments(environment.filter((value): value is string => typeof value === "string")));
    } else if (environment && typeof environment === "object") {
      for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
        if (ENV_KEY_RE.test(key) && value != null) values[key] = String(value);
      }
    }
    result.push({ service, values });
  }
  return result;
}

async function dockerComposeEnvironment(cwd: string, composeFile: string): Promise<Array<{
  service: string;
  values: Record<string, string>;
}>> {
  const output = await runCommand(
    "docker",
    ["compose", "-f", composeFile, "config", "--format", "json"],
    { cwd, timeoutMs: 20_000, maxBuffer: 8 * 1024 * 1024 }
  );
  if (!output.ok) return [];
  try {
    return composeEnvironmentFromJson(JSON.parse(output.stdout) as unknown);
  } catch {
    return [];
  }
}

async function processEnvironment(pid: number): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/environ`);
    return parseAssignments(raw.toString("utf8").split("\0").filter(Boolean));
  } catch {
    return {};
  }
}

export async function inspectEnvironment(
  cwd: string,
  input: InspectEnvironmentInput = {}
): Promise<EnvironmentInspection> {
  const project = await inspectProject(cwd);
  const supported: EnvironmentSourceName[] = ["dotenv", "pm2", "systemd", "docker_compose", "process"];
  const sources = uniqueStrings(input.sources?.length ? input.sources : supported).filter(
    (source): source is EnvironmentSourceName => supported.includes(source as EnvironmentSourceName)
  );
  const requestedKeys = new Set(
    uniqueStrings((input.keys ?? []).map((key) => key.trim()).filter((key) => ENV_KEY_RE.test(key))).slice(0, 20)
  );
  const revealValues = input.revealValues === true;
  if (revealValues && requestedKeys.size === 0) {
    throw new Error("revealValues=true requires one or more explicit keys (max 20)");
  }
  const observations = new Map<string, EnvironmentObservation[]>();
  const notes: string[] = [];
  let runtime: RuntimeInspection | null = null;

  if (sources.includes("dotenv")) {
    for (const file of project.environmentFiles.filter((name) => !exampleEnvFile(name))) {
      const raw = await readSmallFile(path.join(project.canonicalPath, file));
      if (raw == null) continue;
      for (const [key, value] of Object.entries(parseDotEnv(raw))) {
        addEnvironmentObservation(
          observations,
          key,
          value,
          { source: "dotenv", location: path.join(project.canonicalPath, file) },
          revealValues,
          requestedKeys
        );
      }
    }
  }

  if (sources.some((source) => source !== "dotenv")) {
    runtime = await inspectRuntime(project.canonicalPath);
    notes.push(...runtime.notes);
  }

  const pm2Records = sources.includes("pm2") ? await pm2Environment(project.canonicalPath) : [];
  for (const record of pm2Records) {
    for (const [key, value] of Object.entries(record.values)) {
      addEnvironmentObservation(
        observations,
        key,
        value,
        { source: "pm2", location: record.name, pid: record.pid ?? undefined, service: record.name },
        revealValues,
        requestedKeys
      );
    }
  }

  if (sources.includes("systemd")) {
    for (const service of runtime?.systemd ?? []) {
      const env = await systemdEnvironment(service);
      for (const [key, value] of Object.entries(env.values)) {
        addEnvironmentObservation(
          observations,
          key,
          value,
          { source: "systemd", location: service.name, service: service.name },
          revealValues,
          requestedKeys
        );
      }
      for (const envFile of env.files) {
        const raw = await readSmallFile(envFile);
        if (raw == null) continue;
        for (const [key, value] of Object.entries(parseDotEnv(raw))) {
          addEnvironmentObservation(
            observations,
            key,
            value,
            { source: "systemd", location: envFile, service: service.name },
            revealValues,
            requestedKeys
          );
        }
      }
    }
  }

  if (sources.includes("docker_compose")) {
    for (const composeFile of project.composeFiles) {
      const records = await dockerComposeEnvironment(project.canonicalPath, composeFile);
      for (const record of records) {
        for (const [key, value] of Object.entries(record.values)) {
          addEnvironmentObservation(
            observations,
            key,
            value,
            { source: "docker_compose", location: composeFile, service: record.service },
            revealValues,
            requestedKeys
          );
        }
      }
    }
  }

  if (sources.includes("process")) {
    const pids = new Set<number>();
    for (const proc of runtime?.processes ?? []) pids.add(proc.pid);
    for (const proc of runtime?.pm2 ?? []) if (proc.pid) pids.add(proc.pid);
    for (const proc of runtime?.systemd ?? []) if (proc.mainPid) pids.add(proc.mainPid);
    for (const pid of pids) {
      const values = await processEnvironment(pid);
      for (const [key, value] of Object.entries(values)) {
        addEnvironmentObservation(
          observations,
          key,
          value,
          { source: "process", location: `/proc/${pid}/environ`, pid },
          revealValues,
          requestedKeys
        );
      }
    }
  }

  const entries: EnvironmentEntry[] = Array.from(observations.entries())
    .map(([key, values]) => ({ key, present: true as const, observations: values }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const present = new Set(entries.map((entry) => entry.key));
  const revealedKeys = entries
    .filter((entry) => entry.observations.some((observation) => observation.value !== undefined))
    .map((entry) => entry.key);
  return {
    cwd: project.canonicalPath,
    sourcesRequested: sources,
    entries,
    requestedKeysMissing: Array.from(requestedKeys).filter((key) => !present.has(key)).sort(),
    revealedKeys,
    sensitiveOutput: revealedKeys.length > 0,
    valuesPersisted: false,
    notes: [
      ...notes,
      ...(revealedKeys.length > 0
        ? ["Revealed values are one-shot response data and are not written to verification history or deployment snapshots."]
        : []),
    ],
  };
}

function chooseStrategy(
  requested: DeploymentStrategy | undefined,
  project: ProjectInspection,
  runtime: RuntimeInspection
): Exclude<DeploymentStrategy, "auto"> {
  if (requested && requested !== "auto") return requested;
  if (runtime.dockerCompose.length > 0 || (project.composeFiles.length > 0 && runtime.tools.docker?.available)) {
    return "docker_compose";
  }
  if (runtime.pm2.length > 0) return "pm2";
  if (runtime.systemd.length > 0) return "systemd";
  if (project.symlink || /(^|\/)releases\//.test(project.canonicalPath)) return "release_symlink";
  return "in_place";
}

export function buildDeploymentPlanFromInspections(
  project: ProjectInspection,
  runtime: RuntimeInspection,
  environment: EnvironmentInspection,
  input: DeploymentPlanInput
): DeploymentPlan {
  const strategy = chooseStrategy(input.strategy, project, runtime);
  let service: DeploymentPlan["service"];
  if (input.serviceName) {
    service = {
      manager:
        strategy === "pm2" || strategy === "systemd" || strategy === "docker_compose"
          ? strategy
          : "custom",
      name: input.serviceName,
    };
  } else if (runtime.pm2[0]) {
    service = { manager: "pm2", name: runtime.pm2[0].name };
  } else if (runtime.systemd[0]) {
    service = { manager: "systemd", name: runtime.systemd[0].name };
  } else if (runtime.dockerCompose[0]) {
    service = { manager: "docker_compose", name: runtime.dockerCompose[0].service };
  } else {
    service = { manager: "none", name: null };
  }
  const presentKeys = environment.entries.map((entry) => entry.key);
  const presentSet = new Set(presentKeys);
  const missingKeys = project.requiredEnvironmentKeys.filter((key) => !presentSet.has(key));
  const risks: DeploymentPlan["risks"] = [];
  if (!project.git.present) risks.push({ level: "medium", code: "no_git_repository", message: "Project is not backed by a detected Git repository." });
  if (project.git.dirty) risks.push({ level: input.allowDirty ? "medium" : "high", code: "dirty_worktree", message: "Working tree has staged, modified, untracked, or conflicted files." });
  if (!input.expectedHead) risks.push({ level: "medium", code: "target_not_pinned", message: "Deployment target is not pinned to an exact SHA." });
  if (strategy === "in_place") risks.push({ level: "medium", code: "in_place_activation", message: "In-place deployment has a wider rollback surface than release symlinks or container images." });
  if (service.manager === "none") risks.push({ level: "medium", code: "service_not_detected", message: "No PM2, systemd, or Docker Compose service was matched to this project." });
  if ((input.healthChecks ?? []).length === 0) risks.push({ level: "medium", code: "health_check_missing", message: "No explicit post-deploy health check was supplied." });
  if (missingKeys.length > 0) risks.push({ level: "high", code: "required_environment_missing", message: `Required environment keys are missing: ${missingKeys.join(", ")}` });
  const approvalReasons = risks.filter((risk) => risk.level === "high").map((risk) => risk.code);
  const snapshotFields = [
    "canonical cwd",
    "repository remote, branch, and HEAD SHA",
    "dirty patch and untracked manifest",
    "package manager and lockfile hashes",
    "runtime and service state",
    "PM2, systemd, or Docker configuration hashes",
    "environment key names and source locations",
    "health baseline",
    "previous release path",
    "deployment plan",
  ];
  const rollbackStrategy =
    strategy === "release_symlink"
      ? "restore previous symlink and restart service"
      : strategy === "docker_compose"
        ? "restore prior image/config snapshot and recreate services"
        : strategy === "pm2" || strategy === "systemd"
          ? "restore backup/revision, restart service, and re-run health checks"
          : "restore deploy snapshot and restart detected service";
  const commands = {
    install: project.suggestedCommands.install,
    verify: input.verifyCommands?.length ? input.verifyCommands : project.suggestedCommands.verify,
    build: input.buildCommands?.length ? input.buildCommands : project.suggestedCommands.build,
  };
  return {
    planVersion: 1,
    createdAt: new Date().toISOString(),
    project: {
      name: project.name,
      cwd: project.canonicalPath,
      repository: project.git.origin,
      branch: project.git.branch,
      currentHead: project.git.head,
      targetRef: input.targetRef ?? project.git.branch,
      expectedHead: input.expectedHead ?? null,
      dirty: project.git.dirty,
      monorepo: project.monorepo,
      packageManager: project.packageManager,
    },
    strategy,
    lock: {
      key: createHash("sha256").update(project.canonicalPath).digest("hex").slice(0, 32),
      canonicalCwd: project.canonicalPath,
      behavior: "queue_same_project",
    },
    service,
    commands,
    environment: {
      requiredKeys: project.requiredEnvironmentKeys,
      presentKeys,
      missingKeys,
      valuesIncluded: false,
    },
    healthChecks: input.healthChecks ?? [],
    snapshot: { required: true, fields: snapshotFields },
    rollback: { supported: true, strategy: rollbackStrategy },
    steps: [
      "inspect current project and runtime state",
      "resolve and verify exact target SHA",
      "acquire canonical project lock",
      "capture deploy snapshot and health baseline",
      "prepare source or release directory",
      "run install, verification, and build commands",
      "activate release using selected strategy",
      "restart or reload detected service",
      "run post-deploy health checks",
      "finalize journal and release project lock",
      "rollback from snapshot on failure when enabled",
    ],
    risks,
    ready:
      missingKeys.length === 0 &&
      (!!input.allowDirty || !project.git.dirty) &&
      (project.git.present || strategy === "custom"),
    approvalRequired: approvalReasons.length > 0,
    approvalReasons,
  };
}

export async function planDeployment(input: DeploymentPlanInput): Promise<DeploymentPlan> {
  const [project, runtime, environment] = await Promise.all([
    inspectProject(input.cwd),
    inspectRuntime(input.cwd),
    inspectEnvironment(input.cwd, { revealValues: false }),
  ]);
  return buildDeploymentPlanFromInspections(project, runtime, environment, input);
}
