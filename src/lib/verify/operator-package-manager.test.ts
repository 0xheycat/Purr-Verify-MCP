import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectProject } from "./operator-inspection";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("operator package-manager discovery", () => {
  test("defaults a legacy package.json project without lock metadata to npm", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "purr-operator-npm-"));
    roots.push(root);
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "legacy-node-project", scripts: { build: "node build.js" } }),
      "utf8"
    );

    const project = await inspectProject(root);

    expect(project.packageManager).toBe("npm");
    expect(project.suggestedCommands.install).toEqual(["npm install"]);
    expect(project.suggestedCommands.build).toEqual(["npm run build"]);
  });
});
