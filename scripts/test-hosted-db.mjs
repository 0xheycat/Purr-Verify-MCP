import { spawnSync } from "node:child_process";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("DATABASE_URL is required for hosted PostgreSQL integration tests.");
  process.exit(1);
}

let parsedDatabaseUrl;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  console.error("DATABASE_URL must be a valid PostgreSQL URL.");
  process.exit(1);
}

if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
  console.error("DATABASE_URL must use the postgres:// or postgresql:// protocol.");
  process.exit(1);
}

const steps = [
  ["bun", ["run", "db:hosted:generate"]],
  [
    "bunx",
    [
      "prisma",
      "db",
      "push",
      "--schema",
      "prisma/hosted/schema.prisma",
      "--skip-generate",
    ],
  ],
  [
    "bun",
    ["test", "src/lib/jobs/prisma-hosted-job-store.integration.test.ts"],
  ],
];

for (const [command, args] of steps) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
