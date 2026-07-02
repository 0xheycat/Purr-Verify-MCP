// Centralized configuration sourced from environment variables.
// All values are read lazily so changes to process.env (e.g. after a restart) are respected.

import path from "node:path";

export const VERSION = "1.0.0";

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
  commandTimeoutMs: number;
  jobTimeoutMs: number;
  maxConcurrentJobs: number;
  cleanupAfterMs: number;
  dataDir: string;
}

function parseAuthMode(raw: string | undefined): AuthMode {
  const v = (raw || "").trim().toLowerCase();
  if (v === "github_passthrough" || v === "github-passthrough" || v === "passthrough") {
    return "github_passthrough";
  }
  // Default + explicit server_token.
  return "server_token";
}

export function getConfig(): VerifyConfig {
  const verifyToken = strEnv("VERIFY_TOKEN", "");
  const githubToken = strEnv("GITHUB_TOKEN", "");
  const authMode = parseAuthMode(process.env.AUTH_MODE);
  const rawAllowed = strEnv("ALLOWED_REPOS", "");
  const trimmedAllowed = rawAllowed.trim();
  const allowAllReposExplicit = boolEnv("ALLOW_ALL_REPOS");
  const isStar = trimmedAllowed === "*";
  // Unrestricted mode: empty/unset ALLOWED_REPOS, the "*" sentinel, or an
  // explicit ALLOW_ALL_REPOS=true override. In this mode the per-repo list is
  // ignored and `allowedRepos` is reported as [].
  const allowAllRepos = allowAllReposExplicit || trimmedAllowed === "" || isStar;
  const allowedRepos = allowAllRepos
    ? []
    : rawAllowed
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "*");
  const workdirBase = strEnv("WORKDIR_BASE", ".verify-workspaces");
  const dataDir = strEnv("VERIFY_DATA_DIR", ".verify-data");
  return {
    verifyToken,
    githubToken,
    authMode,
    allowedRepos,
    allowAllRepos,
    workdirBase: path.resolve(process.cwd(), workdirBase),
    maxLogBytes: intEnv("MAX_LOG_BYTES", 500_000),
    commandTimeoutMs: intEnv("COMMAND_TIMEOUT_MS", 600_000),
    jobTimeoutMs: intEnv("JOB_TIMEOUT_MS", 1_800_000),
    maxConcurrentJobs: Math.max(1, intEnv("MAX_CONCURRENT_JOBS", 1)),
    cleanupAfterMs: intEnv("CLEANUP_AFTER_MS", 3_600_000),
    dataDir: path.resolve(process.cwd(), dataDir),
  };
}

/**
 * Describes WHERE the GitHub clone token comes from in the current auth mode,
 * for surfacing in /api/health (no token value is ever exposed):
 *   - "bearer": AUTH_MODE=github_passthrough — the per-request Bearer token IS
 *               the GitHub PAT, used directly for cloning private repos.
 *   - "env":    AUTH_MODE=server_token + GITHUB_TOKEN set in env — clone uses
 *               the server's env GITHUB_TOKEN.
 *   - "none":   no GitHub token available — only public repos can be cloned.
 */
export function githubTokenSource(): "bearer" | "env" | "none" {
  const cfg = getConfig();
  if (cfg.authMode === "github_passthrough") return "bearer";
  return cfg.githubToken ? "env" : "none";
}

// Repo allowlist helper. The format is exactly `owner/repo` where each
// segment matches [A-Za-z0-9_.-]+. Arbitrary git URLs are NEVER allowed —
// cloning is always performed against https://github.com/<owner>/<repo>.git
// (see executor.buildCloneUrl), so only the owner/repo slug is ever accepted
// here.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoAllowed(repo: string): boolean {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return false;
  // Defense in depth: reject "." / ".." segments. The regex permits a leading
  // "." in a segment, which would let ".." through; block path-traversal
  // segments explicitly so the clone URL can never resolve outside the
  // intended github.com/<owner>/<repo> path.
  const segs = repo.split("/");
  if (segs.length !== 2) return false;
  if (segs[0] === "." || segs[0] === "..") return false;
  if (segs[1] === "." || segs[1] === "..") return false;
  const cfg = getConfig();
  if (cfg.allowAllRepos) return true;
  return cfg.allowedRepos.some((r) => r.toLowerCase() === repo.toLowerCase());
}

// Ref validation: branch/tag/sha-ish, no path traversal or shell metachars.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/\-]{0,200}$/;

export function isValidRef(ref: string): boolean {
  if (!ref) return false;
  if (ref.includes("..")) return false;
  return REF_RE.test(ref);
}

// expected_head: 4..40 hex chars (short or full SHA).
const HEAD_RE = /^[0-9a-fA-F]{4,40}$/;

export function isValidHead(head: string): boolean {
  return HEAD_RE.test(head);
}

export function isConfigured(): { ok: boolean; reason?: string } {
  const cfg = getConfig();
  // In github_passthrough mode, the Bearer token IS the GitHub PAT, so
  // VERIFY_TOKEN is not required (auth is delegated to the GitHub API).
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
