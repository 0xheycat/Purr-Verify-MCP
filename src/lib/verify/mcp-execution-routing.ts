import { NextRequest } from "next/server";
import { effectiveDefaultTimeouts, getConfig } from "./config";
import { resolveExecutionMode, type ExecutionRouting } from "./execution-policy";

interface McpMessage {
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

export interface RoutedMcpBody {
  body: unknown;
  routings: Array<ExecutionRouting | null>;
  toolNames: Array<string | null>;
  changed: boolean;
}

function messages(body: unknown): McpMessage[] {
  return Array.isArray(body) ? (body as McpMessage[]) : [body as McpMessage];
}

export function routeMcpExecutionBody(body: unknown): RoutedMcpBody {
  const cloned = JSON.parse(JSON.stringify(body)) as unknown;
  const routedMessages = messages(cloned);
  const routings: Array<ExecutionRouting | null> = [];
  const toolNames: Array<string | null> = [];
  let changed = false;

  for (const message of routedMessages) {
    const toolName = message?.method === "tools/call" ? message.params?.name ?? null : null;
    toolNames.push(toolName);
    if (toolName !== "create_verification_job") {
      routings.push(null);
      continue;
    }

    const args = message.params?.arguments ?? {};
    const commands = Array.isArray(args.commands)
      ? args.commands.filter((command): command is string => typeof command === "string")
      : [];
    const routing = resolveExecutionMode(args.mode, commands);
    const metadata =
      args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : {};

    args.mode = routing.effectiveMode;
    args.metadata = { ...metadata, _purrExecution: routing };
    routings.push(routing);
    changed = true;
  }

  return { body: cloned, routings, toolNames, changed };
}

export function requestWithJsonBody(req: NextRequest, body: unknown): NextRequest {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return new NextRequest(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify(body),
  });
}

function decorateTextPayload(text: string, additions: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, ...additions }, null, 2);
  } catch {
    return text;
  }
}

export function decorateMcpResponse(
  json: unknown,
  routings: Array<ExecutionRouting | null>,
  toolNames: Array<string | null>
): unknown {
  const packets = Array.isArray(json) ? json : [json];
  const defaults = effectiveDefaultTimeouts(getConfig());

  packets.forEach((packet, index) => {
    if (!packet || typeof packet !== "object") return;
    const result = (packet as { result?: { content?: Array<{ type?: string; text?: string }> } }).result;
    const first = result?.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") return;

    const routing = routings[index];
    if (routing) {
      first.text = decorateTextPayload(first.text, {
        execution: routing,
        requestedMode: routing.requestedMode,
        effectiveMode: routing.effectiveMode,
        routingReason: routing.routingReason,
        autoRouted: routing.autoRouted,
      });
    }

    if (toolNames[index] === "health_check") {
      first.text = decorateTextPayload(first.text, {
        autoModeAvailable: true,
        commandTimeoutMs: defaults.commandTimeoutMs,
        configuredCommandTimeoutMs: defaults.configuredCommandTimeoutMs,
        jobTimeoutMs: defaults.jobTimeoutMs,
        timeoutWarnings: defaults.warnings,
      });
    }
  });

  return Array.isArray(json) ? packets : packets[0];
}
