import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DeclaredToolchain {
  node?: string;
  bun?: string;
  sources: Record<string, string>;
}

export interface EffectiveToolchain {
  declared: DeclaredToolchain;
  nodeVersion: string;
  bunVersion: string | null;
  pathPrefix: string[];
  cacheDir: string;
  warnings: string[];
  recommendations: string[];
  defaults: {
    node?: string;
    bun?: string;
  };
}

export interface InstallStrategy {
  requestedCommand: string;
  effectiveCommand: string;
  packageManager: "bun" | "npm" | "pnpm" | "unknown";
  mode: "frozen" | "locked" | "unlocked" | "not-install";
  lockfile: string | null;
  lockfileHonored: boolean;
}

const EXACT_VERSION_RE = /(?:^|[^0-9])([0-9]+\.[0-9]+\.[0-9]+)(?:[^0-9]|$)/;

function normalizeVersion(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const exact = trimmed.replace(/^v/, "").match(/^[0-9]+\.[0-9]+\.[0-9]+$/);
  if (exact) return exact[0];
  const match = trimmed.match(EXACT_VERSION_RE);
  return match?.[1];
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(file: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextIfExists(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function detectDeclaredToolchain(workdir: string): Promise<DeclaredToolchain> {
  const sources: Record<string, string> = {};
  let node: string | undefined;
  let bun: string | undefined;

  for (const file of [".nvmrc", ".node-version"]) {
    const raw = await readTextIfExists(path.join(workdir, file));
    const version = normalizeVersion(raw);
    if (version && !node) {
      node = version;
      sources.node = file;
    }
  }

  const toolVersions = await readTextIfExists(path.join(workdir, ".tool-versions"));
  if (toolVersions) {
    for (const line of toolVersions.split(/\r?\n/)) {
      const [name, value] = line.trim().split(/\s+/, 2);
      if (name === "nodejs" && !node) {
        const version = normalizeVersion(value);
        if (version) {
          node = version;
          sources.node = ".tool-versions:nodejs";
        }
      }
      if (name === "bun" && !bun) {
        const version = normalizeVersion(value);
        if (version) {
          bun = version;
          sources.bun = ".tool-versions:bun";
        }
      }
    }
  }

  const bunVersion = await readTextIfExists(path.join(workdir, ".bun-version"));
  if (!bun) {
    const version = normalizeVersion(bunVersion);
    if (version) {
      bun = version;
      sources.bun = ".bun-version";
    }
  }

  const pkg = await readJsonIfExists(path.join(workdir, "package.json"));
  if (pkg) {
    const volta = pkg.volta as Record<string, unknown> | undefined;
    if (!node && typeof volta?.node === "string") {
      const version = normalizeVersion(volta.node);
      if (version) {
        node = version;
        sources.node = "package.json:volta.node";
      }
    }
    if (!bun && typeof volta?.bun === "string") {
      const version = normalizeVersion(volta.bun);
      if (version) {
        bun = version;
        sources.bun = "package.json:volta.bun";
      }
    }

    const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
    if (!bun && packageManager.startsWith("bun@")) {
      const version = normalizeVersion(packageManager.slice("bun@".length));
      if (version) {
        bun = version;
        sources.bun = "package.json:packageManager";
      }
    }

    const engines = pkg.engines as Record<string, unknown> | undefined;
    if (!node && typeof engines?.node === "string") {
      const version = normalizeVersion(engines.node);
      if (version) {
        node = version;
        sources.node = "package.json:engines.node";
      }
    }
    if (!bun && typeof engines?.bun === "string") {
      const version = normalizeVersion(engines.bun);
      if (version) {
        bun = version;
        sources.bun = "package.json:engines.bun";
      }
    }
  }

  return { node, bun, sources };
}

function platformArch(): { node: string; bun: string; isWindows: boolean } {
  const isWindows = process.platform === "win32";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform = isWindows ? "win" : process.platform === "darwin" ? "darwin" : "linux";
  return {
    node: `${platform}-${arch}`,
    bun: `${platform}-${arch}`,
    isWindows,
  };
}

function command(program: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed ${res.status} ${res.statusText}: ${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await fs.writeFile(dest, bytes);
}

async function ensureNode(version: string, cacheDir: string, warnings: string[]): Promise<string | null> {
  const current = process.version.replace(/^v/, "");
  if (current === version) return null;

  const { node: platform, isWindows } = platformArch();
  const archiveBase = `node-v${version}-${platform}`;
  const installDir = path.join(cacheDir, "node", archiveBase);
  const binDir = isWindows ? installDir : path.join(installDir, "bin");
  const nodeBin = isWindows ? path.join(binDir, "node.exe") : path.join(binDir, "node");
  if (existsSync(nodeBin)) return binDir;

  await fs.mkdir(path.dirname(installDir), { recursive: true });
  const archive = path.join(path.dirname(installDir), `${archiveBase}.${isWindows ? "zip" : "tar.xz"}`);
  const url = `https://nodejs.org/dist/v${version}/${archiveBase}.${isWindows ? "zip" : "tar.xz"}`;
  await downloadFile(url, archive);

  if (isWindows) {
    const res = await command("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(path.dirname(installDir))} -Force`], process.cwd(), 180_000);
    if (res.code !== 0) throw new Error(`extract node ${version} failed: ${res.output}`);
  } else {
    const res = await command("tar", ["-xJf", archive, "-C", path.dirname(installDir)], process.cwd(), 180_000);
    if (res.code !== 0) throw new Error(`extract node ${version} failed: ${res.output}`);
  }

  if (!existsSync(nodeBin)) {
    warnings.push(`node ${version} archive extracted but binary was not found`);
    return null;
  }
  return binDir;
}

async function ensureBun(version: string, cacheDir: string, warnings: string[]): Promise<string | null> {
  const current = (process.versions as unknown as { bun?: string }).bun ?? null;
  if (current === version) return null;

  const { bun: platform, isWindows } = platformArch();
  const archiveBase = `bun-${platform}`;
  const installDir = path.join(cacheDir, "bun", `bun-v${version}-${platform}`);
  const binDir = path.join(installDir, archiveBase);
  const bunBin = path.join(binDir, isWindows ? "bun.exe" : "bun");
  if (existsSync(bunBin)) return binDir;

  await fs.mkdir(installDir, { recursive: true });
  const archive = path.join(installDir, `${archiveBase}.zip`);
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${archiveBase}.zip`;
  await downloadFile(url, archive);

  const unzip = await command("unzip", ["-oq", archive, "-d", installDir], process.cwd(), 120_000);
  if (unzip.code !== 0) {
    const py = await command("python3", ["-m", "zipfile", "-e", archive, installDir], process.cwd(), 120_000);
    if (py.code !== 0) {
      const py2 = await command("python", ["-m", "zipfile", "-e", archive, installDir], process.cwd(), 120_000);
      if (py2.code !== 0) throw new Error(`extract bun ${version} failed: ${unzip.output || py.output || py2.output}`);
    }
  }

  if (!existsSync(bunBin)) {
    warnings.push(`bun ${version} archive extracted but binary was not found`);
    return null;
  }
  return binDir;
}

async function versionOf(
  program: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string
): Promise<string | null> {
  const res = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(program, args, {
      cwd,
      env: env as unknown as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: 127, output: err.message }));
    child.on("close", (code) => resolve({ code, output }));
  });
  if (res.code !== 0) return null;
  return res.output.trim().split(/\r?\n/)[0] || null;
}

export async function prepareToolchain(workdir: string): Promise<EffectiveToolchain> {
  const declared = await detectDeclaredToolchain(workdir);
  const cacheDir = path.resolve(process.env.TOOLCHAIN_CACHE_DIR || path.join(os.tmpdir(), "purr-verify-toolchains"));
  const pathPrefix: string[] = [];
  const warnings: string[] = [];
  const recommendations = await workspaceRecommendations(workdir, declared);
  const defaultNode = normalizeVersion(process.env.TOOLCHAIN_DEFAULT_NODE || process.env.DEFAULT_NODE_VERSION);
  const defaultBun = normalizeVersion(process.env.TOOLCHAIN_DEFAULT_BUN || process.env.DEFAULT_BUN_VERSION);
  const nodeTarget = declared.node ?? defaultNode;
  const bunTarget = declared.bun ?? defaultBun;

  if (!declared.node && defaultNode) {
    warnings.push(`repo did not declare an exact node version; using runner default ${defaultNode}`);
  }
  if (!declared.bun && defaultBun) {
    warnings.push(`repo did not declare an exact bun version; using runner default ${defaultBun}`);
  }

  if (nodeTarget) {
    try {
      const bin = await ensureNode(nodeTarget, cacheDir, warnings);
      if (bin) pathPrefix.push(bin);
    } catch (e) {
      warnings.push(`node ${nodeTarget} setup failed: ${(e as Error).message}`);
    }
  }
  if (bunTarget) {
    try {
      const bin = await ensureBun(bunTarget, cacheDir, warnings);
      if (bin) pathPrefix.push(bin);
    } catch (e) {
      warnings.push(`bun ${bunTarget} setup failed: ${(e as Error).message}`);
    }
  }

  const env = buildToolchainEnv(pathPrefix);
  const nodeVersion = (await versionOf("node", ["--version"], env, workdir)) ?? process.version;
  const bunVersion = await versionOf("bun", ["--version"], env, workdir);

  if (nodeTarget && nodeVersion.replace(/^v/, "") !== nodeTarget) {
    warnings.push(`effective node ${nodeVersion} does not match requested ${nodeTarget}`);
  }
  if (bunTarget && bunVersion !== bunTarget) {
    warnings.push(`effective bun ${bunVersion ?? "unavailable"} does not match requested ${bunTarget}`);
  }

  return {
    declared,
    nodeVersion,
    bunVersion,
    pathPrefix,
    cacheDir,
    warnings,
    recommendations,
    defaults: {
      node: defaultNode,
      bun: defaultBun,
    },
  };
}

export function buildToolchainEnv(
  pathPrefix: string[],
  base: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  if (pathPrefix.length === 0) return { ...base };
  return {
    ...base,
    PATH: [...pathPrefix, base.PATH || ""].filter(Boolean).join(path.delimiter),
  };
}

export async function installStrategy(workdir: string, commandText: string): Promise<InstallStrategy> {
  const lockfiles = [
    ["bun.lock", "bun"] as const,
    ["bun.lockb", "bun"] as const,
    ["package-lock.json", "npm"] as const,
    ["npm-shrinkwrap.json", "npm"] as const,
    ["pnpm-lock.yaml", "pnpm"] as const,
  ];
  const found = lockfiles.find(([file]) => existsSync(path.join(workdir, file)));
  const lockfile = found?.[0] ?? null;
  const managerFromLock = found?.[1] ?? "unknown";

  if (commandText === "bun install") {
    if (lockfile && managerFromLock === "bun") {
      return {
        requestedCommand: commandText,
        effectiveCommand: "bun install --frozen-lockfile",
        packageManager: "bun",
        mode: "frozen",
        lockfile,
        lockfileHonored: true,
      };
    }
    return {
      requestedCommand: commandText,
      effectiveCommand: commandText,
      packageManager: "bun",
      mode: lockfile ? "locked" : "unlocked",
      lockfile,
      lockfileHonored: false,
    };
  }

  if (commandText === "bun install --frozen-lockfile") {
    return {
      requestedCommand: commandText,
      effectiveCommand: commandText,
      packageManager: "bun",
      mode: "frozen",
      lockfile,
      lockfileHonored: !!lockfile && managerFromLock === "bun",
    };
  }

  if (commandText === "npm ci") {
    return {
      requestedCommand: commandText,
      effectiveCommand: commandText,
      packageManager: "npm",
      mode: "frozen",
      lockfile,
      lockfileHonored: !!lockfile && managerFromLock === "npm",
    };
  }

  if (commandText === "pnpm install --frozen-lockfile") {
    return {
      requestedCommand: commandText,
      effectiveCommand: commandText,
      packageManager: "pnpm",
      mode: "frozen",
      lockfile,
      lockfileHonored: !!lockfile && managerFromLock === "pnpm",
    };
  }

  return {
    requestedCommand: commandText,
    effectiveCommand: commandText,
    packageManager: "unknown",
    mode: "not-install",
    lockfile,
    lockfileHonored: false,
  };
}

export async function workspaceRecommendations(
  workdir: string,
  declared: DeclaredToolchain = { sources: {} }
): Promise<string[]> {
  const recommendations: string[] = [];
  const pkg = await readJsonIfExists(path.join(workdir, "package.json"));
  const packageManager = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  const lockfiles = [
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
  ].filter((file) => existsSync(path.join(workdir, file)));

  if (!declared.node) {
    recommendations.push("Declare an exact Node version in .nvmrc, .node-version, .tool-versions, package.json volta.node, or package.json engines.node.");
  }
  if (!declared.bun && (packageManager.startsWith("bun@") || existsSync(path.join(workdir, "bun.lock")) || existsSync(path.join(workdir, "bun.lockb")))) {
    recommendations.push("Pin Bun with package.json packageManager (for example bun@1.3.14), .bun-version, .tool-versions, package.json volta.bun, or package.json engines.bun.");
  }
  if (!packageManager) {
    recommendations.push("Add package.json packageManager to make install tooling explicit for live verification.");
  } else if (!normalizeVersion(packageManager)) {
    recommendations.push("Pin package.json packageManager to an exact version so agents and the runner use the same install tool.");
  }
  if (lockfiles.length === 0) {
    recommendations.push("Commit a lockfile so live verification can run frozen, reproducible installs.");
  }
  if (lockfiles.length > 1) {
    recommendations.push(`Multiple lockfiles detected (${lockfiles.join(", ")}); keep one package-manager lockfile to avoid dependency graph drift.`);
  }
  if (packageManager.startsWith("bun@") && !lockfiles.some((file) => file === "bun.lock" || file === "bun.lockb")) {
    recommendations.push("packageManager is Bun but no Bun lockfile is committed; run bun install locally and commit bun.lock.");
  }
  if (packageManager.startsWith("pnpm@") && !lockfiles.includes("pnpm-lock.yaml")) {
    recommendations.push("packageManager is pnpm but pnpm-lock.yaml is missing; commit the pnpm lockfile.");
  }
  if ((packageManager.startsWith("npm@") || packageManager.startsWith("node@")) && !lockfiles.some((file) => file === "package-lock.json" || file === "npm-shrinkwrap.json")) {
    recommendations.push("packageManager is npm but package-lock.json/npm-shrinkwrap.json is missing; commit the npm lockfile.");
  }

  return recommendations;
}

export function normalizeBunx(program: string, args: string[]): { program: string; args: string[] } {
  if (program === "bunx") {
    return { program: "bun", args: ["x", ...args] };
  }
  return { program, args };
}
