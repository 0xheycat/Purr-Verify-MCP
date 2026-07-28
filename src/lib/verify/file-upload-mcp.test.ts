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
import { getJob } from "./store";

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

async function waitForTerminalJob(jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = getJob(jobId);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`upload job did not finish: ${jobId}`);
}

describe("binary connector file upload", () => {
  test("exposes one file-bound mutation tool without format or size caps", () => {
    expect(FILE_UPLOAD_MCP_TOOLS).toHaveLength(1);
    expect(FILE_UPLOAD_MCP_TOOLS[0]).toMatchObject({
      name: "purr_upload_file",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      _meta: { "openai/fileParams": ["file"] },
    });
    const schema = JSON.stringify(FILE_UPLOAD_MCP_TOOLS[0].inputSchema);
    expect(schema).toContain('"required":["file","destination","sha256"]');
    expect(schema).toContain('"enum":["auto","sync","async"]');
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

  test("deduplicates concurrent identical retries into one connector download", async () => {
    const root = await tempRoot();
    const destination = join(root, "deduplicated.bin");
    const bytes = randomBytes(256 * 1024 + 17);
    let fetchCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await gate;
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const input = {
      file: {
        download_url: "https://files.example.test/retry-token",
        name: "retry.bin",
      },
      destination,
      sha256: sha256(bytes),
    };

    const first = uploadFile(input, { fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = uploadFile(input, { fetchImpl });
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchCalls).toBe(1);
    expect(firstResult.sha256).toBe(sha256(bytes));
    expect(secondResult).toMatchObject({
      sha256: sha256(bytes),
      deduplicated: true,
    });
    expect(await readFile(destination)).toEqual(bytes);
  });

  test("returns an already verified destination without downloading again", async () => {
    const root = await tempRoot();
    const destination = join(root, "already-there.bin");
    const bytes = randomBytes(32_769);
    await writeFile(destination, bytes);

    const result = await uploadFile(
      {
        file: {
          download_url: "https://files.example.test/unused-token",
          name: "existing.bin",
        },
        destination,
        sha256: sha256(bytes),
      },
      {
        fetchImpl: (async () => {
          throw new Error("fetch must not run for a verified destination");
        }) as unknown as typeof fetch,
      },
    );

    expect(result).toMatchObject({
      destination,
      sha256: sha256(bytes),
      reusedExisting: true,
      replaced: true,
    });
  });

  test("auto-routes connector uploads to one durable job and deduplicates tool retries", async () => {
    const root = await tempRoot();
    const destination = join(root, "async.bin");
    const bytes = randomBytes(192 * 1024 + 31);
    const signedUrl = "https://files.example.test/async-private-token";
    let fetchCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await gate;
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const args = {
      file: {
        file_id: "file-async",
        download_url: signedUrl,
        name: "async.bin",
        size: bytes.byteLength,
      },
      destination,
      sha256: sha256(bytes),
    };

    const first = await handleFileUploadMcpTool("purr_upload_file", args, { fetchImpl });
    const second = await handleFileUploadMcpTool("purr_upload_file", args, { fetchImpl });
    const firstPayload = first.payload as { jobId: string; status: string; deduplicated: boolean };
    const secondPayload = second.payload as { jobId: string; status: string; deduplicated: boolean };

    expect(firstPayload).toMatchObject({ status: "running", deduplicated: false });
    expect(secondPayload).toMatchObject({
      jobId: firstPayload.jobId,
      status: "running",
      deduplicated: true,
    });
    expect(fetchCalls).toBeLessThanOrEqual(1);

    release();
    const job = await waitForTerminalJob(firstPayload.jobId);
    expect(fetchCalls).toBe(1);
    expect(job.status).toBe("success");
    expect(job.summary.passed).toBe(true);
    expect(JSON.stringify(job)).not.toContain("async-private-token");
    expect(await readFile(destination)).toEqual(bytes);
  });

  test("rejects a conflicting hash while another upload owns the destination", async () => {
    const root = await tempRoot();
    const destination = join(root, "conflict.bin");
    const oldBytes = Buffer.from("old-content");
    const replacement = randomBytes(96 * 1024 + 11);
    await writeFile(destination, oldBytes);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await gate;
            controller.enqueue(replacement);
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const first = await handleFileUploadMcpTool(
      "purr_upload_file",
      {
        file: {
          download_url: "https://files.example.test/replacement",
          name: "replacement.bin",
        },
        destination,
        sha256: sha256(replacement),
      },
      { fetchImpl },
    );
    const firstPayload = first.payload as { jobId: string };

    const conflicting = await handleFileUploadMcpTool(
      "purr_upload_file",
      {
        file: {
          download_url: "https://files.example.test/old-content",
          name: "old.bin",
        },
        destination,
        sha256: sha256(oldBytes),
      },
      { fetchImpl },
    );
    expect(conflicting).toMatchObject({
      handled: true,
      isError: true,
      payload: { error: "upload_in_progress" },
    });

    release();
    const job = await waitForTerminalJob(firstPayload.jobId);
    expect(job.status).toBe("success");
    expect(await readFile(destination)).toEqual(replacement);
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
