import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { handleBrowserWorkMcpTool } from "./browser-work-mcp";

const roots: string[] = [];
const state = globalThis as typeof globalThis & { __purrBrowserWorkManager?: unknown };
const originalManager = state.__purrBrowserWorkManager;
const originalDataDir = process.env.VERIFY_DATA_DIR;

afterEach(async () => {
  if (originalManager) state.__purrBrowserWorkManager = originalManager;
  else delete state.__purrBrowserWorkManager;
  if (originalDataDir === undefined) delete process.env.VERIFY_DATA_DIR;
  else process.env.VERIFY_DATA_DIR = originalDataDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "purr-media-mcp-"));
  roots.push(dataDir);
  const outputDir = path.join(dataDir, "browser-work", "media-session");
  await mkdir(path.join(outputDir, "video"), { recursive: true });
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  }).png().toBuffer();
  const sourceOut = path.join(outputDir, "source.png");
  await writeFile(sourceOut, png);
  const video = path.join(outputDir, "video", "capture.webm");
  await writeFile(video, Buffer.from("1a45dfa3", "hex"));
  const gif = path.join(outputDir, "motion.gif");
  await writeFile(gif, Buffer.from("474946383961", "hex"));
  return { dataDir, outputDir, png, sourceOut, video };
}

describe("browser work media MCP delivery", () => {
  test("transcodes screenshots to WebP inline without materializable attachments by default", async () => {
    const { dataDir, outputDir, png, sourceOut } = await fixture();
    process.env.VERIFY_DATA_DIR = dataDir;
    let screenshotOptions: Record<string, unknown> | undefined;
    state.__purrBrowserWorkManager = {
      status: () => ({ outputDir, url: "http://127.0.0.1:3000/" }),
      screenshot: async (_sessionId: string, options: Record<string, unknown>) => {
        screenshotOptions = options;
        return {
          metadata: {
            sessionId: "media-session",
            out: sourceOut,
            url: "http://127.0.0.1:3000/",
            captureMode: "cdp-viewport-fallback",
            fallbackUsed: true,
            elapsedMs: 42,
            requestedTimeoutMs: 321,
            attempts: [
              { strategy: "playwright", status: "failed", durationMs: 21, errorCode: "CAPTURE_TIMEOUT" },
              { strategy: "cdp", status: "success", durationMs: 18 },
            ],
            image: { width: 2, height: 2, bytes: png.length, mimeType: "image/png" },
            fallbackError: "Playwright capture timed out",
          },
          data: png.toString("base64"),
          mimeType: "image/png",
        };
      },
    };

    const result = await handleBrowserWorkMcpTool("purr_work_session_screenshot", {
      sessionId: "media-session",
      format: "webp",
      quality: 82,
      strategy: "cdp",
      animations: "allow",
      timeoutMs: 321,
    });
    const content = result.content ?? [];
    expect(content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(content[1]?.mimeType).toBe("image/webp");
    expect(screenshotOptions).toEqual({
      full: false,
      selector: undefined,
      timeoutMs: 321,
      strategy: "cdp",
      animations: "allow",
    });
    expect(result.payload).toMatchObject({
      captureMode: "cdp-viewport-fallback",
      fallbackUsed: true,
      elapsedMs: 42,
      requestedTimeoutMs: 321,
      attempts: [
        { strategy: "playwright", status: "failed", durationMs: 21, errorCode: "CAPTURE_TIMEOUT" },
        { strategy: "cdp", status: "success", durationMs: 18 },
      ],
      image: { width: 2, height: 2, bytes: png.length, mimeType: "image/png" },
      fallbackError: "Playwright capture timed out",
      artifact: { mimeType: "image/webp" },
    });

    const attached = await handleBrowserWorkMcpTool("purr_work_session_screenshot", {
      sessionId: "media-session",
      format: "webp",
      quality: 82,
      includeAttachments: true,
    });
    expect(attached.content?.map((entry) => entry.type)).toEqual([
      "text",
      "image",
      "resource_link",
    ]);
    expect(attached.content?.[2]).toMatchObject({
      type: "resource_link",
      mimeType: "image/webp",
    });
    expect(String(attached.content?.[2]?.name)).toEndWith(".webp");
  });

  test("lists GIF and video metadata without attachments and keeps attachment delivery opt-in", async () => {
    const { dataDir, outputDir, video } = await fixture();
    process.env.VERIFY_DATA_DIR = dataDir;
    state.__purrBrowserWorkManager = {
      status: () => ({ outputDir, url: "http://127.0.0.1:3000/" }),
      close: async () => ({
        sessionId: "media-session",
        closed: true,
        browser: { sessionId: "media-session-browser", closed: true, video },
      }),
    };

    const artifacts = await handleBrowserWorkMcpTool("purr_work_session_artifacts", {
      sessionId: "media-session",
    });
    expect(artifacts.content?.map((entry) => entry.type)).toEqual(["text"]);
    expect(artifacts.payload).toMatchObject({
      artifacts: [
        { mimeType: "image/gif" },
        { mimeType: "image/png" },
        { mimeType: "video/webm" },
      ],
    });

    const attachedArtifacts = await handleBrowserWorkMcpTool("purr_work_session_artifacts", {
      sessionId: "media-session",
      includeAttachments: true,
    });
    expect((attachedArtifacts.content ?? []).filter((entry) => entry.type === "resource_link")
      .map((entry) => entry.mimeType)).toEqual(["image/gif", "image/png", "video/webm"]);

    const closed = await handleBrowserWorkMcpTool("purr_work_session_close", {
      sessionId: "media-session",
    });
    expect(closed.content?.map((entry) => entry.type)).toEqual(["text"]);
    expect(closed.payload).toMatchObject({
      videoArtifact: { mimeType: "video/webm", name: "capture.webm" },
    });

    const attachedClose = await handleBrowserWorkMcpTool("purr_work_session_close", {
      sessionId: "media-session",
      includeAttachments: true,
    });
    expect(attachedClose.content?.map((entry) => entry.type)).toEqual([
      "text",
      "resource_link",
    ]);
    expect(attachedClose.content?.[1]).toMatchObject({
      type: "resource_link",
      mimeType: "video/webm",
      name: "capture.webm",
    });
  });
});