import { spawnSync } from "node:child_process";

const steps = [
  ["bun", ["install", "--frozen-lockfile"]],
  ["bunx", ["prisma", "generate"]],
  ["bun", ["test", "src/lib/verify/operator-phase2.test.ts"]],
  ["bun", ["test", "src/lib/verify/operator-snapshot.test.ts"]],
  ["bun", ["test", "--isolate"]],
  ["bun", ["run", "typecheck"]],
  ["bun", ["run", "lint"]],
  ["bun", ["run", "build"]],
];

for (const [command, args] of steps) {
  const label = [command, ...args].join(" ");
  console.log(`\n[purr-phase2-gate] START ${label}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`[purr-phase2-gate] ERROR ${label}: ${result.error.message}`);
    process.exit(1);
  }
  const status = result.status ?? 1;
  console.log(`[purr-phase2-gate] END ${label} exit=${status}`);
  if (status !== 0) process.exit(status);
}

console.log("\n[purr-phase2-gate] ALL STEPS PASSED");
