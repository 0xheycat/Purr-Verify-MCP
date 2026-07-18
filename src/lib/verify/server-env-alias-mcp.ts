import {
  listServerEnvAliases,
  listServerEnvProfiles,
} from "./server-env-ref";

export interface ServerEnvAliasMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
}

export interface ServerEnvAliasToolResult {
  handled: boolean;
  payload?: unknown;
  isError?: boolean;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} as const;

export const SERVER_ENV_ALIAS_MCP_TOOLS: ServerEnvAliasMcpToolDefinition[] = [
  {
    name: "purr_list_server_env_aliases",
    description:
      "List configured public aliases accepted by @server:<alias>. Returns alias labels only; source environment keys and resolved values are never included.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "purr_list_server_env_profiles",
    description:
      "List reusable server-owned environment profile labels for clone verification and private operator jobs. Returns labels and safe configuration diagnostics only; environment keys and values are never included.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

export function handleServerEnvAliasMcpTool(
  name: string | undefined,
): ServerEnvAliasToolResult {
  if (name === "purr_list_server_env_aliases") {
    return { handled: true, payload: listServerEnvAliases() };
  }
  if (name === "purr_list_server_env_profiles") {
    return { handled: true, payload: listServerEnvProfiles() };
  }
  return { handled: false };
}
