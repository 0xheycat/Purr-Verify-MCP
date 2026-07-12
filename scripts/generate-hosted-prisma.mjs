import { spawnSync } from "node:child_process";

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
const env = {
  ...process.env,
  DATABASE_URL:
    configuredDatabaseUrl ||
    "postgresql://localhost:5432/purr_verify_client_generation",
};

const result = spawnSync(
  process.platform === "win32" ? "prisma.cmd" : "prisma",
  ["generate", "--schema", "prisma/hosted/schema.prisma"],
  {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
