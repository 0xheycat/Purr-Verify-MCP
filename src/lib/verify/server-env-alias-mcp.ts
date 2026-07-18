import { listServerEnvAliases } from "./server-env-ref";

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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];

export function handleServerEnvAliasMcpTool(
  name: string | undefined,
): ServerEnvAliasToolResult {
  if (name !== "purr_list_server_env_aliases") return { handled: false };
  return { handled: true, payload: listServerEnvAliases() };
}
