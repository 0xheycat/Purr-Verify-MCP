export type RequestedExecutionMode = "sync" | "async" | "auto";
export type EffectiveExecutionMode = "sync" | "async";

export interface ExecutionRouting {
  requestedMode: RequestedExecutionMode;
  effectiveMode: EffectiveExecutionMode;
  routingReason:
    | "default_async"
    | "explicit_async"
    | "explicit_sync"
    | "auto_short_smoke"
    | "auto_multi_command"
    | "long_running_commands";
  autoRouted: boolean;
  detectedLongRunningCommand?: string;
}

const LONG_RUNNING_COMMAND_PATTERNS = [
  /\binstall\b/i,
  /\bbuild\b/i,
  /\blint\b/i,
  /\btypecheck\b/i,
  /\btest\b/i,
  /\bci\b/i,
  /\bprisma\s+generate\b/i,
  /\bplaywright\b/i,
  /\bcypress\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bsurfpool\s+start\b/i,
];

export function findLongRunningCommand(commands: unknown): string | null {
  if (!Array.isArray(commands)) return null;
  for (const command of commands) {
    if (typeof command !== "string") continue;
    if (LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
      return command;
    }
  }
  return null;
}

export function resolveExecutionMode(
  requested: unknown,
  commands: string[]
): ExecutionRouting {
  const requestedMode: RequestedExecutionMode =
    requested === "sync" || requested === "auto" || requested === "async"
      ? requested
      : "async";
  const longRunningCommand = findLongRunningCommand(commands);

  if (requestedMode === "async") {
    return {
      requestedMode,
      effectiveMode: "async",
      routingReason: requested === undefined ? "default_async" : "explicit_async",
      autoRouted: false,
    };
  }

  if (longRunningCommand) {
    return {
      requestedMode,
      effectiveMode: "async",
      routingReason: "long_running_commands",
      autoRouted: requestedMode === "sync",
      detectedLongRunningCommand: longRunningCommand,
    };
  }

  if (requestedMode === "auto" && commands.length !== 1) {
    return {
      requestedMode,
      effectiveMode: "async",
      routingReason: "auto_multi_command",
      autoRouted: true,
    };
  }

  return {
    requestedMode,
    effectiveMode: "sync",
    routingReason: requestedMode === "auto" ? "auto_short_smoke" : "explicit_sync",
    autoRouted: false,
  };
}