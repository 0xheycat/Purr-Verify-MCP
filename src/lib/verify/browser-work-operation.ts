import { randomUUID } from "node:crypto";

export type BrowserWorkOperationKind = "act" | "screenshot";
export type BrowserWorkOperationStatus = "queued" | "running" | "recovering" | "success" | "failed" | "canceled";

export interface BrowserWorkOperationOutput {
  payload: unknown;
  content?: Array<Record<string, unknown>>;
}

export interface BrowserWorkOperationSummary {
  operationId: string;
  sessionId: string;
  kind: BrowserWorkOperationKind;
  status: BrowserWorkOperationStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutMs: number | null;
  cancelRequested: boolean;
  error: string | null;
  result?: BrowserWorkOperationOutput;
}

interface BrowserWorkOperationRecord extends BrowserWorkOperationSummary {
  controller: AbortController;
  onCancel?: () => Promise<void> | void;
}

interface BrowserWorkOperationStartInput {
  sessionId: string;
  kind: BrowserWorkOperationKind;
  timeoutMs?: number;
  run: (signal: AbortSignal) => Promise<BrowserWorkOperationOutput>;
  onCancel?: () => Promise<void> | void;
}

const TERMINAL = new Set<BrowserWorkOperationStatus>(["success", "failed", "canceled"]);

function safeTimeout(value: unknown): number | undefined {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.round(timeout);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canceled(record: BrowserWorkOperationRecord): boolean {
  return record.status === "canceled";
}

function canceling(record: BrowserWorkOperationRecord): boolean {
  return record.cancelRequested;
}

export class BrowserWorkOperationRegistry {
  private readonly records = new Map<string, BrowserWorkOperationRecord>();
  private readonly now: () => Date;
  private readonly maxRecords: number;

  constructor(options: { now?: () => Date; maxRecords?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxRecords = Math.max(20, options.maxRecords ?? 250);
  }

  start(input: BrowserWorkOperationStartInput): BrowserWorkOperationSummary {
    const operationId = `browser-${input.kind}-${randomUUID()}`;
    const createdAt = this.now().toISOString();
    const timeoutMs = safeTimeout(input.timeoutMs);
    const record: BrowserWorkOperationRecord = {
      operationId,
      sessionId: input.sessionId,
      kind: input.kind,
      status: "queued",
      createdAt,
      startedAt: null,
      finishedAt: null,
      timeoutMs: timeoutMs ?? null,
      cancelRequested: false,
      error: null,
      controller: new AbortController(),
      onCancel: input.onCancel,
    };
    this.records.set(operationId, record);
    this.prune();

    queueMicrotask(() => {
      void this.execute(record, input.run, timeoutMs);
    });
    return this.publicRecord(record, false);
  }

  status(operationId: string, includeResult = true): BrowserWorkOperationSummary {
    const record = this.records.get(operationId);
    if (!record) throw new Error(`unknown browser operation: ${operationId}`);
    return this.publicRecord(record, includeResult);
  }

  list(sessionId?: string): BrowserWorkOperationSummary[] {
    return [...this.records.values()]
      .filter((record) => !sessionId || record.sessionId === sessionId)
      .map((record) => this.publicRecord(record, false));
  }

  cancel(operationId: string): BrowserWorkOperationSummary {
    const record = this.records.get(operationId);
    if (!record) throw new Error(`unknown browser operation: ${operationId}`);
    if (TERMINAL.has(record.status)) return this.publicRecord(record, true);
    if (record.cancelRequested) return this.publicRecord(record, true);
    record.cancelRequested = true;
    record.status = "recovering";
    record.controller.abort();
    void this.finishCancellation(record);
    return this.publicRecord(record, true);
  }

  private async execute(
    record: BrowserWorkOperationRecord,
    run: (signal: AbortSignal) => Promise<BrowserWorkOperationOutput>,
    timeoutMs?: number,
  ): Promise<void> {
    if (canceled(record)) return;
    record.status = "running";
    record.startedAt = this.now().toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run(record.controller.signal),
        ...(timeoutMs
          ? [new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const error = new Error(`browser ${record.kind} operation timed out after ${timeoutMs}ms`);
                error.name = "BrowserWorkOperationTimeoutError";
                reject(error);
              }, timeoutMs);
              timer.unref?.();
            })]
          : []),
      ]);
      if (canceling(record)) return;
      record.status = "success";
      record.result = result;
    } catch (error) {
      if (canceling(record)) return;
      record.error = errorMessage(error);
      if (/timed out|timeout/i.test(record.error)) {
        record.status = "recovering";
        record.controller.abort();
        try {
          await record.onCancel?.();
        } catch (recoveryError) {
          record.error = `${record.error}; recovery failed: ${errorMessage(recoveryError)}`;
        }
      }
      if (!canceled(record)) record.status = "failed";
    } finally {
      if (timer) clearTimeout(timer);
      if (!canceling(record) && !canceled(record)) record.finishedAt = this.now().toISOString();
    }
  }

  private async finishCancellation(record: BrowserWorkOperationRecord): Promise<void> {
    try {
      await record.onCancel?.();
    } catch (error) {
      record.error = `cancellation recovery failed: ${errorMessage(error)}`;
    } finally {
      record.status = "canceled";
      record.finishedAt = this.now().toISOString();
    }
  }

  private publicRecord(record: BrowserWorkOperationRecord, includeResult: boolean): BrowserWorkOperationSummary {
    return {
      operationId: record.operationId,
      sessionId: record.sessionId,
      kind: record.kind,
      status: record.status,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      timeoutMs: record.timeoutMs,
      cancelRequested: record.cancelRequested,
      error: record.error,
      ...(includeResult && record.result ? { result: record.result } : {}),
    };
  }

  private prune(): void {
    if (this.records.size <= this.maxRecords) return;
    for (const [operationId, record] of this.records) {
      if (!TERMINAL.has(record.status)) continue;
      this.records.delete(operationId);
      if (this.records.size <= this.maxRecords) return;
    }
  }
}
