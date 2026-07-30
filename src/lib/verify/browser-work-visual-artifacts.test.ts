import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browserWorkArtifactResourceLink,
  listBrowserWorkArtifactLinks,
  readBrowserWorkResource,
} from "./browser-work-resource";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "purr-visual-artifacts-"));
  roots.push(dataDir);
  const outputDir = path.join(dataDir, "browser-work", "session-media");
  await mkdir(path.join(outputDir, "video"), { recursive: true });
  return { dataDir, outputDir };
}

describe("browser work visual artifacts", () => {
  test("reads GIF, WebM, and unknown binary artifacts without an extension whitelist", async () => {
    const { dataDir, outputDir } = await fixture();
    const cases = [
      { name: "frame.gif", bytes: Buffer.from("474946383961", "hex"), mimeType: "image/gif" },
      { name: "video/capture.webm", bytes: Buffer.from("1a45dfa3", "hex"), mimeType: "video/webm" },
      { name: "visual.custom", bytes: Buffer.from("custom-visual"), mimeType: "application/octet-stream" },
    ];

    for (const item of cases) {
      const out = path.join(outputDir, item.name);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, item.bytes);
      const link = browserWorkArtifactResourceLink(
        { sessionId: "session-media", out, url: "http://127.0.0.1:3000/" },
        undefined,
        undefined,
        dataDir,
      );
      expect(link).toMatchObject({
        type: "resource_link",
        name: path.basename(item.name),
        mimeType: item.mimeType,
        size: item.bytes.length,
      });
      expect(await readBrowserWorkResource(link!.uri, dataDir)).toEqual({
        contents: [{
          uri: link!.uri,
          mimeType: item.mimeType,
          blob: item.bytes.toString("base64"),
        }],
      });
    }
  });

  test("lists every regular artifact in a browser session output directory", async () => {
    const { dataDir, outputDir } = await fixture();
    await writeFile(path.join(outputDir, "shot.webp"), Buffer.from("52494646", "hex"));
    await writeFile(path.join(outputDir, "video", "run.webm"), Buffer.from("1a45dfa3", "hex"));

    const links = await listBrowserWorkArtifactLinks(
      { sessionId: "session-media", outputDir, url: "http://127.0.0.1:3000/" },
      dataDir,
    );

    expect(links.map((entry) => [entry.name, entry.mimeType])).toEqual([
      ["shot.webp", "image/webp"],
      ["run.webm", "video/webm"],
    ]);
  });
});