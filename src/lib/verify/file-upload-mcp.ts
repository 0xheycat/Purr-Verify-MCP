import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

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

export interface UploadFileInput {
  file: FileUploadSource;
  destination: string;
  sha256: string;
}

export interface UploadFileResult {
  destination: string;
  sha256: string;
  bytesWritten: number | string;
  replaced: boolean;
  sourceKind: "local" | "connector_download";
  sourceName: string | null;
  atomic: true;
}

interface UploadDependencies {
  fetchImpl?: typeof fetch;
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
      "Stream one local ChatGPT connector file to an absolute server destination, verify its required SHA-256, and atomically replace the destination. Accepts every file format and applies no application-level byte limit.",
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
      },
      required: ["file", "destination", "sha256"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    _meta: {
      "openai/fileParams": ["file"],
    },
  },
];

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

function validateDestination(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FileUploadError("invalid_destination", "destination is required");
  }
  const destination = value.trim();
  if (!isAbsolute(destination)) {
    throw new FileUploadError("invalid_destination", "destination must be an absolute path");
  }
  return destination;
}

function validateSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new FileUploadError("invalid_sha256", "sha256 must be exactly 64 hexadecimal characters");
  }
  return value.trim().toLowerCase();
}

async function sourceStream(
  source: ReturnType<typeof resolveSource>,
  fetchImpl: typeof fetch,
): Promise<Readable> {
  if (source.kind === "local") return createReadStream(source.path);

  const response = await fetchImpl(source.url, { redirect: "follow" });
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

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function uploadFile(
  input: UploadFileInput,
  dependencies: UploadDependencies = {},
): Promise<UploadFileResult> {
  const destination = validateDestination(input.destination);
  const expectedSha256 = validateSha256(input.sha256);
  const source = resolveSource(input.file);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const current = await existingFileMode(destination);
  const temporary = `${parent}/.${basename(destination)}.purr-upload-${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let bytes = BigInt(0);

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += BigInt(buffer.byteLength);
      callback(null, buffer);
    },
  });

  try {
    const readable = await sourceStream(source, dependencies.fetchImpl ?? fetch);
    await pipeline(
      readable,
      meter,
      createWriteStream(temporary, { flags: "wx", mode: current.mode }),
    );
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new FileUploadError(
        "sha256_mismatch",
        `sha256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
      );
    }
    await syncPath(temporary);
    await rename(temporary, destination);
    try {
      await syncPath(parent);
    } catch {
      // Some filesystems do not support fsync on directories. The atomic rename remains valid.
    }
    return {
      destination,
      sha256: actualSha256,
      bytesWritten:
        bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : bytes.toString(),
      replaced: current.replaced,
      sourceKind: source.kind,
      sourceName: source.name,
      atomic: true,
    };
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw caught;
  }
}

export async function handleFileUploadMcpTool(
  name: string | undefined,
  args: Record<string, unknown>,
): Promise<FileUploadMcpToolResult> {
  if (name !== "purr_upload_file") return { handled: false };
  try {
    const payload = await uploadFile({
      file: args.file as FileUploadSource,
      destination: args.destination as string,
      sha256: args.sha256 as string,
    });
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