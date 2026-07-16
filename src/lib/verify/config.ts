// Centralized configuration sourced from environment variables.
// All values are read lazily so changes to process.env (e.g. after a restart) are respected.

import os from "node:os";
import path from "node:path";

export const VERSION = "1.0.0";
export const MAX_LONG_RUN_TIMEOUT_MS = 9 * 60 * 60 * 1000;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw;
}

function boolEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return false;
  return raw === "true" || raw === "1" || raw === "yes";
}

export type AuthMode = "server_token" | "github_passthrough";
export type OAuthStorageMode = "json" | "prisma";

export interface VerifyConfig {
  verifyToken: string;
  githubToken: string;
  authMode: AuthMode;
  allowedRepos: string[];
  /**
   * When true, ANY repo matching the safe `owner/repo` regex is allowed
   * (no per-repo allowlist enforcement). Triggered by any of:
   *   - ALLOWED_REPOS unset / empty
   *   - ALLOWED_REPOS === "*"
   *   - ALLOW_ALL_REPOS=true (explicit override)
   * In this mode `allowedRepos` is always `[]`.
   */
  allowAllRepos: boolean;
  workdirBase: string;
  maxLogBytes: number;
  /** Effective per-command timeout, never greater than the total job timeout. */
  commandTimeoutMs: number;
  /** Raw COMMAND_TIMEOUT_MS value before normalization. */
  configuredCommandTimeoutMs: number;
  jobTimeoutMs: number;
  maxConcurrentJobs: number;
  cleanupAfterMs: number;
  dataDir: string;
  toolchainCacheRoot: string;
  toolchainDefaultNode: string;
  toolchainDefaultBun: string;
  oauthStorageMode: OAuthStorageMode;
}

export interface EffectiveDefaultTimeouts {
  configuredCommandTimeoutMs: number;
  commandTimeoutMs: number;
  jobTimeoutMs: number;
  normalized: boolean;
  warnings: string[];
}

function parseAuthMode(raw: string | undefined): AuthMode {
  const v = (raw || "").trim().toLowerCase();
  if (v === "github_passthrough" || v === "github-passthrough" || v === "passthrough") {
    return "github_passthrough";
  }
  return "server_token";
}

function parseOAuthStorageMode(raw: string | undefined): OAuthStorageMode {
  const v = (raw || "").trim().toLowerCase();
  if (v === "prisma" || v === "database" || v === "db") return "prisma";
  return "json";
}

function isInsideNextBuild(p: string): boolean {
  return /(^|[/\\])\.next([/\\]|$)/.test(p);
}

export function resolveWorkdirBase(): string {
  const raw = process.env.WORKDIR_BASE;
  let resolved: string;
  if (raw && raw.trim()) {
    const v = raw.trim();
    resolved = path.isAbsolute(v) ? v : path.resolve(process.cwd(), v);
  } else {
    resolved = path.join(os.tmpdir(), "purr-verify-workspaces");
  }
  if (isInsideNextBuild(resolved)) {
    resolved = path.join(os.tmpdir(), "purr-verify-workspaces");
  }
  return resolved;
}

export function getConfig(): VerifyConfig {
  const verifyToken = strEnv("VERIFY_TOKEN", "");
  const githubToken = strEnv("GITHUB_TOKEN", "");
  const authMode = parseAuthMode(process.env.AUTH_MODE);
  const rawAllowed = strEnv("ALLOWED_REPOS", "");
  const trimmedAllowed = rawAllowed.trim();
  const allowAllReposExplicit = boolEnv("ALLOW_ALL_REPOS");
  const isStar = trimmedAllowed === "*";
  const allowAllRepos = allowAllReposExplicit || trimmedAllowed === "" || isStar;
  const allowedRepos = allowAllRepos
    ? []
    : rawAllowed
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "*");
  const dataDir = strEnv("VERIFY_DATA_DIR", ".verify-data");
  const configuredCommandTimeoutMs = intEnv("COMMAND_TIMEOUT_MS", 600_000);
  const jobTimeoutMs = intEnv("JOB_TIMEOUT_MS", 1_800_000);
  const commandTimeoutMs = Math.min(configuredCommandTimeoutMs, jobTimeoutMs);
  return {
    verifyToken,
    githubToken,
    authMode,
    allowedRepos,
    allowAllRepos,
    workdirBase: resolveWorkdirBase(),
    maxLogBytes: intEnv("MAX_LOG_BYTES", 500_000),
    commandTimeoutMs,
    configuredCommandTimeoutMs,
    jobTimeoutMs,
    maxConcurrentJobs: Math.max(1, intEnv("MAX_CONCURRENT_JOBS", 1)),
    cleanupAfterMs: intEnv("CLEANUP_AFTER_MS", 3_600_000),
    dataDir: path.resolve(process.cwd(), dataDir),
    toolchainCacheRoot: path.resolve(strEnv("TOOLCHAIN_CACHE_DIR", path.join(os.tmpdir(), "purr-verify-toolchains"))),
    toolchainDefaultNode: strEnv("TOOLCHAIN_DEFAULT_NODE", strEnv("DEFAULT_NODE_VERSION", "")),
    toolchainDefaultBun: strEnv("TOOLCHAIN_DEFAULT_BUN", strEnv("DEFAULT_BUN_VERSION", "")),
    oauthStorageMode: parseOAuthStorageMode(process.env.OAUTH_STORAGE_MODE),
  };
}

export function effectiveDefaultTimeouts(
  cfg: Pick<VerifyConfig, "commandTimeoutMs" | "configuredCommandTimeoutMs" | "jobTimeoutMs"> = getConfig()
): EffectiveDefaultTimeouts {
  const configuredCommandTimeoutMs = cfg.configuredCommandTimeoutMs;
  const commandTimeoutMs = Math.min(cfg.commandTimeoutMs, cfg.jobTimeoutMs);
  const normalized = commandTimeoutMs !== configuredCommandTimeoutMs;
  return {
    configuredCommandTimeoutMs,
    commandTimeoutMs,
    jobTimeoutMs: cfg.jobTimeoutMs,
    normalized,
    warnings: normalized
      ? [
          `COMMAND_TIMEOUT_MS (${configuredCommandTimeoutMs}) exceeded JOB_TIMEOUT_MS (${cfg.jobTimeoutMs}); effective command timeout was clamped to the job timeout.`,
        ]
      : [],
  };
}

export function githubTokenSource(): "bearer" | "env" | "none" {
  const cfg = getConfig();
  if (cfg.authMode === "github_passthrough") return "bearer";
  return cfg.githubToken ? "env" : "none";
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoAllowed(repo: string): boolean {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return false;
  const segs = repo.split("/");
  if (segs.length !== 2) return false;
  if (segs[0] === "." || segs[0] === "..") return false;
  if (segs[1] === "." || segs[1] === "..") return false;
  const cfg = getConfig();
  if (cfg.allowAllRepos) return true;
  return cfg.allowedRepos.some((r) => r.toLowerCase() === repo.toLowerCase());
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/\-]{0,200}$/;

export function isValidRef(ref: string): boolean {
  if (!ref) return false;
  if (ref.includes("..")) return false;
  return REF_RE.test(ref);
}

const HEAD_RE = /^[0-9a-fA-F]{4,40}$/;

export function isValidHead(head: string): boolean {
  return HEAD_RE.test(head);
}

export function isConfigured(): { ok: boolean; reason?: string } {
  const cfg = getConfig();
  if (cfg.authMode === "server_token" && !cfg.verifyToken) {
    return { ok: false, reason: "VERIFY_TOKEN is not set (required for AUTH_MODE=server_token)" };
  }
  if (cfg.allowedRepos.length === 0 && !cfg.allowAllRepos) {
    return {
      ok: false,
      reason:
        "ALLOWED_REPOS is empty (set a comma-separated list, use '*', or set ALLOW_ALL_REPOS=true)",
    };
  }
  return { ok: true };
}
