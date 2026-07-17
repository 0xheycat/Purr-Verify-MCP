import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createDeploymentSnapshot,
  readDeploymentSnapshot,
  rollbackDeploymentSnapshot,
} from "./operator-runtime";

const exec = promisify(execFile);
const roots: string[] = [];
const originalDataDir = process.env.VERIFY_DATA_DIR;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd });
}

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.VERIFY_DATA_DIR;
  else process.env.VERIFY_DATA_DIR = originalDataDir;
  while (roots.length > 0) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("persistent deployment snapshots", () => {
  test("restores Git HEAD, dirty patch, and untracked files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "purr-snapshot-"));
    roots.push(root);
    const project = path.join(root, "project");
    const data = path.join(root, "data");
    process.env.VERIFY_DATA_DIR = data;
    await fs.mkdir(project, { recursive: true });
    await git(project, "init");
    await git(project, "config", "user.name", "Purr Test");
    await git(project, "config", "user.email", "purr@example.invalid");
    await fs.writeFile(path.join(project, "version.txt"), "one\n", "utf8");
    await git(project, "add", "version.txt");
    await git(project, "commit", "-m", "initial");

    await fs.writeFile(path.join(project, "version.txt"), "two\n", "utf8");
    await fs.writeFile(path.join(project, "local.txt"), "local evidence\n", "utf8");

    const snapshot = await createDeploymentSnapshot(project, { reason: "test deploy" });
    expect(snapshot.completeRollback).toBe(true);
    expect(snapshot.git.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.environmentKeys).toEqual([]);
    expect(snapshot.files.some((file) => file.relativePath === "local.txt")).toBe(true);

    const durable = await readDeploymentSnapshot(snapshot.snapshotId);
    expect(durable.snapshotId).toBe(snapshot.snapshotId);
    expect(durable.cwd).toBe(await fs.realpath(project));

    await fs.writeFile(path.join(project, "version.txt"), "three\n", "utf8");
    await fs.rm(path.join(project, "local.txt"));

    const result = await rollbackDeploymentSnapshot(snapshot.snapshotId, project);
    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(project, "version.txt"), "utf8")).toBe("two\n");
    expect(await fs.readFile(path.join(project, "local.txt"), "utf8")).toBe(
      "local evidence\n"
    );
  }, 60_000);
});
