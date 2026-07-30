import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";

const BROWSER_WORK_RESOURCE_ORIGIN = "purr://browser-work";

interface BrowserWorkScreenshotMetadata {
  sessionId?: unknown;
  out?: unknown;
  url?: unknown;
}

interface BrowserWorkResourceLink extends Record<string, unknown> {
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

export function browserWorkScreenshotResourceLink(
  metadata: BrowserWorkScreenshotMetadata,
  data: string,
  mimeType: string,
  dataDir?: string,
): BrowserWorkResourceLink | undefined {
  const out = typeof metadata.out === "string" ? metadata.out : "";
  if (!out || mimeType !== "image/png") return undefined;

  const root = browserWorkRoot(dataDir);
  const absoluteOut = path.resolve(out);
  if (!isWithin(root, absoluteOut)) return undefined;

  const relativePath = path.relative(root, absoluteOut);
  const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : "browser session";
  const pageUrl = typeof metadata.url === "string" ? metadata.url : "the current page";
  return {
    type: "resource_link",
    uri: resourceUri(relativePath),
    name: path.basename(absoluteOut),
    title: `Browser screenshot: ${sessionId}`,
    description: `PNG screenshot captured from ${pageUrl}. Fetch with resources/read when inline image content is unavailable.`,
    mimeType,
    size: Buffer.from(data, "base64").byteLength,
    annotations: {
      audience: ["assistant", "user"],
      priority: 1,
    },
  };
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
    if (!stat.isFile() || path.extname(realCandidate).toLowerCase() !== ".png") return null;
    const data = await fs.readFile(realCandidate);
    return {
      contents: [
        {
          uri,
          mimeType: "image/png",
          blob: data.toString("base64"),
        },
      ],
    };
  } catch {
    return null;
  }
}