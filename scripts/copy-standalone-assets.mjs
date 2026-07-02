import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standaloneDir = join(root, ".next", "standalone");
const staticSource = join(root, ".next", "static");
const staticTarget = join(standaloneDir, ".next", "static");
const publicSource = join(root, "public");
const publicTarget = join(standaloneDir, "public");

if (!existsSync(standaloneDir)) {
  throw new Error("Missing .next/standalone. Ensure next.config.ts uses output: 'standalone'.");
}

await mkdir(join(standaloneDir, ".next"), { recursive: true });

if (existsSync(staticSource)) {
  await cp(staticSource, staticTarget, { recursive: true, force: true });
}

if (existsSync(publicSource)) {
  await cp(publicSource, publicTarget, { recursive: true, force: true });
}

console.log("Copied standalone assets.");
