import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolAvailability } from "./types";

const execFileAsync = promisify(execFile);

async function commandPath(command: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) return null;
  const probe = process.platform === "win32" ? "where" : "/bin/sh";
  const args = process.platform === "win32" ? [command] : ["-lc", `command -v ${command}`];
  try {
    const { stdout } = await execFileAsync(probe, args, { timeout: 5000 });
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export async function probeTool(
  command: string,
  versionArgs: string[] = ["--version"]
): Promise<ToolAvailability> {
  const resolvedPath = await commandPath(command);
  if (!resolvedPath) return { available: false, path: null, version: null, error: "not found in PATH" };
  try {
    const { stdout, stderr } = await execFileAsync(command, versionArgs, { timeout: 10_000 });
    const version = (stdout || stderr).trim().split(/\r?\n/)[0] || null;
    return { available: true, path: resolvedPath, version, error: null };
  } catch (error) {
    return {
      available: true,
      path: resolvedPath,
      version: null,
      error: (error as Error).message,
    };
  }
}

export async function runnerTools() {
  const [cargo, rustc, surfpool, python, python3, uv, poetry, pipenv, tox, nox] = await Promise.all([
    probeTool("cargo"),
    probeTool("rustc"),
    probeTool("surfpool"),
    probeTool("python"),
    probeTool("python3"),
    probeTool("uv"),
    probeTool("poetry"),
    probeTool("pipenv"),
    probeTool("tox", ["--version"]),
    probeTool("nox", ["--version"]),
  ]);

  return { cargo, rustc, surfpool, python, python3, uv, poetry, pipenv, tox, nox };
}
