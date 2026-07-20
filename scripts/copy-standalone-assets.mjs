import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const standaloneDir = join(root, ".next", "standalone");
const staticSource = join(root, ".next", "static");
const staticTarget = join(standaloneDir, ".next", "static");
const publicSource = join(root, "public");
const publicTarget = join(standaloneDir, "public");
const playwrightBrowsersSource = join(root, "node_modules", "playwright-core", "browsers.json");
const playwrightBrowsersTarget = join(
  standaloneDir,
  "node_modules",
  "playwright-core",
  "browsers.json",
);

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

if (existsSync(playwrightBrowsersSource)) {
  await mkdir(dirname(playwrightBrowsersTarget), { recursive: true });
  await cp(playwrightBrowsersSource, playwrightBrowsersTarget, { force: true });
  if (!existsSync(playwrightBrowsersTarget)) {
    throw new Error("Failed to copy playwright-core/browsers.json into the standalone runtime.");
  }
}

console.log("Copied standalone assets.");
