import { describe, expect, test } from "bun:test";
import { BrowserWorkOperationRegistry } from "./browser-work-operation";

async function waitForTerminal(
  registry: BrowserWorkOperationRegistry,
  operationId: string,
): Promise<ReturnType<BrowserWorkOperationRegistry["status"]>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = registry.status(operationId);
    if (["success", "failed", "canceled"].includes(current.status)) return current;
    await Bun.sleep(5);
  }
  throw new Error("operation did not reach terminal state");
}

describe("browser work operation registry", () => {
  test("returns immediately and publishes the terminal result through status", async () => {
    let resolveRun: ((value: { payload: { ok: true } }) => void) | undefined;
    const registry = new BrowserWorkOperationRegistry();
    const started = registry.start({
      sessionId: "high-res",
      kind: "screenshot",
      timeoutMs: 5_000,
      run: async () => await new Promise((resolve) => {
        resolveRun = resolve;
      }),
    });

    expect(["queued", "running"]).toContain(started.status);
    expect(started.result).toBeUndefined();
    await Bun.sleep(0);
    expect(resolveRun).toBeFunction();
    resolveRun!({ payload: { ok: true } });

    const terminal = await waitForTerminal(registry, started.operationId);
    expect(terminal.status).toBe("success");
    expect(terminal.result?.payload).toEqual({ ok: true });
  });

  test("times out independently of the MCP transport and invokes recovery once", async () => {
    let recoveries = 0;
    const registry = new BrowserWorkOperationRegistry();
    const started = registry.start({
      sessionId: "stuck-renderer",
      kind: "act",
      timeoutMs: 30,
      run: async () => await new Promise(() => {}),
      onCancel: async () => {
        recoveries += 1;
      },
    });

    const terminal = await waitForTerminal(registry, started.operationId);
    expect(terminal.status).toBe("failed");
    expect(terminal.error).toContain("timed out after 30ms");
    expect(recoveries).toBe(1);
  });

  test("explicit cancellation is terminal and triggers out-of-band recovery", async () => {
    let recoveries = 0;
    const registry = new BrowserWorkOperationRegistry();
    const started = registry.start({
      sessionId: "cancel-me",
      kind: "screenshot",
      run: async () => await new Promise(() => {}),
      onCancel: () => {
        recoveries += 1;
      },
    });

    const canceling = registry.cancel(started.operationId);
    expect(canceling.status).toBe("recovering");
    expect(canceling.cancelRequested).toBe(true);
    const canceled = await waitForTerminal(registry, started.operationId);
    expect(canceled.status).toBe("canceled");
    expect(recoveries).toBe(1);
  });
});
