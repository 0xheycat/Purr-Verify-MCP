import { PrismaClient } from "@prisma/client";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getConfig } from "./config";
import type { Job, JobStatus } from "./types";

const TERMINAL_STATUSES = new Set<JobStatus>([
  "success",
  "failed",
  "canceled",
  "timeout",
]);

export interface HistoryQuery {
  limit?: number;
  cursor?: string;
  repo?: string;
  ref?: string;
  status?: JobStatus;
  command?: string;
  tag?: string;
  query?: string;
  from?: string;
  to?: string;
}

export interface VerificationHistorySummary {
  jobId: string;
  repo: string;
  ref: string;
  expected_head?: string;
  actual_head?: string;
  status: JobStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  failedCommand: string | null;
  commandCount: number;
  cleanupStatus: string | null;
  longRun: boolean;
  effectiveMode: "sync" | "async" | null;
  tags: string[];
}

export interface HistoryPage<T> {
  jobs: T[];
  nextCursor: string | null;
}

export interface HistoryBackendStatus {
  backend: "sqlite-wal";
  databasePath: string;
  ready: boolean;
  journalMode: string | null;
  lastError: string | null;
}

interface HistoryRow {
  job_id: string;
  repo: string;
  ref_name: string;
  expected_head: string | null;
  actual_head: string | null;
  status: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  failed_command: string | null;
  command_count: number;
  cleanup_status: string | null;
  long_run: number;
  effective_mode: string | null;
  tags_json: string;
  payload_json: string;
}

interface CursorValue {
  queuedAt: string;
  jobId: string;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(200, Math.floor(value ?? 50)));
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): CursorValue | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorValue>;
    if (typeof parsed.queuedAt !== "string" || typeof parsed.jobId !== "string") return null;
    return { queuedAt: parsed.queuedAt, jobId: parsed.jobId };
  } catch {
    return null;
  }
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToSummary(row: HistoryRow): VerificationHistorySummary {
  return {
    jobId: row.job_id,
    repo: row.repo,
    ref: row.ref_name,
    expected_head: row.expected_head ?? undefined,
    actual_head: row.actual_head ?? undefined,
    status: row.status as JobStatus,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    failedCommand: row.failed_command,
    commandCount: row.command_count,
    cleanupStatus: row.cleanup_status,
    longRun: row.long_run === 1,
    effectiveMode:
      row.effective_mode === "sync" || row.effective_mode === "async"
        ? row.effective_mode
        : null,
    tags: safeJsonArray(row.tags_json),
  };
}

function parseJob(row: Pick<HistoryRow, "payload_json">): Job | null {
  try {
    return JSON.parse(row.payload_json) as Job;
  } catch {
    return null;
  }
}

function databaseFilePath(): string {
  return path.join(getConfig().dataDir, "verify-history.sqlite");
}

export class VerificationHistoryDatabase {
  readonly filePath: string;
  private readonly client: PrismaClient;
  private initPromise: Promise<void> | null = null;
  private journalMode: string | null = null;
  private lastError: string | null = null;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.client = new PrismaClient({
      datasources: {
        db: {
          url: pathToFileURL(this.filePath).href,
        },
      },
      log: [],
    });
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const modeRows = await this.client.$queryRawUnsafe<Array<{ journal_mode?: string }>>(
      "PRAGMA journal_mode=WAL"
    );
    this.journalMode = modeRows[0]?.journal_mode ?? "wal";
    await this.client.$queryRawUnsafe("PRAGMA synchronous=NORMAL");
    await this.client.$queryRawUnsafe("PRAGMA busy_timeout=5000");
    await this.client.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS verify_jobs (
        job_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        ref_name TEXT NOT NULL,
        expected_head TEXT,
        actual_head TEXT,
        status TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        failed_command TEXT,
        command_count INTEGER NOT NULL,
        cleanup_status TEXT,
        long_run INTEGER NOT NULL DEFAULT 0,
        effective_mode TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        commands_text TEXT NOT NULL DEFAULT '',
        metadata_text TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await this.client.$executeRawUnsafe(
      "CREATE INDEX IF NOT EXISTS verify_jobs_queued_idx ON verify_jobs (queued_at DESC, job_id DESC)"
    );
    await this.client.$executeRawUnsafe(
      "CREATE INDEX IF NOT EXISTS verify_jobs_repo_idx ON verify_jobs (repo, queued_at DESC)"
    );
    await this.client.$executeRawUnsafe(
      "CREATE INDEX IF NOT EXISTS verify_jobs_status_idx ON verify_jobs (status, queued_at DESC)"
    );
    await this.client.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS verify_history_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.lastError = null;
  }

  status(): HistoryBackendStatus {
    return {
      backend: "sqlite-wal",
      databasePath: this.filePath,
      ready: this.initPromise !== null && this.lastError === null,
      journalMode: this.journalMode,
      lastError: this.lastError,
    };
  }

  async upsert(job: Job): Promise<void> {
    await this.init();
    const payload = JSON.stringify(job);
    const tags = JSON.stringify(job.tags ?? []);
    const commandsText = job.commands.map((command) => command.command).join("\n");
    const metadataText = JSON.stringify(job.metadata ?? {});
    const now = new Date().toISOString();
    await this.client.$executeRawUnsafe(
      `
        INSERT INTO verify_jobs (
          job_id, repo, ref_name, expected_head, actual_head, status,
          queued_at, started_at, finished_at, duration_ms, failed_command,
          command_count, cleanup_status, long_run, effective_mode, tags_json,
          commands_text, metadata_text, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          repo = excluded.repo,
          ref_name = excluded.ref_name,
          expected_head = excluded.expected_head,
          actual_head = excluded.actual_head,
          status = excluded.status,
          queued_at = excluded.queued_at,
          started_at = excluded.started_at,
          finished_at = excluded.finished_at,
          duration_ms = excluded.duration_ms,
          failed_command = excluded.failed_command,
          command_count = excluded.command_count,
          cleanup_status = excluded.cleanup_status,
          long_run = excluded.long_run,
          effective_mode = excluded.effective_mode,
          tags_json = excluded.tags_json,
          commands_text = excluded.commands_text,
          metadata_text = excluded.metadata_text,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `,
      job.jobId,
      job.repo,
      job.ref,
      job.expected_head ?? null,
      job.actual_head ?? null,
      job.status,
      job.queuedAt,
      job.startedAt,
      job.finishedAt,
      job.durationMs,
      job.summary.failedCommand,
      job.commands.length,
      job.cleanupStatus ?? null,
      job.timeoutPolicy?.longRun ? 1 : 0,
      job.execution?.effectiveMode ?? null,
      tags,
      commandsText,
      metadataText,
      payload,
      now
    );
  }

  async get(jobId: string): Promise<Job | null> {
    await this.init();
    const rows = await this.client.$queryRawUnsafe<HistoryRow[]>(
      "SELECT payload_json FROM verify_jobs WHERE job_id = ? LIMIT 1",
      jobId
    );
    return rows[0] ? parseJob(rows[0]) : null;
  }

  private buildWhere(query: HistoryQuery): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.repo) {
      clauses.push("repo = ?");
      params.push(query.repo);
    }
    if (query.ref) {
      clauses.push("ref_name = ?");
      params.push(query.ref);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.command) {
      clauses.push("lower(commands_text) LIKE ?");
      params.push(`%${query.command.toLowerCase()}%`);
    }
    if (query.tag) {
      clauses.push("lower(tags_json) LIKE ?");
      params.push(`%${query.tag.toLowerCase()}%`);
    }
    if (query.query) {
      const needle = `%${query.query.toLowerCase()}%`;
      clauses.push(
        "(lower(repo) LIKE ? OR lower(ref_name) LIKE ? OR lower(commands_text) LIKE ? OR lower(metadata_text) LIKE ? OR lower(payload_json) LIKE ?)"
      );
      params.push(needle, needle, needle, needle, needle);
    }
    if (query.from) {
      clauses.push("queued_at >= ?");
      params.push(query.from);
    }
    if (query.to) {
      clauses.push("queued_at <= ?");
      params.push(query.to);
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      clauses.push("(queued_at < ? OR (queued_at = ? AND job_id < ?))");
      params.push(cursor.queuedAt, cursor.queuedAt, cursor.jobId);
    }
    return {
      sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  async listSummaries(query: HistoryQuery = {}): Promise<HistoryPage<VerificationHistorySummary>> {
    await this.init();
    const limit = normalizeLimit(query.limit);
    const where = this.buildWhere(query);
    const rows = await this.client.$queryRawUnsafe<HistoryRow[]>(
      `
        SELECT job_id, repo, ref_name, expected_head, actual_head, status,
          queued_at, started_at, finished_at, duration_ms, failed_command,
          command_count, cleanup_status, long_run, effective_mode, tags_json,
          payload_json
        FROM verify_jobs
        ${where.sql}
        ORDER BY queued_at DESC, job_id DESC
        LIMIT ?
      `,
      ...where.params,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      jobs: pageRows.map(rowToSummary),
      nextCursor:
        hasMore && last
          ? encodeCursor({ queuedAt: last.queued_at, jobId: last.job_id })
          : null,
    };
  }

  async listFull(query: HistoryQuery = {}): Promise<HistoryPage<Job>> {
    await this.init();
    const limit = normalizeLimit(query.limit);
    const where = this.buildWhere(query);
    const rows = await this.client.$queryRawUnsafe<HistoryRow[]>(
      `
        SELECT job_id, queued_at, payload_json
        FROM verify_jobs
        ${where.sql}
        ORDER BY queued_at DESC, job_id DESC
        LIMIT ?
      `,
      ...where.params,
      limit + 1
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const jobs = pageRows.map(parseJob).filter((job): job is Job => job !== null);
    const last = pageRows[pageRows.length - 1];
    return {
      jobs,
      nextCursor:
        hasMore && last
          ? encodeCursor({ queuedAt: last.queued_at, jobId: last.job_id })
          : null,
    };
  }

  async latest(query: Omit<HistoryQuery, "limit" | "cursor"> = {}): Promise<Job | null> {
    const page = await this.listFull({ ...query, limit: 1 });
    return page.jobs[0] ?? null;
  }

  async count(): Promise<number> {
    await this.init();
    const rows = await this.client.$queryRawUnsafe<Array<{ count: number | bigint }>>(
      "SELECT COUNT(*) AS count FROM verify_jobs"
    );
    return Number(rows[0]?.count ?? 0);
  }

  async delete(jobId: string): Promise<boolean> {
    await this.init();
    const changed = await this.client.$executeRawUnsafe(
      "DELETE FROM verify_jobs WHERE job_id = ?",
      jobId
    );
    return Number(changed) > 0;
  }

  async deleteFinished(): Promise<number> {
    await this.init();
    const changed = await this.client.$executeRawUnsafe(
      "DELETE FROM verify_jobs WHERE status NOT IN ('queued', 'running')"
    );
    return Number(changed);
  }

  async migrateLegacyDirectory(directory: string): Promise<number> {
    await this.init();
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    let migrated = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(directory, file), "utf8");
        const job = JSON.parse(raw) as Job;
        if (!job?.jobId || !job?.queuedAt || !Array.isArray(job.commands)) continue;
        await this.upsert(job);
        migrated++;
      } catch {
        // Ignore corrupt legacy records; JSON remains on disk for manual recovery.
      }
    }
    return migrated;
  }

  async close(): Promise<void> {
    await this.client.$disconnect();
  }
}

interface HistoryGlobal {
  __purrVerifyHistory?: VerificationHistoryDatabase;
  __purrVerifyHistoryPath?: string;
}

function historyGlobal(): HistoryGlobal {
  return globalThis as HistoryGlobal;
}

export async function getHistoryDatabase(): Promise<VerificationHistoryDatabase> {
  const filePath = databaseFilePath();
  const global = historyGlobal();
  if (!global.__purrVerifyHistory || global.__purrVerifyHistoryPath !== filePath) {
    if (global.__purrVerifyHistory) {
      await global.__purrVerifyHistory.close().catch(() => {});
    }
    global.__purrVerifyHistory = new VerificationHistoryDatabase(filePath);
    global.__purrVerifyHistoryPath = filePath;
  }
  await global.__purrVerifyHistory.init();
  return global.__purrVerifyHistory;
}

export async function historyBackendStatus(): Promise<HistoryBackendStatus> {
  const db = await getHistoryDatabase();
  return db.status();
}

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export async function resetHistoryDatabaseForTests(): Promise<void> {
  const global = historyGlobal();
  if (global.__purrVerifyHistory) {
    await global.__purrVerifyHistory.close().catch(() => {});
  }
  delete global.__purrVerifyHistory;
  delete global.__purrVerifyHistoryPath;
}
