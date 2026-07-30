import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { VERIFY_MCP_APP_URI } from "@/lib/verify/mcp-app";
import { browserWorkScreenshotResourceLink } from "@/lib/verify/browser-work-resource";
import { POST } from "./route";

const roots: string[] = [];
const original = {
  authMode: process.env.AUTH_MODE,
  verifyToken: process.env.VERIFY_TOKEN,
  dataDir: process.env.VERIFY_DATA_DIR,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (original.authMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = original.authMode;
  if (original.verifyToken === undefined) delete process.env.VERIFY_TOKEN;
  else process.env.VERIFY_TOKEN = original.verifyToken;
  if (original.dataDir === undefined) delete process.env.VERIFY_DATA_DIR;
  else process.env.VERIFY_DATA_DIR = original.dataDir;
});

function resourceRequest(uri: string, token?: string) {
  return new NextRequest("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "resource-read",
      method: "resources/read",
      params: { uri },
    }),
  });
}

async function screenshotFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "purr-route-resource-"));
  roots.push(dataDir);
  const screenshot = path.join(dataDir, "browser-work", "session-a", "shot.png");
  await mkdir(path.dirname(screenshot), { recursive: true });
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(screenshot, bytes);
  const link = browserWorkScreenshotResourceLink(
    { sessionId: "session-a", out: screenshot, url: "http://127.0.0.1:3000/" },
    bytes.toString("base64"),
    "image/png",
    dataDir,
  );
  return { dataDir, bytes, uri: link!.uri };
}

describe("MCP browser screenshot resources", () => {
  test("keeps the MCP App resource publicly readable", async () => {
    const response = await POST(resourceRequest(VERIFY_MCP_APP_URI));
    expect(response.status).toBe(200);
    const packet = await response.json();
    expect(packet.result.contents[0].uri).toBe(VERIFY_MCP_APP_URI);
  });

  test("requires authentication before reading browser screenshot bytes", async () => {
    const { dataDir, uri } = await screenshotFixture();
    process.env.AUTH_MODE = "server_token";
    process.env.VERIFY_TOKEN = "test";
    process.env.VERIFY_DATA_DIR = dataDir;

    const response = await POST(resourceRequest(uri));
    expect(response.status).toBe(401);
    const packet = await response.json();
    expect(packet.error.code).toBe(-32001);
  });

  test("returns exact PNG bytes to an authenticated resource reader", async () => {
    const { dataDir, bytes, uri } = await screenshotFixture();
    process.env.AUTH_MODE = "server_token";
    process.env.VERIFY_TOKEN = "test";
    process.env.VERIFY_DATA_DIR = dataDir;

    const response = await POST(resourceRequest(uri, "test"));
    expect(response.status).toBe(200);
    const packet = await response.json();
    expect(packet.result).toEqual({
      contents: [{ uri, mimeType: "image/png", blob: bytes.toString("base64") }],
    });
  });
});