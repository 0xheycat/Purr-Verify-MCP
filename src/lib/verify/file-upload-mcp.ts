import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  clearRuntime,
  createJob,
  flushJobPersistence,
  getJob,
  getJobDurable,
  getRuntime,
  loadPersisted,
  updateJob,
} from "./store";
import type { Job } from "./types";

export interface FileUploadMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  _meta: Record<string, unknown>;
}

export interface FileUploadMcpToolResult {
  handled: boolean;
  payload?: unknown;
  isError?: boolean;
}

export interface ConnectorFileReference {
  file_id?: string;
  download_url?: string;
  downloadUrl?: string;
  name?: string;
  mime_type?: string;
  size?: number;
  path?: string;
  local_path?: string;
  localPath?: string;
  mounted_path?: string;
}

export type FileUploadSource = string | ConnectorFileReference;
export type UploadExecutionMode = "auto" | "sync" | "async";

export interface UploadFileInput {
  file: FileUploadSource;
  destination: string;
  sha256: string;
  mode?: UploadExecutionMode;
}

export interface UploadFileResult {
  destination: string;
  sha256: string;
  bytesWritten: number | string;
  replaced: boolean;
  sourceKind: "local" | "connector_download";
  sourceName: string | null;
  atomic: true;
  reusedExisting?: boolean;
  deduplicated?: boolean;
}

export interface QueuedUploadResult {
  jobId: string;
  status: "queued" | "running";
  destination: string;
  sha256: string;
  sourceKind: "local" | "connector_download";
  sourceName: string | null;
  deduplicated: boolean;
  statusTool: "purr_get_job_status";
  logsTool: "purr_get_job_logs";
  cancelTool: "purr_cancel_job";
}

interface UploadDependencies {
  fetchImpl?: typeof fetch;
  onProgress?: (bytesWritten: bigint) => void;
  isCanceled?: () => boolean;
}

class FileUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FileUploadError";
  }
}

function stringProperty(
  value: ConnectorFileReference,
  keys: Array<keyof ConnectorFileReference>,
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function localPath(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch {
      throw new FileUploadError("invalid_file_reference", "file contains an invalid file:// URL");
    }
  }
  if (!isAbsolute(value)) {
    throw new FileUploadError(
      "invalid_file_reference",
      "file must be a connector file object or an absolute mounted local path",
    );
  }
  return value;
}

function resolveSource(file: FileUploadSource):
  | { kind: "local"; path: string; name: string | null }
  | { kind: "connector_download"; url: string; name: string | null } {
  if (typeof file === "string") {
    const path = localPath(file.trim());
    return { kind: "local", path, name: basename(path) || null };
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new FileUploadError("invalid_file_reference", "file is required");
  }

  const mounted = stringProperty(file, ["local_path", "localPath", "mounted_path", "path"]);
  const name = stringProperty(file, ["name"]) ?? null;
  if (mounted) return { kind: "local", path: localPath(mounted), name };

  const downloadUrl = stringProperty(file, ["download_url", "downloadUrl"]);
  if (!downloadUrl) {
    throw new FileUploadError(
      "file_unavailable",
      "connector file does not include a mounted local path or download_url",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    throw new FileUploadError("invalid_file_reference", "connector download_url is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new FileUploadError(
      "invalid_file_reference",
      "connector download_url must use http or https",
    );
  }
  return { kind: "connector_download", url: parsed.toString(), name };
}

type ResolvedUploadSource = ReturnType<typeof resolveSource>;

interface PreparedUpload {
  destination: string;
  expectedSha256: string;
  source: ResolvedUploadSource;
}

interface UploadLeaseRecord {
  version: 1;
  token: string;
  expectedSha256: string;
  jobId?: string;
  pid: number;
  acquiredAt: string;
}

interface UploadLease {
  path: string;
  token: string;
}

interface UploadLeaseResult {
  lease?: UploadLease;
  existingJobId?: string;
}

interface ActiveUpload {
  expectedSha256: string;
  promise: Promise<UploadFileResult>;
  jobId?: string;
}

interface FileUploadGlobal {
  __purrActiveFileUploads?: Map<string, ActiveUpload>;
}

const fileUploadGlobal = globalThis as FileUploadGlobal;
const activeUploads =
  fileUploadGlobal.__purrActiveFileUploads ?? new Map<string, ActiveUpload>();
fileUploadGlobal.__purrActiveFileUploads = activeUploads;

const STREAM_HIGH_WATER_MARK = 1024 * 1024;
const LOCK_BIND_WAIT_ATTEMPTS = 40;
const LOCK_BIND_WAIT_MS = 25;
const MALFORMED_LOCK_GRACE_MS = 5_000;

const FILE_PARAMETER_SCHEMA = {
  oneOf: [
    {
      type: "string",
      description: "Absolute mounted connector-file path or file:// URL.",
    },
    {
      type: "object",
      description:
        "ChatGPT connector file reference. download_url is streamed when a mounted local path is not present.",
      properties: {
        file_id: { type: "string" },
        download_url: { type: "string" },
        downloadUrl: { type: "string" },
        name: { type: "string" },
        mime_type: { type: "string" },
        size: { type: "number" },
        path: { type: "string" },
        local_path: { type: "string" },
        localPath: { type: "string" },
        mounted_path: { type: "string" },
      },
      additionalProperties: true,
    },
  ],
  description:
    "Local connector file. Binary content is treated as opaque bytes; file extension and MIME type are not restricted.",
};

export const FILE_UPLOAD_MCP_TOOLS: FileUploadMcpToolDefinition[] = [
  {
    name: "purr_upload_file",
    description:
      "Upload one ChatGPT connector file to an absolute server destination with required SHA-256 verification and atomic replacement. Auto mode always returns immediately with a durable jobId for both connector downloads and mounted local files. Transfers use bounded-memory streaming, process-safe destination ownership, retry deduplication, cancellation, and no application-level file-size limit.",
    inputSchema: {
      type: "object",
      properties: {
        file: FILE_PARAMETER_SCHEMA,
        destination: {
          type: "string",
          description:
            "Absolute destination path on the Verify MCP server. Parent directories are created and an existing path is atomically replaced.",
        },
        sha256: {
          type: "string",
          pattern: "^[A-Fa-f0-9]{64}$",
          description: "Expected lowercase or uppercase SHA-256 hex digest.",
        },
        mode: {
          type: "string",
          enum: ["auto", "sync", "async"],
          default: "auto",
          description:
            "auto and async return a durable jobId for every source type. Use sync only for a deliberately short transfer known to fit the caller transport window.",
        },
      },
      required: ["file", "destination", "sha256"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    _meta: {
      "openai/fileParams": ["file"],
    },
  },
];

function validateDestination(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FileUploadError("invalid_destination", "destination is required");
  }
  const destination = value.trim();
  if (!isAbsolute(destination)) {
    throw new FileUploadError("invalid_destination", "destination must be an absolute path");
  }
  return resolve(destination);
}

function validateSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new FileUploadError("invalid_sha256", "sha256 must be exactly 64 hexadecimal characters");
  }
  return value.trim().toLowerCase();
}

function validateMode(value: unknown): UploadExecutionMode {
  if (value === undefined || value === null || value === "") return "auto";
  if (value === "auto" || value === "sync" || value === "async") return value;
  throw new FileUploadError("invalid_mode", "mode must be auto, sync, or async");
}

function prepareUpload(input: UploadFileInput): PreparedUpload {
  return {
    destination: validateDestination(input.destination),
    expectedSha256: validateSha256(input.sha256),
    source: resolveSource(input.file),
  };
}

function bytesValue(bytes: bigint): number | string {
  return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : bytes.toString();
}

export function uploadLockPath(destination: string): string {
  return `${dirname(destination)}/.${basename(destination)}.purr-upload.lock`;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return (caught as NodeJS.ErrnoException).code === "EPERM";
  }
}

function jobIsActive(job: Job | null | undefined): boolean {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

async function readUploadLease(path: string): Promise<UploadLeaseRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UploadLeaseRecord>;
    if (
      parsed.version !== 1 ||
      typeof parsed.token !== "string" ||
      !/^[a-f0-9-]{20,}$/i.test(parsed.token) ||
      typeof parsed.expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(parsed.expectedSha256) ||
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return null;
    }
    return parsed as UploadLeaseRecord;
  } catch {
    return null;
  }
}

async function removeUploadLeaseIfOwned(path: string, token: string): Promise<boolean> {
  const current = await readUploadLease(path);
  if (!current || current.token !== token) return false;
  await rm(path, { force: true });
  return true;
}

async function acquireUploadLease(
  prepared: PreparedUpload,
  options: { allowExistingJob: boolean },
): Promise<UploadLeaseResult> {
  const parent = dirname(prepared.destination);
  await mkdir(parent, { recursive: true });
  const path = uploadLockPath(prepared.destination);
  const token = randomUUID();

  for (let attempt = 0; attempt < LOCK_BIND_WAIT_ATTEMPTS; attempt += 1) {
    const record: UploadLeaseRecord = {
      version: 1,
      token,
      expectedSha256: prepared.expectedSha256,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { lease: { path, token } };
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "EEXIST") throw caught;
    }

    const existing = await readUploadLease(path);
    if (!existing) {
      const ageMs = await stat(path)
        .then((value) => Date.now() - value.mtimeMs)
        .catch(() => 0);
      if (ageMs >= MALFORMED_LOCK_GRACE_MS) {
        await rm(path, { force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_BIND_WAIT_MS));
      continue;
    }

    const ownerJob = existing.jobId
      ? getJob(existing.jobId) ?? (await getJobDurable(existing.jobId)) ?? null
      : null;
    const ownerAlive = processIsAlive(existing.pid);
    const knownTerminalOwner = Boolean(ownerJob && !jobIsActive(ownerJob));
    if (!ownerAlive || knownTerminalOwner) {
      await removeUploadLeaseIfOwned(path, existing.token);
      continue;
    }
    if (existing.expectedSha256 !== prepared.expectedSha256) {
      throw new FileUploadError(
        "upload_in_progress",
        `another upload is already active for ${prepared.destination}`,
      );
    }
    if (options.allowExistingJob && existing.jobId && jobIsActive(ownerJob)) {
      return { existingJobId: existing.jobId };
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_BIND_WAIT_MS));
  }

  throw new FileUploadError(
    "upload_in_progress",
    `another upload is initializing for ${prepared.destination}`,
  );
}

async function bindUploadLease(lease: UploadLease, jobId: string): Promise<void> {
  const current = await readUploadLease(lease.path);
  if (!current || current.token !== lease.token) {
    throw new FileUploadError("upload_lock_lost", "upload destination lock was lost");
  }
  const handle = await open(lease.path, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ ...current, jobId } satisfies UploadLeaseRecord));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function releaseUploadLease(lease: UploadLease | undefined): Promise<void> {
  if (!lease) return;
  await removeUploadLeaseIfOwned(lease.path, lease.token).catch(() => undefined);
}

async function sourceStream(
  source: ResolvedUploadSource,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Readable> {
  if (source.kind === "local") {
    return createReadStream(source.path, { highWaterMark: STREAM_HIGH_WATER_MARK });
  }

  const response = await fetchImpl(source.url, {
    redirect: "follow",
    signal,
    headers: { "accept-encoding": "identity" },
  });
  if (!response.ok) {
    throw new FileUploadError(
      "connector_download_failed",
      `connector download returned HTTP ${response.status}`,
    );
  }
  if (!response.body) {
    throw new FileUploadError("connector_download_failed", "connector download returned no body");
  }
  return Readable.from(response.body as unknown as AsyncIterable<Uint8Array>);
}

async function existingFileMode(destination: string): Promise<{
  replaced: boolean;
  mode: number;
}> {
  try {
    const current = await lstat(destination);
    return {
      replaced: true,
      mode: current.isFile() ? current.mode & 0o777 : 0o666,
    };
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") {
      return { replaced: false, mode: 0o666 };
    }
    throw caught;
  }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: bigint }> {
  const hash = createHash("sha256");
  let bytes = BigInt(0);
  for await (const chunk of createReadStream(path, { highWaterMark: STREAM_HIGH_WATER_MARK })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += BigInt(buffer.byteLength);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function existingVerifiedResult(
  prepared: PreparedUpload,
): Promise<UploadFileResult | null> {
  try {
    const current = await lstat(prepared.destination);
    if (!current.isFile()) return null;
    const existing = await hashFile(prepared.destination);
    if (existing.sha256 !== prepared.expectedSha256) return null;
    return {
      destination: prepared.destination,
      sha256: existing.sha256,
      bytesWritten: bytesValue(existing.bytes),
      replaced: true,
      sourceKind: prepared.source.kind,
      sourceName: prepared.source.name,
      atomic: true,
      reusedExisting: true,
    };
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw caught;
  }
}

async function cleanupTemporaryFiles(destination: string): Promise<void> {
  const parent = dirname(destination);
  const prefix = `.${basename(destination)}.purr-upload-`;
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp"),
      )
      .map((entry) => rm(`${parent}/${entry.name}`, { force: true }).catch(() => undefined)),
  );
}

async function syncPath(path: string, dataOnly = false): Promise<void> {
  const handle = await open(path, "r");
  try {
    if (dataOnly) {
      try {
        await handle.datasync();
      } catch {
        await handle.sync();
      }
    } else {
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

async function performUpload(
  prepared: PreparedUpload,
  dependencies: UploadDependencies,
  lease: UploadLease,
): Promise<UploadFileResult> {
  const parent = dirname(prepared.destination);
  let temporary: string | null = null;
  const abortController = new AbortController();
  const cancelTimer = dependencies.isCanceled
    ? setInterval(() => {
        if (dependencies.isCanceled?.()) abortController.abort();
      }, 250)
    : null;
  cancelTimer?.unref?.();

  try {
    await mkdir(parent, { recursive: true });
    await cleanupTemporaryFiles(prepared.destination);
    const reused = await existingVerifiedResult(prepared);
    if (reused) return reused;

    const current = await existingFileMode(prepared.destination);
    temporary = `${parent}/.${basename(prepared.destination)}.purr-upload-${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let bytes = BigInt(0);
    const meter = new Transform({
      highWaterMark: STREAM_HIGH_WATER_MARK,
      transform(chunk, _encoding, callback) {
        if (dependencies.isCanceled?.()) {
          callback(new FileUploadError("upload_canceled", "upload canceled"));
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        bytes += BigInt(buffer.byteLength);
        dependencies.onProgress?.(bytes);
        callback(null, buffer);
      },
    });

    const readable = await sourceStream(
      prepared.source,
      dependencies.fetchImpl ?? fetch,
      abortController.signal,
    );
    await pipeline(
      readable,
      meter,
      createWriteStream(temporary, {
        flags: "wx",
        mode: current.mode,
        highWaterMark: STREAM_HIGH_WATER_MARK,
      }),
    );
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== prepared.expectedSha256) {
      throw new FileUploadError(
        "sha256_mismatch",
        `sha256 mismatch: expected ${prepared.expectedSha256}, received ${actualSha256}`,
      );
    }
    await syncPath(temporary, true);
    await rename(temporary, prepared.destination);
    temporary = null;
    try {
      await syncPath(parent);
    } catch {
      // Some filesystems do not support fsync on directories. The atomic rename remains valid.
    }
    return {
      destination: prepared.destination,
      sha256: actualSha256,
      bytesWritten: bytesValue(bytes),
      replaced: current.replaced,
      sourceKind: prepared.source.kind,
      sourceName: prepared.source.name,
      atomic: true,
    };
  } catch (caught) {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    if (dependencies.isCanceled?.()) {
      throw new FileUploadError("upload_canceled", "upload canceled");
    }
    throw caught;
  } finally {
    if (cancelTimer) clearInterval(cancelTimer);
    await releaseUploadLease(lease);
  }
}

function startActiveUpload(
  prepared: PreparedUpload,
  dependencies: UploadDependencies,
  jobId?: string,
  preAcquiredLease?: UploadLease,
): { promise: Promise<UploadFileResult>; deduplicated: boolean; jobId?: string } {
  const active = activeUploads.get(prepared.destination);
  if (active) {
    if (preAcquiredLease) void releaseUploadLease(preAcquiredLease);
    if (active.expectedSha256 !== prepared.expectedSha256) {
      throw new FileUploadError(
        "upload_in_progress",
        `another upload is already active for ${prepared.destination}`,
      );
    }
    return { promise: active.promise, deduplicated: true, jobId: active.jobId };
  }

  let promise!: Promise<UploadFileResult>;
  promise = (async () => {
    const leaseResult = preAcquiredLease
      ? { lease: preAcquiredLease }
      : await acquireUploadLease(prepared, { allowExistingJob: false });
    if (!leaseResult.lease) {
      throw new FileUploadError("upload_in_progress", "upload destination is already active");
    }
    return performUpload(prepared, dependencies, leaseResult.lease);
  })().finally(() => {
    const current = activeUploads.get(prepared.destination);
    if (current?.promise === promise) activeUploads.delete(prepared.destination);
  });
  activeUploads.set(prepared.destination, {
    expectedSha256: prepared.expectedSha256,
    promise,
    jobId,
  });
  return { promise, deduplicated: false, jobId };
}

export async function uploadFile(
  input: UploadFileInput,
  dependencies: UploadDependencies = {},
): Promise<UploadFileResult> {
  await loadPersisted();
  const prepared = prepareUpload(input);
  const active = startActiveUpload(prepared, dependencies);
  const result = await active.promise;
  return active.deduplicated ? { ...result, deduplicated: true } : result;
}

function uploadJobCommand(prepared: PreparedUpload): string {
  return `upload ${prepared.source.name ?? "connector-file"} -> ${prepared.destination}`;
}

function startUploadJob(prepared: PreparedUpload, requestedMode: UploadExecutionMode): Job {
  const job = createJob({
    repo: "local/upload",
    ref: prepared.destination,
    commands: [uploadJobCommand(prepared)],
    continue_on_error: false,
    metadata: {
      purpose: "binary file upload",
      _purrUpload: {
        version: 1,
        destination: prepared.destination,
        sha256: prepared.expectedSha256,
        sourceKind: prepared.source.kind,
        sourceName: prepared.source.name,
      },
    },
    tags: ["operator", "upload"],
    execution: {
      requestedMode,
      effectiveMode: "async",
      routingReason:
        requestedMode === "async" ? "explicit_async_upload" : "upload_auto_routed_async",
      autoRouted: requestedMode !== "async",
    },
  });
  const startedAt = new Date().toISOString();
  const command = {
    ...job.commands[0],
    status: "running" as const,
    startedAt,
  };
  updateJob(job.jobId, {
    status: "running",
    startedAt,
    commands: [command],
    cleanupStatus: "skipped",
    cleanup: {
      status: "skipped",
      startedAt: null,
      finishedAt: null,
      workspaceRemoved: true,
      cacheRemoved: true,
    },
  });
  return getJob(job.jobId) ?? job;
}

function queueResult(
  jobId: string,
  prepared: PreparedUpload,
  deduplicated: boolean,
): QueuedUploadResult {
  return {
    jobId,
    status: "running",
    destination: prepared.destination,
    sha256: prepared.expectedSha256,
    sourceKind: prepared.source.kind,
    sourceName: prepared.source.name,
    deduplicated,
    statusTool: "purr_get_job_status",
    logsTool: "purr_get_job_logs",
    cancelTool: "purr_cancel_job",
  };
}

async function settleUploadJob(
  jobId: string,
  promise: Promise<UploadFileResult>,
): Promise<void> {
  try {
    const result = await promise;
    const job = getJob(jobId);
    if (!job) return;
    const finishedAt = new Date().toISOString();
    const command = {
      ...job.commands[0],
      status: "success" as const,
      exitCode: 0,
      durationMs: job.startedAt
        ? Math.max(0, new Date(finishedAt).getTime() - new Date(job.startedAt).getTime())
        : null,
      stdout: `${JSON.stringify(result)}\n`,
      finishedAt,
    };
    updateJob(jobId, {
      status: "success",
      finishedAt,
      durationMs: command.durationMs,
      commands: [command],
      summary: { passed: true, failedCommand: null },
      metadata: { ...job.metadata, uploadResult: result },
      error: null,
    });
  } catch (caught) {
    const job = getJob(jobId);
    if (!job) return;
    const finishedAt = new Date().toISOString();
    const error = caught instanceof FileUploadError ? caught : null;
    const canceled =
      error?.code === "upload_canceled" || getRuntime(jobId)?.cancelRequested === true;
    const message = caught instanceof Error ? caught.message : String(caught);
    const command = {
      ...job.commands[0],
      status: "failed" as const,
      exitCode: 1,
      durationMs: job.startedAt
        ? Math.max(0, new Date(finishedAt).getTime() - new Date(job.startedAt).getTime())
        : null,
      stderr: `${message}\n`,
      finishedAt,
    };
    updateJob(jobId, {
      status: canceled ? "canceled" : "failed",
      finishedAt,
      durationMs: command.durationMs,
      commands: [command],
      summary: { passed: false, failedCommand: command.command },
      error: message,
    });
  } finally {
    clearRuntime(jobId);
    await flushJobPersistence(jobId);
  }
}

async function queueUploadFile(
  input: UploadFileInput,
  requestedMode: UploadExecutionMode,
  dependencies: UploadDependencies,
): Promise<QueuedUploadResult | UploadFileResult> {
  await loadPersisted();
  const prepared = prepareUpload(input);
  const existing = activeUploads.get(prepared.destination);
  if (existing) {
    if (existing.expectedSha256 !== prepared.expectedSha256) {
      throw new FileUploadError(
        "upload_in_progress",
        `another upload is already active for ${prepared.destination}`,
      );
    }
    if (!existing.jobId) {
      throw new FileUploadError(
        "upload_in_progress",
        `a synchronous upload is already active for ${prepared.destination}`,
      );
    }
    return queueResult(existing.jobId, prepared, true);
  }

  const leaseResult = await acquireUploadLease(prepared, { allowExistingJob: true });
  if (leaseResult.existingJobId) {
    return queueResult(leaseResult.existingJobId, prepared, true);
  }
  if (!leaseResult.lease) {
    throw new FileUploadError("upload_lock_failed", "failed to reserve upload destination");
  }

  const job = startUploadJob(prepared, requestedMode);
  try {
    await flushJobPersistence(job.jobId);
    await bindUploadLease(leaseResult.lease, job.jobId);
  } catch (caught) {
    await releaseUploadLease(leaseResult.lease);
    void settleUploadJob(job.jobId, Promise.reject(caught));
    throw caught;
  }
  let lastProgressAt = 0;
  let lastProgressBytes = BigInt(0);
  const active = startActiveUpload(
    prepared,
    {
      ...dependencies,
      isCanceled: () =>
        dependencies.isCanceled?.() === true ||
        getRuntime(job.jobId)?.cancelRequested === true,
      onProgress: (bytes) => {
        dependencies.onProgress?.(bytes);
        const now = Date.now();
        if (
          now - lastProgressAt < 5_000 &&
          bytes - lastProgressBytes < BigInt(16 * 1024 * 1024)
        ) {
          return;
        }
        lastProgressAt = now;
        lastProgressBytes = bytes;
        const current = getJob(job.jobId);
        if (!current) return;
        const command = {
          ...current.commands[0],
          stdout: `uploaded ${bytes.toString()} bytes\n`,
        };
        updateJob(job.jobId, { commands: [command] });
      },
    },
    job.jobId,
    leaseResult.lease,
  );
  void settleUploadJob(job.jobId, active.promise);
  return queueResult(job.jobId, prepared, false);
}

export async function handleFileUploadMcpTool(
  name: string | undefined,
  args: Record<string, unknown>,
  dependencies: UploadDependencies = {},
): Promise<FileUploadMcpToolResult> {
  if (name !== "purr_upload_file") return { handled: false };
  try {
    const mode = validateMode(args.mode);
    const file = args.file as FileUploadSource;
    const input: UploadFileInput = {
      file,
      destination: args.destination as string,
      sha256: args.sha256 as string,
      mode,
    };
    const shouldQueue = mode !== "sync";
    const payload = shouldQueue
      ? await queueUploadFile(input, mode, dependencies)
      : await uploadFile(input, dependencies);
    return { handled: true, payload };
  } catch (caught) {
    const error = caught instanceof FileUploadError ? caught : null;
    return {
      handled: true,
      isError: true,
      payload: {
        error: error?.code ?? "file_upload_failed",
        message: caught instanceof Error ? caught.message : String(caught),
      },
    };
  }
}
