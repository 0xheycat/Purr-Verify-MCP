import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://localhost:5432/purr_verify_schema_validation",
};

const result = spawnSync(
  process.platform === "win32" ? "prisma.cmd" : "prisma",
  ["validate", "--schema", "prisma/hosted/schema.prisma"],
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
