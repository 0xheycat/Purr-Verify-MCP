import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_UPLOAD_MCP_TOOLS,
  handleFileUploadMcpTool,
  uploadFile,
} from "./file-upload-mcp";

const roots: string[] = [];

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "purr-upload-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("binary connector file upload", () => {
  test("exposes one file-bound mutation tool without format or size caps", () => {
    expect(FILE_UPLOAD_MCP_TOOLS).toHaveLength(1);
    expect(FILE_UPLOAD_MCP_TOOLS[0]).toMatchObject({
      name: "purr_upload_file",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
      _meta: { "openai/fileParams": ["file"] },
    });
    const schema = JSON.stringify(FILE_UPLOAD_MCP_TOOLS[0].inputSchema);
    expect(schema).toContain('"required":["file","destination","sha256"]');
    expect(schema).not.toMatch(/maxLength|maximum|maxBytes|mimeTypes|extensions/);
  });

  test("streams opaque local binary bytes and creates parent directories", async () => {
    const root = await tempRoot();
    const source = join(root, "source.anything");
    const destination = join(root, "deep", "nested", "artifact.custom");
    const bytes = Buffer.concat([
      Buffer.from([0, 255, 1, 2, 0, 128]),
      randomBytes(1024 * 1024 + 37),
    ]);
    await writeFile(source, bytes);

    const result = await handleFileUploadMcpTool("purr_upload_file", {
      file: source,
      destination,
      sha256: sha256(bytes),
    });

    expect(result).toMatchObject({
      handled: true,
      payload: {
        destination,
        sha256: sha256(bytes),
        bytesWritten: bytes.byteLength,
        replaced: false,
        sourceKind: "local",
        sourceName: "source.anything",
        atomic: true,
      },
    });
    expect(await readFile(destination)).toEqual(bytes);
  });

  test("streams a connector download object without persisting its signed URL", async () => {
    const root = await tempRoot();
    const destination = join(root, "downloaded.bin");
    const bytes = randomBytes(65_537);
    const signedUrl = "https://files.example.test/private-token-value";

    const result = await uploadFile(
      {
        file: {
          file_id: "file-test",
          download_url: signedUrl,
          name: "payload.bin",
          mime_type: "application/octet-stream",
          size: bytes.byteLength,
        },
        destination,
        sha256: sha256(bytes),
      },
      {
        fetchImpl: (async (url) => {
          expect(String(url)).toBe(signedUrl);
          return new Response(bytes, { status: 200 });
        }) as typeof fetch,
      },
    );

    expect(result).toMatchObject({
      destination,
      sha256: sha256(bytes),
      bytesWritten: bytes.byteLength,
      sourceKind: "connector_download",
      sourceName: "payload.bin",
    });
    expect(JSON.stringify(result)).not.toContain("private-token-value");
    expect(await readFile(destination)).toEqual(bytes);
  });

  test("leaves an existing destination unchanged when sha256 does not match", async () => {
    const root = await tempRoot();
    const source = join(root, "source.bin");
    const destination = join(root, "existing.bin");
    const original = Buffer.from("keep-existing-destination");
    const replacement = Buffer.from("replacement-data");
    await writeFile(source, replacement);
    await writeFile(destination, original);

    const result = await handleFileUploadMcpTool("purr_upload_file", {
      file: source,
      destination,
      sha256: "0".repeat(64),
    });

    expect(result).toMatchObject({
      handled: true,
      isError: true,
      payload: { error: "sha256_mismatch" },
    });
    expect(await readFile(destination)).toEqual(original);
  });

  test("atomically replaces an existing destination after checksum verification", async () => {
    const root = await tempRoot();
    const source = join(root, "source.bin");
    const destination = join(root, "existing.bin");
    const bytes = randomBytes(131_073);
    await writeFile(source, bytes);
    await writeFile(destination, Buffer.from("old"));

    const result = await uploadFile({ file: source, destination, sha256: sha256(bytes) });

    expect(result.replaced).toBe(true);
    expect(result.atomic).toBe(true);
    expect(await readFile(destination)).toEqual(bytes);
  });

  test("requires only an absolute destination and a valid sha256", async () => {
    const result = await handleFileUploadMcpTool("purr_upload_file", {
      file: "/tmp/source.bin",
      destination: "relative/output.bin",
      sha256: "not-a-digest",
    });
    expect(result).toMatchObject({
      handled: true,
      isError: true,
      payload: { error: "invalid_destination" },
    });
  });

  test("does not intercept unrelated tools", async () => {
    expect(await handleFileUploadMcpTool("health_check", {})).toEqual({ handled: false });
  });
});