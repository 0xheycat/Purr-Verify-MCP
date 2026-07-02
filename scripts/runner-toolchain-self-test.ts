import { prepareToolchain, installStrategy } from "../src/lib/verify/toolchain";
import { validateResolutionProbe } from "../src/lib/verify/mcp";

const cwd = process.cwd();

const toolchain = await prepareToolchain(cwd);
const install = await installStrategy(cwd, "bun install");
const probe = validateResolutionProbe(["@solana/web3.js", "next"]);

const failures: string[] = [];

if (!toolchain.nodeVersion) failures.push("node version was not detected");
if (!toolchain.bunVersion) failures.push("bun version was not detected");
if (install.effectiveCommand !== "bun install --frozen-lockfile") {
  failures.push(`bun install was not promoted to frozen mode: ${install.effectiveCommand}`);
}
if (!install.lockfileHonored) {
  failures.push("bun lockfile was not marked honored");
}
if (!probe.ok) {
  failures.push(`resolution_probe validation failed: ${probe.reason}`);
}

const result = {
  ok: failures.length === 0,
  toolchain: {
    declared: toolchain.declared,
    nodeVersion: toolchain.nodeVersion,
    bunVersion: toolchain.bunVersion,
    warnings: toolchain.warnings,
  },
  install,
  resolutionProbePackages: probe.packages,
  failures,
};

console.log(JSON.stringify(result, null, 2));

if (failures.length > 0) {
  process.exit(1);
}
