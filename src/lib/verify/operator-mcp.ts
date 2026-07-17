import {
  discoverProjects,
  inspectEnvironment,
  inspectProject,
  inspectRuntime,
  planDeployment,
} from "./operator-inspection";
import { handleOperatorMutationMcpTool } from "./operator-mutation-mcp";
import { sanitizeGitRemote } from "./operator-sanitize";
import type {
  DeploymentPlanInput,
  DeploymentStrategy,
  EnvironmentSourceName,
} from "./operator-types";

export interface OperatorMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

export interface OperatorToolResult {
  handled: boolean;
  payload?: unknown;
  isError?: boolean;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

const DEPLOYMENT_STRATEGIES: DeploymentStrategy[] = [
  "auto",
  "in_place",
  "release_symlink",
  "pm2",
  "systemd",
  "docker_compose",
  "custom",
];

const CWD_PROPERTY = {
  type: "string",
  description:
    "Absolute project working directory. The server resolves symlinks and records both requested and canonical paths.",
};

export const OPERATOR_MCP_TOOLS: OperatorMcpToolDefinition[] = [
  {
    name: "purr_discover_projects",
    description:
      "Discover active developer projects under configured or explicit VPS roots. Detects Git, Node, Rust, Python, Go, Docker Compose, and PM2 markers without reading secret values.",
    inputSchema: {
      type: "object",
      properties: {
        roots: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional absolute roots. Defaults to PURR_OPERATOR_ROOTS or /opt,/srv,/var/www,/home,/root.",
        },
        maxDepth: { type: "number", default: 3, description: "Directory depth, 0-8." },
        maxProjects: { type: "number", default: 100, description: "Result cap, 1-500." },
        includeNested: {
          type: "boolean",
          default: false,
          description: "Continue scanning below an already detected project root.",
        },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_inspect_project",
    description:
      "Inspect one local project: canonical path, Git branch/SHA/dirty state, package manager, scripts, monorepo workspaces, deploy manifests, Compose/PM2 files, environment key requirements, and suggested commands.",
    inputSchema: {
      type: "object",
      properties: { cwd: CWD_PROPERTY },
      required: ["cwd"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_inspect_runtime",
    description:
      "Inspect runtime state associated with a local project. Detects installed developer tools plus matching PM2, systemd, Docker Compose, and /proc processes. Environment values are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD_PROPERTY,
        includeProcesses: {
          type: "boolean",
          default: true,
          description: "Inspect matching /proc process cwd and command lines.",
        },
      },
      required: ["cwd"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_inspect_environment",
    description:
      "Inspect environment keys from dotenv, PM2, systemd, Docker Compose, and matching processes. Values are redacted by default. revealValues=true requires explicit keys and returns one-shot sensitive output that is not persisted.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD_PROPERTY,
        sources: {
          type: "array",
          items: {
            type: "string",
            enum: ["dotenv", "pm2", "systemd", "docker_compose", "process"],
          },
          description: "Optional source subset. Defaults to all supported sources.",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional key filter. Required when revealValues=true; maximum 20 unique valid keys.",
        },
        revealValues: {
          type: "boolean",
          default: false,
          description:
            "Explicitly reveal only requested keys. Revealed values are not written to history, snapshots, or logs.",
        },
      },
      required: ["cwd"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_plan_deployment",
    description:
      "Build a read-only deployment plan from the current local project and runtime. Detects strategy, exact Git state, commands, service manager, environment gaps, project lock, snapshot requirements, health checks, rollback, and risks. It does not deploy or restart anything.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD_PROPERTY,
        targetRef: { type: "string", description: "Target branch, tag, or revision label." },
        expectedHead: { type: "string", description: "Exact target Git SHA when known." },
        strategy: {
          type: "string",
          enum: [
            "auto",
            "in_place",
            "release_symlink",
            "pm2",
            "systemd",
            "docker_compose",
            "custom",
          ],
          default: "auto",
        },
        verifyCommands: { type: "array", items: { type: "string" } },
        buildCommands: { type: "array", items: { type: "string" } },
        serviceName: { type: "string" },
        healthChecks: {
          type: "array",
          items: { type: "object" },
          description: "Planned HTTP, TCP, process, manager, RPC, log, or custom checks.",
        },
        allowDirty: {
          type: "boolean",
          default: false,
          description:
            "Plan around a dirty worktree. No files are changed by this read-only tool.",
        },
      },
      required: ["cwd"],
    },
    annotations: READ_ONLY,
  },
];

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function errorPayload(error: unknown): OperatorToolResult {
  return {
    handled: true,
    isError: true,
    payload: {
      error: "operator_inspection_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export async function handleOperatorMcpTool(
  name: string | undefined,
  args: Record<string, unknown>
): Promise<OperatorToolResult> {
  try {
    if (name === "purr_discover_projects") {
      return {
        handled: true,
        payload: await discoverProjects({
          roots: stringArray(args.roots),
          maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : undefined,
          maxProjects: typeof args.maxProjects === "number" ? args.maxProjects : undefined,
          includeNested: args.includeNested === true,
        }),
      };
    }

    const cwd = stringValue(args.cwd);
    if (
      name === "purr_inspect_project" ||
      name === "purr_inspect_runtime" ||
      name === "purr_inspect_environment" ||
      name === "purr_plan_deployment"
    ) {
      if (!cwd) {
        return {
          handled: true,
          isError: true,
          payload: { error: "validation_failed", message: "cwd is required" },
        };
      }
    }

    if (name === "purr_inspect_project") {
      return { handled: true, payload: await inspectProject(cwd!) };
    }

    if (name === "purr_inspect_runtime") {
      return {
        handled: true,
        payload: await inspectRuntime(cwd!, { includeProcesses: args.includeProcesses !== false }),
      };
    }

    if (name === "purr_inspect_environment") {
      return {
        handled: true,
        payload: await inspectEnvironment(cwd!, {
          sources: stringArray(args.sources) as EnvironmentSourceName[] | undefined,
          keys: stringArray(args.keys),
          revealValues: args.revealValues === true,
        }),
      };
    }

    if (name === "purr_plan_deployment") {
      const healthChecks = Array.isArray(args.healthChecks)
        ? args.healthChecks.filter(
            (item): item is Record<string, unknown> =>
              !!item && typeof item === "object" && !Array.isArray(item)
          )
        : undefined;
      const strategyValue = stringValue(args.strategy);
      if (
        strategyValue &&
        !DEPLOYMENT_STRATEGIES.includes(strategyValue as DeploymentStrategy)
      ) {
        return {
          handled: true,
          isError: true,
          payload: { error: "validation_failed", message: `invalid strategy: ${strategyValue}` },
        };
      }
      const input: DeploymentPlanInput = {
        cwd: cwd!,
        targetRef: stringValue(args.targetRef),
        expectedHead: stringValue(args.expectedHead),
        strategy: strategyValue as DeploymentStrategy | undefined,
        verifyCommands: stringArray(args.verifyCommands),
        buildCommands: stringArray(args.buildCommands),
        serviceName: stringValue(args.serviceName),
        healthChecks,
        allowDirty: args.allowDirty === true,
      };
      return { handled: true, payload: await planDeployment(input) };
    }

    return handleOperatorMutationMcpTool(name, args);
  } catch (error) {
    return errorPayload(error);
  }
}
