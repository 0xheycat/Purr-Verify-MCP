export type RequestedExecutionMode = "sync" | "async" | "auto";
export type EffectiveExecutionMode = "sync" | "async";

export interface ExecutionRouting {
  requestedMode: RequestedExecutionMode;
  effectiveMode: EffectiveExecutionMode;
  routingReason:
    | "explicit_async"
    | "explicit_sync"
    | "auto_short_smoke"
    | "auto_non_smoke"
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
  /\bpytest\b/i,
  /\bunittest\b/i,
  /\btox\b/i,
  /\bnox\b/i,
  /\bruff\b/i,
  /\bmypy\b/i,
  /\bpyright\b/i,
  /\bcoverage\b/i,
  /\buv\s+(?:sync|lock|run|build|python|pip|tool|tree|export)\b/i,
  /\buvx\b/i,
  /\bpoetry\b/i,
  /\bpipenv\b/i,
  /\bcargo\b/i,
  /\brustup-init\b/i,
  /\bsleep\s+\d+\b/i,
  /\bsurfpool\s+start\b/i,
];

const SHORT_SMOKE_COMMAND_PATTERNS = [
  /^node\s+--version$/i,
  /^bun\s+--version$/i,
  /^python3?\s+(?:--version|--help)$/i,
  /^uv\s+--version$/i,
  /^poetry\s+--version$/i,
  /^pipenv\s+--version$/i,
  /^cat\s+reports\/[A-Za-z0-9_.\/-]+\.(?:json|txt)$/i,
];

export function isKnownShortSmokeCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim().replace(/\s+/g, " ");
  return SHORT_SMOKE_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

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
      : "auto";
  const longRunningCommand = findLongRunningCommand(commands);

  if (requestedMode === "async") {
    return {
      requestedMode,
      effectiveMode: "async",
      routingReason: "explicit_async",
      autoRouted: false,
    };
  }

  if (longRunningCommand) {
    return {
      requestedMode,
      effectiveMode: "async",
      routingReason: "long_running_commands",
      autoRouted: true,
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

  if (requestedMode === "auto" && !isKnownShortSmokeCommand(commands[0])) {
    return {
      requestedMode,
      effectiveMode: "async",
      routingReason: "auto_non_smoke",
      autoRouted: true,
    };
  }

  return {
    requestedMode,
    effectiveMode: "sync",
    routingReason: requestedMode === "auto" ? "auto_short_smoke" : "explicit_sync",
    autoRouted: requestedMode === "auto",
  };
}
