import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";

const BROWSER_WORK_RESOURCE_ORIGIN = "purr://browser-work";

interface BrowserWorkArtifactMetadata {
  sessionId?: unknown;
  out?: unknown;
  url?: unknown;
}

interface BrowserWorkArtifactListMetadata {
  sessionId?: unknown;
  outputDir?: unknown;
  url?: unknown;
}

export interface BrowserWorkResourceLink extends Record<string, unknown> {
  type: "resource_link";
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  size: number;
  annotations: {
    audience: ["assistant", "user"];
    priority: number;
  };
}

interface BrowserWorkResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType: string;
    blob: string;
  }>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
};

function browserWorkRoot(dataDir = getConfig().dataDir): string {
  return path.resolve(dataDir, "browser-work");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function resourceUri(relativePath: string): string {
  const token = Buffer.from(relativePath, "utf8").toString("base64url");
  return `${BROWSER_WORK_RESOURCE_ORIGIN}/${token}`;
}

function resourcePath(uri: string, dataDir?: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "purr:" || parsed.hostname !== "browser-work") return null;
  const token = parsed.pathname.replace(/^\/+/, "");
  if (!token || token.includes("/")) return null;

  let relativePath: string;
  try {
    relativePath = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!relativePath || path.isAbsolute(relativePath)) return null;

  const root = browserWorkRoot(dataDir);
  const candidate = path.resolve(root, relativePath);
  return isWithin(root, candidate) ? candidate : null;
}

export function browserWorkArtifactMimeType(file: string, explicit?: string): string {
  const supplied = String(explicit ?? "").trim().toLowerCase();
  if (supplied) return supplied;
  return MIME_BY_EXTENSION[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function artifactKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "visual artifact";
}

export function browserWorkArtifactResourceLink(
  metadata: BrowserWorkArtifactMetadata,
  data?: string,
  mimeType?: string,
  dataDir?: string,
): BrowserWorkResourceLink | undefined {
  const out = typeof metadata.out === "string" ? metadata.out : "";
  if (!out) return undefined;

  const root = browserWorkRoot(dataDir);
  const absoluteOut = path.resolve(out);
  if (!isWithin(root, absoluteOut)) return undefined;

  const relativePath = path.relative(root, absoluteOut);
  const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : "browser session";
  const pageUrl = typeof metadata.url === "string" ? metadata.url : "the current page";
  const resolvedMimeType = browserWorkArtifactMimeType(absoluteOut, mimeType);
  let size = data ? Buffer.from(data, "base64").byteLength : 0;
  if (!size) {
    try {
      size = statSync(absoluteOut).size;
    } catch {
      size = 0;
    }
  }
  const kind = artifactKind(resolvedMimeType);
  return {
    type: "resource_link",
    uri: resourceUri(relativePath),
    name: path.basename(absoluteOut),
    title: `Browser ${kind}: ${sessionId}`,
    description: `${kind[0].toUpperCase()}${kind.slice(1)} captured from ${pageUrl}. Fetch with resources/read when inline media is unavailable.`,
    mimeType: resolvedMimeType,
    size,
    annotations: {
      audience: ["assistant", "user"],
      priority: 1,
    },
  };
}

export const browserWorkScreenshotResourceLink = browserWorkArtifactResourceLink;

export async function listBrowserWorkArtifactLinks(
  metadata: BrowserWorkArtifactListMetadata,
  dataDir?: string,
): Promise<BrowserWorkResourceLink[]> {
  const outputDir = typeof metadata.outputDir === "string" ? path.resolve(metadata.outputDir) : "";
  if (!outputDir) return [];
  const root = browserWorkRoot(dataDir);
  if (!isWithin(root, outputDir)) return [];

  let realRoot: string;
  let realOutputDir: string;
  try {
    [realRoot, realOutputDir] = await Promise.all([fs.realpath(root), fs.realpath(outputDir)]);
  } catch {
    return [];
  }
  if (!isWithin(realRoot, realOutputDir)) return [];

  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(realOutputDir);
  files.sort((left, right) => path.relative(realOutputDir, left).localeCompare(path.relative(realOutputDir, right)));

  return files.flatMap((out) => {
    const link = browserWorkArtifactResourceLink(
      { sessionId: metadata.sessionId, out, url: metadata.url },
      undefined,
      undefined,
      dataDir,
    );
    return link ? [link] : [];
  });
}

export async function readBrowserWorkResource(
  uri: string,
  dataDir?: string,
): Promise<BrowserWorkResourceReadResult | null> {
  const candidate = resourcePath(uri, dataDir);
  if (!candidate) return null;

  try {
    const root = browserWorkRoot(dataDir);
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(root),
      fs.realpath(candidate),
    ]);
    if (!isWithin(realRoot, realCandidate)) return null;

    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) return null;
    const data = await fs.readFile(realCandidate);
    return {
      contents: [
        {
          uri,
          mimeType: browserWorkArtifactMimeType(realCandidate),
          blob: data.toString("base64"),
        },
      ],
    };
  } catch {
    return null;
  }
}