import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { browserWorkArtifactMimeType } from "./browser-work-resource";

interface BrowserScreenshotResult {
  metadata: Record<string, unknown>;
  data?: string;
  mimeType: string;
}

interface BrowserScreenshotOutputOptions {
  format?: string;
  quality?: number;
  out?: string;
  outputDir: string;
  includeData?: boolean;
}

const FORMAT_ALIASES: Record<string, string> = {
  jpg: "jpeg",
};

const FORMAT_EXTENSIONS: Record<string, string> = {
  jpeg: ".jpg",
};

function cleanFormat(value: unknown, out?: string): string {
  const requested = String(value ?? "").trim().toLowerCase();
  const inferred = out ? path.extname(out).replace(/^\./, "").toLowerCase() : "";
  const candidate = requested || inferred || "png";
  const normalized = FORMAT_ALIASES[candidate] ?? candidate;
  if (!/^[a-z0-9]+$/.test(normalized)) {
    throw new Error("screenshot format must use letters or numbers only");
  }
  return normalized;
}

function outputExtension(format: string): string {
  return FORMAT_EXTENSIONS[format] ?? `.${format}`;
}

function boundedQuality(value: unknown): number | undefined {
  const quality = Number(value);
  if (!Number.isFinite(quality)) return undefined;
  return Math.max(1, Math.min(100, Math.round(quality)));
}

function managedOutputPath(rawOut: string, outputDir: string, format: string, requestedOut?: string): string {
  const extension = outputExtension(format);
  const requestedBase = requestedOut ? path.basename(requestedOut, path.extname(requestedOut)) : "";
  const rawBase = path.basename(rawOut, path.extname(rawOut));
  const base = (requestedBase || rawBase || `browser-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(outputDir, `${base}${extension}`);
}

async function encode(source: Buffer, format: string, quality?: number): Promise<Buffer> {
  let pipeline = sharp(source, { animated: true });
  if (format === "png") pipeline = pipeline.png(quality ? { quality } : undefined);
  else if (format === "jpeg") pipeline = pipeline.jpeg(quality ? { quality } : undefined);
  else if (format === "webp") pipeline = pipeline.webp(quality ? { quality } : undefined);
  else if (format === "gif") pipeline = pipeline.gif();
  else pipeline = pipeline.toFormat(format as keyof sharp.FormatEnum, quality ? { quality } : undefined);
  return pipeline.toBuffer();
}

export async function transcodeBrowserScreenshot(
  result: BrowserScreenshotResult,
  options: BrowserScreenshotOutputOptions,
): Promise<BrowserScreenshotResult> {
  const rawOut = typeof result.metadata.out === "string" ? result.metadata.out : "";
  const requestedOut = String(options.out ?? "").trim() || undefined;
  const format = cleanFormat(options.format, requestedOut);
  const quality = boundedQuality(options.quality);
  const source = result.data
    ? Buffer.from(result.data, "base64")
    : await fs.readFile(rawOut);
  const managedOut = managedOutputPath(rawOut, options.outputDir, format, requestedOut);
  const encoded = format === "png" && result.mimeType === "image/png"
    ? source
    : await encode(source, format, quality);

  await fs.mkdir(path.dirname(managedOut), { recursive: true });
  await fs.writeFile(managedOut, encoded);
  if (requestedOut && path.resolve(requestedOut) !== path.resolve(managedOut)) {
    await fs.mkdir(path.dirname(path.resolve(requestedOut)), { recursive: true });
    await fs.writeFile(path.resolve(requestedOut), encoded);
  }

  const mimeType = browserWorkArtifactMimeType(managedOut, format === "jpeg" ? "image/jpeg" : `image/${format}`);
  return {
    metadata: {
      ...result.metadata,
      sourceOut: rawOut || undefined,
      out: managedOut,
      requestedOut,
      format,
      quality,
    },
    ...(options.includeData !== false ? { data: encoded.toString("base64") } : {}),
    mimeType,
  };
}