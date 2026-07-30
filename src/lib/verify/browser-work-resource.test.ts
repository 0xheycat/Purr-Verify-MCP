import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browserWorkScreenshotResourceLink,
  readBrowserWorkResource,
} from "./browser-work-resource";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "purr-browser-resource-"));
  roots.push(dataDir);
  const screenshot = path.join(dataDir, "browser-work", "session-a", "shot.png");
  await mkdir(path.dirname(screenshot), { recursive: true });
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(screenshot, bytes);
  return { dataDir, screenshot, bytes };
}

describe("browser work screenshot resources", () => {
  test("creates a bounded resource link and reads the exact PNG bytes", async () => {
    const { dataDir, screenshot, bytes } = await fixture();
    const link = browserWorkScreenshotResourceLink(
      {
        sessionId: "session-a",
        out: screenshot,
        url: "http://127.0.0.1:3000/",
      },
      bytes.toString("base64"),
      "image/png",
      dataDir,
    );

    expect(link).toMatchObject({
      type: "resource_link",
      name: "shot.png",
      mimeType: "image/png",
      size: bytes.length,
      annotations: { audience: ["assistant", "user"], priority: 1 },
    });
    const read = await readBrowserWorkResource(link!.uri, dataDir);
    expect(read).toEqual({
      contents: [
        {
          uri: link!.uri,
          mimeType: "image/png",
          blob: bytes.toString("base64"),
        },
      ],
    });
  });

  test("does not expose custom output paths outside browser-work data", async () => {
    const { dataDir, bytes } = await fixture();
    expect(
      browserWorkScreenshotResourceLink(
        { sessionId: "session-a", out: path.join(dataDir, "outside.png") },
        bytes.toString("base64"),
        "image/png",
        dataDir,
      ),
    ).toBeUndefined();
  });

  test("rejects a resource whose in-root path resolves through a symlink outside", async () => {
    const { dataDir, bytes } = await fixture();
    const outsideDir = await mkdtemp(path.join(tmpdir(), "purr-browser-outside-"));
    roots.push(outsideDir);
    const outside = path.join(outsideDir, "secret.png");
    await writeFile(outside, bytes);
    const linkedDir = path.join(dataDir, "browser-work", "linked");
    await symlink(outsideDir, linkedDir, "dir");

    const link = browserWorkScreenshotResourceLink(
      { sessionId: "linked", out: path.join(linkedDir, "secret.png") },
      bytes.toString("base64"),
      "image/png",
      dataDir,
    );
    expect(link).toBeDefined();
    expect(await readBrowserWorkResource(link!.uri, dataDir)).toBeNull();
  });
});