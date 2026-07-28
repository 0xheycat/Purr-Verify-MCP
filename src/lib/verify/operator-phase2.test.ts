import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { relatedPath } from "./operator-inspection";
import type { RuntimeInspection } from "./operator-types";
import {
  OPERATOR_MUTATION_MCP_TOOLS,
  handleOperatorMutationMcpTool,
} from "./operator-mutation-mcp";
import {
  acquireProjectLock,
  classifyDestructiveCommand,
  processCgroupMatchesService,
  sanitizeGitRemote,
  selectRuntimeRestartTarget,
} from "./operator-runtime";

const roots: string[] = [];

async function tempDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "purr-phase2-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    await fs.rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("private developer operator phase two", () => {
  test("exposes ten additive tools with truthful annotations", () => {
    expect(OPERATOR_MUTATION_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "purr_run_command",
      "purr_verify_project",
      "purr_create_deploy_snapshot",
      "purr_deploy_project",
      "purr_restart_service",
      "purr_check_health",
      "purr_rollback_deployment",
      "purr_get_job_status",
      "purr_get_job_logs",
      "purr_cancel_job",
    ]);
    const readOnly = new Set(["purr_get_job_status", "purr_get_job_logs"]);
    for (const tool of OPERATOR_MUTATION_MCP_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(readOnly.has(tool.name));
      expect(tool.annotations.idempotentHint).toBe(readOnly.has(tool.name));
    }
  });

  test("matches only the project or descendants, never broad ancestors", () => {
    expect(relatedPath("/root/purr-verify", "/root/purr-verify")).toBe(true);
    expect(relatedPath("/root/purr-verify", "/root/purr-verify/packages/api")).toBe(true);
    expect(relatedPath("/root/purr-verify", "/root")).toBe(false);
    expect(relatedPath("/root/purr-verify", "/")).toBe(false);
    expect(relatedPath("/root/purr-verify", "/root/other-project")).toBe(false);
  });

  test("recognizes the current process inside a systemd service cgroup", () => {
    expect(
      processCgroupMatchesService(
        "/system.slice/purr-verify.service",
        "0::/system.slice/purr-verify.service",
      ),
    ).toBe(true);
    expect(
      processCgroupMatchesService(
        "/system.slice/purr-verify.service",
        "0::/system.slice/another.service",
      ),
    ).toBe(false);
  });

  test("selects the active systemd service bound to the exact project cwd", () => {
    const runtime: RuntimeInspection = {
      cwd: "/root/purr-verify",
      tools: {},
      pm2: [],
      systemd: [
        {
          manager: "systemd",
          name: "unrelated.service",
          activeState: "active",
          subState: "running",
          mainPid: 11,
          workingDirectory: "/root",
          fragmentPath: null,
          execStart: null,
        },
        {
          manager: "systemd",
          name: "purr-verify.service",
          activeState: "active",
          subState: "running",
          mainPid: 22,
          workingDirectory: "/root/purr-verify",
          fragmentPath: null,
          execStart: null,
        },
      ],
      dockerCompose: [],
      processes: [],
      detectedManagers: ["systemd"],
      notes: [],
    };

    expect(selectRuntimeRestartTarget(runtime)).toEqual({
      manager: "systemd",
      serviceName: "purr-verify.service",
    });
    expect(selectRuntimeRestartTarget(runtime, "unrelated.service")).toEqual({
      manager: "systemd",
      serviceName: "unrelated.service",
    });
    expect(selectRuntimeRestartTarget(runtime, "missing.service")).toBeNull();
  });

  test("reclaims a project lock as soon as its owning job is terminal", async () => {
    const cwd = await tempDirectory();
    const releaseFinished = await acquireProjectLock(
      cwd,
      "finished-job",
      2_000,
      () => false,
      () => true,
    );
    const releaseNext = await acquireProjectLock(
      cwd,
      "next-job",
      2_000,
      () => false,
      (ownerJobId) => ownerJobId === "next-job",
    );

    await releaseFinished();
    await releaseNext();
  });

  test("sanitizes credentials from HTTP Git remotes", () => {
    const sanitized = sanitizeGitRemote(
      "https://developer:github_pat_example@github.com/owner/repo.git"
    );
    expect(sanitized).not.toContain("developer");
    expect(sanitized).not.toContain("github_pat_example");
    expect(sanitized).toContain("github.com/owner/repo.git");
  });

  test("classifies destructive escape-hatch commands without blocking normal commands", () => {
    expect(classifyDestructiveCommand("bun run build")).toBeNull();
    expect(classifyDestructiveCommand("git status --short")).toBeNull();
    expect(classifyDestructiveCommand("git reset --hard HEAD~1")).toBe(
      "destructive_git_reset"
    );
    expect(classifyDestructiveCommand("rm -rf dist")).toBe("recursive_force_delete");
  });

  test("requires one explicit confirmation for a classified destructive command", async () => {
    const cwd = await tempDirectory();
    const result = await handleOperatorMutationMcpTool("purr_run_command", {
      cwd,
      argv: ["git", "reset", "--hard", "HEAD~1"],
    });
    expect(result.handled).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.payload).toMatchObject({
      error: "validation_failed",
      classification: "destructive_git_reset",
    });
  });

  test("rejects raw invalid service manager and restart action", async () => {
    const cwd = await tempDirectory();
    const manager = await handleOperatorMutationMcpTool("purr_restart_service", {
      cwd,
      manager: "everything",
    });
    expect(manager.isError).toBe(true);
    expect(manager.payload).toMatchObject({ error: "validation_failed" });

    const action = await handleOperatorMutationMcpTool("purr_restart_service", {
      cwd,
      manager: "custom",
      action: "erase",
      customArgv: ["true"],
    });
    expect(action.isError).toBe(true);
    expect(action.payload).toMatchObject({ error: "validation_failed" });
  });

  test("deployment and rollback require one lifecycle approval", async () => {
    const cwd = await tempDirectory();
    const deploy = await handleOperatorMutationMcpTool("purr_deploy_project", { cwd });
    expect(deploy.isError).toBe(true);
    expect(deploy.payload).toMatchObject({ message: "deployment requires approved=true" });

    const rollback = await handleOperatorMutationMcpTool("purr_rollback_deployment", {
      cwd,
      snapshotId: "snapshot-123456",
    });
    expect(rollback.isError).toBe(true);
    expect(rollback.payload).toMatchObject({ message: "rollback requires approved=true" });
  });
});
