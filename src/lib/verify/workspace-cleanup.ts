import fs from "node:fs/promises";
import path from "node:path";
import type { CleanupResult } from "./types";

export interface DirectoryRemovalResult {
  removed: boolean;
  error: string | null;
}

export interface JanitorEntry {
  jobId: string;
  path: string;
  kind: "workspace" | "cache";
  removed: boolean;
  error: string | null;
}

const JOB_DIRECTORY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-[0-9a-f]{8}(-cache)?$/i;

export async function removeDirectory(dir: string): Promise<DirectoryRemovalResult> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
    const stillExists = await fs.stat(dir).then(() => true).catch(() => false);
    return stillExists
      ? { removed: false, error: "directory still exists after removal" }
      : { removed: true, error: null };
  } catch (error) {
    return {
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function cleanupJobDirectories(
  workspaceDir: string,
  cacheDir: string
): Promise<CleanupResult> {
  const startedAt = new Date().toISOString();
  const [workspace, cache] = await Promise.all([
    removeDirectory(workspaceDir),
    removeDirectory(cacheDir),
  ]);
  const successCount = Number(workspace.removed) + Number(cache.removed);
  const status: CleanupResult["status"] =
    successCount === 2 ? "done" : successCount === 1 ? "partial" : "failed";

  return {
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    workspaceRemoved: workspace.removed,
    cacheRemoved: cache.removed,
    workspaceError: workspace.error,
    cacheError: cache.error,
  };
}

export async function runWorkspaceJanitor(options: {
  root: string;
  activeJobIds: Set<string>;
  olderThanMs: number;
  nowMs?: number;
}): Promise<JanitorEntry[]> {
  const nowMs = options.nowMs ?? Date.now();
  const entries = await fs.readdir(options.root, { withFileTypes: true }).catch(() => []);
  const results: JanitorEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = JOB_DIRECTORY_RE.exec(entry.name);
    if (!match) continue;
    const jobId = match[1];
    if (options.activeJobIds.has(jobId)) continue;

    const target = path.join(options.root, entry.name);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || nowMs - stat.mtimeMs < options.olderThanMs) continue;

    const removal = await removeDirectory(target);
    results.push({
      jobId,
      path: target,
      kind: match[2] ? "cache" : "workspace",
      removed: removal.removed,
      error: removal.error,
    });
  }

  return results;
}
