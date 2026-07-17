import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildDeploymentPlanFromInspections,
  discoverProjects,
  inspectEnvironment,
  inspectProject,
  parseDotEnv,
} from "./operator-inspection";
import type { EnvironmentInspection, RuntimeInspection } from "./operator-types";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; project: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "purr-operator-"));
  const project = path.join(root, "app");
  roots.push(root);
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "operator-fixture",
        version: "1.2.3",
        packageManager: "bun@1.3.14",
        engines: { node: ">=24" },
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "bun test",
          build: "next build",
          start: "bun server.ts",
        },
        workspaces: ["packages/*"],
        dependencies: { next: "16.1.3" },
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(path.join(project, "bun.lock"), "fixture", "utf8");
  await fs.writeFile(path.join(project, ".env"), "DATABASE_URL=value-one\nRPC_URL=value-two\n", "utf8");
  await fs.writeFile(
    path.join(project, ".env.example"),
    "DATABASE_URL=\nRPC_URL=\nOPTIONAL_KEY=\n",
    "utf8"
  );
  return { root, project };
}

afterEach(async () => {
  while (roots.length > 0) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("private developer project inspection", () => {
  test("parses dotenv assignments without expanding values", () => {
    expect(
      parseDotEnv(`
# comment
export ALPHA="one two"
BETA='three'
GAMMA=four # trailing comment
INVALID LINE
`)
    ).toEqual({ ALPHA: "one two", BETA: "three", GAMMA: "four" });
  });

  test("discovers project markers without descending into detected roots", async () => {
    const { root, project } = await fixture();
    await fs.mkdir(path.join(project, "packages", "child"), { recursive: true });
    await fs.writeFile(path.join(project, "packages", "child", "package.json"), "{}", "utf8");

    const result = await discoverProjects({ roots: [root], maxDepth: 5, maxProjects: 20 });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.canonicalPath).toBe(await fs.realpath(project));
    expect(result.projects[0]?.packageManager).toBe("bun");
    expect(result.projects[0]?.projectType).toContain("nextjs");
  });

  test("inspects package manager, monorepo, scripts, and required env keys", async () => {
    const { project } = await fixture();
    const result = await inspectProject(project);

    expect(result.packageManager).toBe("bun");
    expect(result.packageManagerDeclaration).toBe("bun@1.3.14");
    expect(result.monorepo).toBe(true);
    expect(result.workspaces).toEqual(["packages/*"]);
    expect(result.requiredEnvironmentKeys).toEqual([
      "DATABASE_URL",
      "OPTIONAL_KEY",
      "RPC_URL",
    ]);
    expect(result.suggestedCommands.install).toEqual(["bun install --frozen-lockfile"]);
    expect(result.suggestedCommands.build).toEqual(["bun run build"]);
    expect(result.suggestedCommands.verify).toEqual([
      "bun run typecheck",
      "bun run lint",
      "bun run test",
    ]);
  });

  test("redacts environment values by default and reveals only explicit keys", async () => {
    const { project } = await fixture();
    const redacted = await inspectEnvironment(project, {
      sources: ["dotenv"],
      keys: ["DATABASE_URL", "RPC_URL"],
    });
    expect(redacted.entries).toHaveLength(2);
    expect(redacted.entries[0]?.observations[0]?.redacted).toBe(true);
    expect(redacted.entries[0]?.observations[0]?.value).toBeUndefined();
    expect(redacted.sensitiveOutput).toBe(false);

    const revealed = await inspectEnvironment(project, {
      sources: ["dotenv"],
      keys: ["RPC_URL"],
      revealValues: true,
    });
    expect(revealed.entries).toHaveLength(1);
    expect(revealed.entries[0]?.key).toBe("RPC_URL");
    expect(revealed.entries[0]?.observations[0]?.value).toBe("value-two");
    expect(revealed.revealedKeys).toEqual(["RPC_URL"]);
    expect(revealed.valuesPersisted).toBe(false);
  });

  test("requires explicit keys before revealing environment values", async () => {
    const { project } = await fixture();
    await expect(
      inspectEnvironment(project, { sources: ["dotenv"], revealValues: true })
    ).rejects.toThrow("requires one or more explicit keys");
  });

  test("builds an additive deployment plan with lock, snapshot, and rollback", async () => {
    const { project } = await fixture();
    const inspected = await inspectProject(project);
    inspected.git = {
      present: true,
      root: inspected.canonicalPath,
      branch: "main",
      head: "abc1234",
      origin: "https://github.com/example/project.git",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicted: 0,
      dirty: false,
    };
    const runtime: RuntimeInspection = {
      cwd: inspected.canonicalPath,
      tools: {
        pm2: { available: true, path: "/usr/bin/pm2", version: "6.0.0", error: null },
      },
      pm2: [
        {
          manager: "pm2",
          name: "operator-fixture",
          id: 1,
          pid: 123,
          status: "online",
          cwd: inspected.canonicalPath,
          script: "server.js",
          namespace: "default",
          interpreter: "node",
          restarts: 0,
        },
      ],
      systemd: [],
      dockerCompose: [],
      processes: [],
      detectedManagers: ["pm2"],
      notes: [],
    };
    const environment: EnvironmentInspection = {
      cwd: inspected.canonicalPath,
      sourcesRequested: ["dotenv"],
      entries: ["DATABASE_URL", "RPC_URL", "OPTIONAL_KEY"].map((key) => ({
        key,
        present: true,
        observations: [
          {
            source: "dotenv",
            location: path.join(inspected.canonicalPath, ".env"),
            present: true,
            redacted: true,
          },
        ],
      })),
      requestedKeysMissing: [],
      revealedKeys: [],
      sensitiveOutput: false,
      valuesPersisted: false,
      notes: [],
    };

    const plan = buildDeploymentPlanFromInspections(inspected, runtime, environment, {
      cwd: inspected.canonicalPath,
      targetRef: "main",
      expectedHead: "def5678",
      healthChecks: [{ type: "http", url: "https://example.invalid/healthz" }],
    });

    expect(plan.strategy).toBe("pm2");
    expect(plan.service).toEqual({ manager: "pm2", name: "operator-fixture" });
    expect(plan.lock.behavior).toBe("queue_same_project");
    expect(plan.lock.key).toHaveLength(32);
    expect(plan.snapshot.required).toBe(true);
    expect(plan.rollback.supported).toBe(true);
    expect(plan.environment.valuesIncluded).toBe(false);
    expect(plan.ready).toBe(true);
  });
});
