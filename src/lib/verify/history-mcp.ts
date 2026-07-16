import {
  getJobDurable,
  getLatestHistoryJob,
  listHistoryJobs,
  listHistorySummaries,
} from "./store";
import type { Job, JobStatus } from "./types";

export interface HistoryMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

export interface HistoryToolResult {
  handled: boolean;
  payload?: unknown;
  isError?: boolean;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const STATUS_ENUM: JobStatus[] = [
  "queued",
  "running",
  "success",
  "failed",
  "canceled",
  "timeout",
];

const HISTORY_FILTER_PROPERTIES = {
  repo: { type: "string", description: "Exact owner/repo filter." },
  ref: { type: "string", description: "Exact branch, tag, or ref filter." },
  status: { type: "string", enum: STATUS_ENUM },
  command: { type: "string", description: "Case-insensitive command substring." },
  tag: { type: "string", description: "Case-insensitive tag substring." },
  query: {
    type: "string",
    description: "Case-insensitive search across repo, ref, commands, metadata, and stored result evidence.",
  },
  from: { type: "string", description: "Inclusive ISO-8601 queuedAt lower bound." },
  to: { type: "string", description: "Inclusive ISO-8601 queuedAt upper bound." },
  limit: { type: "number", default: 50, description: "Page size, 1-200." },
  cursor: { type: "string", description: "Opaque cursor returned by the previous page." },
};

export const HISTORY_MCP_TOOLS: HistoryMcpToolDefinition[] = [
  {
    name: "search_verification_history",
    description:
      "Search durable verification history without loading full logs into agent context. Returns deterministic cursor-paginated summaries. Running and queued jobs are never removed by history retention.",
    inputSchema: {
      type: "object",
      properties: HISTORY_FILTER_PROPERTIES,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_latest_verification",
    description:
      "Get the latest durable verification matching optional repo, ref, status, command, tag, text, and time filters. Returns a summary by default or the full job when view='full'.",
    inputSchema: {
      type: "object",
      properties: {
        ...HISTORY_FILTER_PROPERTIES,
        view: { type: "string", enum: ["summary", "full"], default: "summary" },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_verification_summary",
    description:
      "Get a compact durable summary for one verification job without returning command stdout/stderr.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "compare_verification_jobs",
    description:
      "Compare two durable verification jobs and report status changes, new/resolved failed commands, duration delta, commit heads, and cleanup state. Full logs are not returned.",
    inputSchema: {
      type: "object",
      properties: {
        baseJobId: { type: "string" },
        headJobId: { type: "string" },
      },
      required: ["baseJobId", "headJobId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_job_log_chunk",
    description:
      "Read a bounded chunk of one command's stdout, stderr, or combined log. Repeat with nextOffset to access the complete stored log without context overflow.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        commandIndex: { type: "number", default: 0, description: "Zero-based command index." },
        stream: { type: "string", enum: ["stdout", "stderr", "combined"], default: "combined" },
        offset: { type: "number", default: 0, description: "Character offset." },
        limit: { type: "number", default: 12000, description: "Chunk size, 1-50000 characters." },
      },
      required: ["jobId"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "search_job_logs",
    description:
      "Search stored command logs across durable verification history. Returns bounded matching snippets and job/command identifiers, not entire logs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Required case-insensitive log search text." },
        repo: { type: "string" },
        ref: { type: "string" },
        status: { type: "string", enum: STATUS_ENUM },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "number", default: 20, description: "Maximum matching snippets, 1-100." },
        jobsScanned: { type: "number", default: 100, description: "Maximum recent jobs to scan, 1-200." },
      },
      required: ["query"],
    },
    annotations: READ_ONLY,
  },
];

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function stringArg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function statusArg(value: unknown): JobStatus | undefined {
  return typeof value === "string" && STATUS_ENUM.includes(value as JobStatus)
    ? (value as JobStatus)
    : undefined;
}

function historyQuery(args: Record<string, unknown>) {
  return {
    repo: stringArg(args.repo),
    ref: stringArg(args.ref),
    status: statusArg(args.status),
    command: stringArg(args.command),
    tag: stringArg(args.tag),
    query: stringArg(args.query),
    from: stringArg(args.from),
    to: stringArg(args.to),
    limit: numberArg(args.limit, 50, 1, 200),
    cursor: stringArg(args.cursor),
  };
}

function jobSummary(job: Job) {
  return {
    jobId: job.jobId,
    repo: job.repo,
    ref: job.ref,
    expected_head: job.expected_head,
    actual_head: job.actual_head,
    status: job.status,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    failedCommand: job.summary?.failedCommand ?? null,
    commandCount: job.commands.length,
    commands: job.commands.map((command, commandIndex) => ({
      commandIndex,
      command: command.command,
      effectiveCommand: command.effectiveCommand,
      status: command.status,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      truncated: command.truncated,
    })),
    cleanupStatus: job.cleanupStatus ?? null,
    cleanup: job.cleanup ?? null,
    execution: job.execution ?? null,
    timeoutPolicy: job.timeoutPolicy ?? null,
    tags: job.tags ?? [],
    error: job.error ?? null,
    runnerRecommendations: job.runnerRecommendations ?? [],
  };
}

function failedCommands(job: Job): Set<string> {
  return new Set(
    job.commands
      .filter((command) => command.status === "failed" || command.status === "timeout")
      .map((command) => command.command)
  );
}

function result(payload: unknown, isError = false): HistoryToolResult {
  return { handled: true, payload, isError };
}

function validationError(message: string): HistoryToolResult {
  return result({ error: "validation_failed", message }, true);
}

function notFound(jobId: string): HistoryToolResult {
  return result({ error: "not_found", message: `Job not found: ${jobId}` }, true);
}

function combinedLog(job: Job, commandIndex: number, stream: string): string | null {
  const command = job.commands[commandIndex];
  if (!command) return null;
  if (stream === "stdout") return command.stdout ?? "";
  if (stream === "stderr") return command.stderr ?? "";
  return [
    command.stdout ? `[stdout]\n${command.stdout}` : "",
    command.stderr ? `[stderr]\n${command.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function matchingSnippet(text: string, query: string, radius = 350): { offset: number; snippet: string } | null {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return null;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return {
    offset: start,
    snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
  };
}

export async function handleHistoryMcpTool(
  name: string | undefined,
  args: Record<string, unknown>
): Promise<HistoryToolResult> {
  if (name === "list_verification_jobs" || name === "search_verification_history") {
    const view = args.view === "full" ? "full" : "summary";
    const query = historyQuery(args);
    if (view === "full") {
      const page = await listHistoryJobs(query);
      return result({ ...page, view });
    }
    const page = await listHistorySummaries(query);
    return result({ ...page, view });
  }

  if (name === "get_verification_job") {
    const jobId = stringArg(args.jobId);
    if (!jobId) return validationError("jobId is required");
    const job = await getJobDurable(jobId);
    return job ? result(job) : notFound(jobId);
  }

  if (name === "get_verification_summary") {
    const jobId = stringArg(args.jobId);
    if (!jobId) return validationError("jobId is required");
    const job = await getJobDurable(jobId);
    return job ? result(jobSummary(job)) : notFound(jobId);
  }

  if (name === "get_latest_verification") {
    const query = historyQuery(args);
    const job = await getLatestHistoryJob(query);
    if (!job) return result({ job: null, matched: false });
    return result({
      matched: true,
      view: args.view === "full" ? "full" : "summary",
      job: args.view === "full" ? job : jobSummary(job),
    });
  }

  if (name === "compare_verification_jobs") {
    const baseJobId = stringArg(args.baseJobId);
    const headJobId = stringArg(args.headJobId);
    if (!baseJobId || !headJobId) {
      return validationError("baseJobId and headJobId are required");
    }
    const [base, head] = await Promise.all([
      getJobDurable(baseJobId),
      getJobDurable(headJobId),
    ]);
    if (!base) return notFound(baseJobId);
    if (!head) return notFound(headJobId);
    const baseFailed = failedCommands(base);
    const headFailed = failedCommands(head);
    const newFailures = Array.from(headFailed).filter((command) => !baseFailed.has(command));
    const resolvedFailures = Array.from(baseFailed).filter((command) => !headFailed.has(command));
    const durationDeltaMs =
      typeof base.durationMs === "number" && typeof head.durationMs === "number"
        ? head.durationMs - base.durationMs
        : null;
    return result({
      base: jobSummary(base),
      head: jobSummary(head),
      comparison: {
        statusChanged: base.status !== head.status,
        baseStatus: base.status,
        headStatus: head.status,
        regression:
          (base.status === "success" && head.status !== "success") || newFailures.length > 0,
        improvement:
          (base.status !== "success" && head.status === "success") || resolvedFailures.length > 0,
        newFailures,
        resolvedFailures,
        durationDeltaMs,
        actualHeadChanged: base.actual_head !== head.actual_head,
        cleanupChanged: base.cleanupStatus !== head.cleanupStatus,
      },
    });
  }

  if (name === "get_job_log_chunk") {
    const jobId = stringArg(args.jobId);
    if (!jobId) return validationError("jobId is required");
    const job = await getJobDurable(jobId);
    if (!job) return notFound(jobId);
    const commandIndex = numberArg(args.commandIndex, 0, 0, Math.max(0, job.commands.length - 1));
    const stream =
      args.stream === "stdout" || args.stream === "stderr" ? args.stream : "combined";
    const text = combinedLog(job, commandIndex, stream);
    if (text === null) return validationError(`commandIndex out of range: ${commandIndex}`);
    const offset = numberArg(args.offset, 0, 0, text.length);
    const limit = numberArg(args.limit, 12000, 1, 50000);
    const chunk = text.slice(offset, offset + limit);
    const nextOffset = offset + chunk.length < text.length ? offset + chunk.length : null;
    return result({
      jobId,
      commandIndex,
      command: job.commands[commandIndex]?.command,
      stream,
      offset,
      limit,
      totalCharacters: text.length,
      chunk,
      nextOffset,
      complete: nextOffset === null,
    });
  }

  if (name === "search_job_logs") {
    const queryText = stringArg(args.query);
    if (!queryText) return validationError("query is required");
    const matchLimit = numberArg(args.limit, 20, 1, 100);
    const jobsScanned = numberArg(args.jobsScanned, 100, 1, 200);
    const page = await listHistoryJobs({
      repo: stringArg(args.repo),
      ref: stringArg(args.ref),
      status: statusArg(args.status),
      from: stringArg(args.from),
      to: stringArg(args.to),
      limit: jobsScanned,
    });
    const matches: Array<Record<string, unknown>> = [];
    for (const job of page.jobs) {
      for (let commandIndex = 0; commandIndex < job.commands.length; commandIndex++) {
        const command = job.commands[commandIndex];
        for (const stream of ["stdout", "stderr"] as const) {
          const text = command[stream] ?? "";
          const match = matchingSnippet(text, queryText);
          if (!match) continue;
          matches.push({
            jobId: job.jobId,
            repo: job.repo,
            ref: job.ref,
            status: job.status,
            queuedAt: job.queuedAt,
            commandIndex,
            command: command.command,
            commandStatus: command.status,
            stream,
            offset: match.offset,
            snippet: match.snippet,
          });
          if (matches.length >= matchLimit) {
            return result({ query: queryText, matches, jobsScanned: page.jobs.length, truncated: true });
          }
        }
      }
    }
    return result({
      query: queryText,
      matches,
      jobsScanned: page.jobs.length,
      truncated: false,
    });
  }

  return { handled: false };
}
