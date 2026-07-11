export const DEPLOYMENT_MODES = ["self_hosted", "hosted"] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export function parseDeploymentMode(raw = process.env.DEPLOYMENT_MODE): DeploymentMode {
  const normalized = raw?.trim().toLowerCase();

  if (!normalized || normalized === "self-hosted" || normalized === "self_hosted") {
    return "self_hosted";
  }

  if (normalized === "hosted") {
    return "hosted";
  }

  throw new Error(
    `Invalid DEPLOYMENT_MODE ${JSON.stringify(raw)}. Expected "self_hosted" or "hosted".`,
  );
}

export function isHostedMode(mode = parseDeploymentMode()): boolean {
  return mode === "hosted";
}

export function assertHostedConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (parseDeploymentMode(env.DEPLOYMENT_MODE) !== "hosted") {
    return;
  }

  const required = ["DATABASE_URL", "SESSION_SECRET"] as const;
  const missing = required.filter((key) => !env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(
      `Hosted mode requires the following environment variables: ${missing.join(", ")}`,
    );
  }

  if (!env.DATABASE_URL?.startsWith("postgresql://") && !env.DATABASE_URL?.startsWith("postgres://")) {
    throw new Error("Hosted mode requires a PostgreSQL DATABASE_URL.");
  }
}
