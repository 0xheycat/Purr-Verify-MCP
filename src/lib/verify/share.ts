// Share token management for public read-only job access.
//
// Tokens are persisted to <dataDir>/shares/<token>.json so they survive server
// restarts. Tokens are short-lived (default 24h, max 7d) and can be revoked
// at any time. A single job may have multiple active share tokens (e.g., one
// per recipient).

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";
import { getJobDurable, loadPersisted } from "./store";
import type { Job, PublicJobView, ShareToken } from "./types";

const MAX_TTL_HOURS = 24 * 7; // 7 days
const DEFAULT_TTL_HOURS = 24;

interface PurrVerifyShareGlobal {
  __purrVerifySharesCleanupAt?: number;
}

function getShareGlobal(): PurrVerifyShareGlobal {
  return globalThis as PurrVerifyShareGlobal;
}

// In-memory cache of share tokens. NOTE: in Next.js dev mode, each route
// handler module gets its own copy of this Map. We MUST re-read from disk
// on every loadPersistedShares() call (same pattern as loadPersisted for
// jobs) so that tokens created via one route (e.g., /mcp or
// /api/verify/[jobId]/share) are visible to other routes (e.g., the public
// /api/share/[token] route).
const tokens = new Map<string, ShareToken>();

function sharesDir(): string {
  return path.join(getConfig().dataDir, "shares");
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(sharesDir(), { recursive: true });
}

async function persist(token: ShareToken): Promise<void> {
  try {
    await ensureDir();
    const file = path.join(sharesDir(), `${token.token}.json`);
    await fs.writeFile(file, JSON.stringify(token, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

async function removePersisted(tokenStr: string): Promise<void> {
  try {
    await fs.unlink(path.join(sharesDir(), `${tokenStr}.json`));
  } catch {
    // best-effort
  }
}

export async function loadPersistedShares(): Promise<void> {
  // Always re-read from disk so tokens created in other route modules (or
  // other processes, after a restart) are visible. This mirrors the
  // loadPersisted() pattern used for jobs.
  //
  // Cleanup of expired/revoked tokens is throttled to once per 5 minutes via
  // a globalThis timestamp (shared across route modules in dev mode).
  const g = getShareGlobal();
  const now = Date.now();
  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  const shouldCleanup = !g.__purrVerifySharesCleanupAt || now - g.__purrVerifySharesCleanupAt > CLEANUP_INTERVAL_MS;
  if (shouldCleanup) {
    g.__purrVerifySharesCleanupAt = now;
  }

  try {
    const dir = sharesDir();
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    // Build a set of tokens that exist on disk so we can drop in-memory
    // entries that were deleted from disk.
    const diskTokens = new Set<string>();
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const tokenStr = f.replace(/\.json$/, "");
      diskTokens.add(tokenStr);
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const t = JSON.parse(raw) as ShareToken;
        // Skip expired tokens (and clean them up off disk).
        if (new Date(t.expiresAt).getTime() < now) {
          await removePersisted(t.token).catch(() => {});
          continue;
        }
        // Skip revoked tokens older than 24h (and clean them up off disk).
        if (t.revokedAt) {
          const revokedMs = new Date(t.revokedAt).getTime();
          if (now - revokedMs > 24 * 60 * 60 * 1000) {
            await removePersisted(t.token).catch(() => {});
            continue;
          }
        }
        tokens.set(t.token, t);
      } catch {
        // skip corrupt file
      }
    }
    // Drop in-memory tokens that no longer exist on disk (deleted via
    // removePersisted or by another route).
    for (const key of Array.from(tokens.keys())) {
      if (!diskTokens.has(key)) {
        tokens.delete(key);
      }
    }
  } catch {
    // ignore
  }

  // Opportunistic in-memory cleanup of expired/revoked tokens (doesn't touch
  // disk — that's handled above when we re-read).
  if (shouldCleanup) {
    for (const [key, t] of Array.from(tokens.entries())) {
      const expired = new Date(t.expiresAt).getTime() < now;
      const revokedOld = t.revokedAt && now - new Date(t.revokedAt).getTime() > 24 * 60 * 60 * 1000;
      if (expired || revokedOld) {
        tokens.delete(key);
      }
    }
  }
}

function generateToken(): string {
  // 24 bytes of randomness → 32 chars base64url. Plenty of entropy for a
  // share link that lives ≤7 days.
  return randomBytes(24).toString("base64url");
}

export interface CreateShareOptions {
  ttlHours?: number;
  note?: string;
}

export async function createShareToken(
  jobId: string,
  opts: CreateShareOptions = {}
): Promise<ShareToken> {
  await loadPersisted();
  await loadPersistedShares();

  const job = getJob(jobId);
  if (!job) {
    throw new Error(`job not found: ${jobId}`);
  }

  const ttlHours = Math.min(Math.max(opts.ttlHours ?? DEFAULT_TTL_HOURS, 1), MAX_TTL_HOURS);
  const now = new Date();
  const expires = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  const t: ShareToken = {
    token: generateToken(),
    jobId,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    revokedAt: null,
    createdBy: null,
    note: opts.note?.trim() || null,
  };

  tokens.set(t.token, t);
  await persist(t);
  return t;
}

export async function revokeShareToken(tokenStr: string): Promise<boolean> {
  await loadPersistedShares();
  const t = tokens.get(tokenStr);
  if (!t) return false;
  t.revokedAt = new Date().toISOString();
  await persist(t);
  return true;
}

export async function revokeAllForJob(jobId: string): Promise<number> {
  await loadPersistedShares();
  let n = 0;
  const now = new Date().toISOString();
  for (const t of tokens.values()) {
    if (t.jobId === jobId && !t.revokedAt) {
      t.revokedAt = now;
      await persist(t);
      n++;
    }
  }
  return n;
}

export async function listShareTokensForJob(jobId: string): Promise<ShareToken[]> {
  await loadPersistedShares();
  const now = Date.now();
  return Array.from(tokens.values())
    .filter((t) => t.jobId === jobId)
    .filter((t) => !t.revokedAt && new Date(t.expiresAt).getTime() > now)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

export interface ResolvedShare {
  ok: boolean;
  reason?: string;
  token?: ShareToken;
  job?: Job;
}

// Resolve a share token to its job. Returns ok=false if the token is invalid,
// expired, revoked, or the job no longer exists. Does NOT require auth.
export async function resolveShareToken(tokenStr: string): Promise<ResolvedShare> {
  await loadPersisted();
  await loadPersistedShares();

  const t = tokens.get(tokenStr);
  if (!t) return { ok: false, reason: "invalid or unknown share token" };
  if (t.revokedAt) return { ok: false, reason: "share token has been revoked" };
  if (new Date(t.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: "share token has expired" };
  }

  const job = getJob(t.jobId);
  if (!job) return { ok: false, reason: "shared job no longer exists" };

  return { ok: true, token: t, job };
}

// Convert a Job to a public-safe view (strips callback_url, webhook
// deliveries, and metadata). Stdout/stderr is kept because that's the value
// of sharing.
export function toPublicView(job: Job, token: ShareToken): PublicJobView {
  return {
    jobId: job.jobId,
    repo: job.repo,
    ref: job.ref,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    queuedAt: job.queuedAt,
    commands: job.commands,
    summary: job.summary,
    continue_on_error: job.continue_on_error,
    error: job.error,
    cleanupStatus: job.cleanupStatus,
    tags: job.tags,
    actual_head: job.actual_head,
    sharedVia: {
      token: token.token,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
    },
  };
}

// Note: expired/revoked token cleanup happens automatically inside
// loadPersistedShares() (throttled to once per 5 minutes via a globalThis
// timestamp). No separate cleanup function is needed.
