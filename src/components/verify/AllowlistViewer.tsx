"use client";

import { useState } from "react";
import { Shield, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const ALLOWLIST_PATTERNS = [
  { pattern: "bun install", description: "Install dependencies with Bun" },
  { pattern: "bun install --frozen-lockfile", description: "Install with frozen lockfile (CI-safe)" },
  { pattern: "bunx prisma generate", description: "Generate Prisma client" },
  { pattern: "bun run <script>", description: "Run a package.json script via Bun" },
  { pattern: "bun test", description: "Run all tests with Bun" },
  { pattern: "bun test <path>", description: "Run specific test file(s) via Bun" },
  { pattern: "npm ci", description: "Clean install with npm" },
  { pattern: "npm run <script>", description: "Run a package.json script via npm" },
  { pattern: "pnpm install --frozen-lockfile", description: "Install with frozen lockfile via pnpm" },
  { pattern: "pnpm run <script>", description: "Run a package.json script via pnpm" },
  { pattern: "npx prisma generate", description: "Generate Prisma client via npx" },
  { pattern: "node <path>", description: "Run a safe relative Node.js script" },
  { pattern: "cat reports/<file>.json", description: "Read a JSON report file" },
  { pattern: "cat reports/<file>.txt", description: "Read a text report file" },
  {
    pattern: "ENV_MODE=mock bun run scripts/manage.ts <flags>",
    description: "Run manage script with safe numeric flags only",
  },
];

const FORBIDDEN_TOKENS = [
  ";", "&&", "||", "|", ">", "<", "`", "$()",
  "curl", "wget", "rm", "sudo", "chmod", "chown",
  "ssh", "scp", "docker", "powershell", "nc", "mkfs", "dd",
  "absolute paths", "path traversal (..)",
];

export function AllowlistViewer() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-muted/30"
        onClick={() => setOpen(!open)}
      >
        <Shield className="h-5 w-5 text-amber-600" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Command allowlist &amp; security</span>
            <Badge variant="outline" className="text-[10px] font-mono">
              {ALLOWLIST_PATTERNS.length} patterns
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every command must match an allowlisted grammar. Dangerous tokens are rejected.
          </p>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t px-5 py-4">
          <div className="grid gap-6 md:grid-cols-2">
            {/* Allowed patterns */}
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                ✅ Allowed command patterns
              </h3>
              <ul className="space-y-1.5">
                {ALLOWLIST_PATTERNS.map((p) => (
                  <li key={p.pattern} className="flex items-start gap-2 text-xs">
                    <code className="shrink-0 rounded-md bg-emerald-50 px-1.5 py-0.5 font-mono text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {p.pattern}
                    </code>
                    <span className="text-muted-foreground">{p.description}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-muted-foreground">
                <strong>Safe flags</strong> for the manage script:{" "}
                <code className="rounded bg-muted px-1 text-[10px]">--duration=&lt;n&gt;</code>,{" "}
                <code className="rounded bg-muted px-1 text-[10px]">--poll-interval=&lt;n&gt;</code>,{" "}
                <code className="rounded bg-muted px-1 text-[10px]">--manage-interval=&lt;n&gt;</code>,{" "}
                <code className="rounded bg-muted px-1 text-[10px]">--heartbeat-interval=&lt;n&gt;</code>,{" "}
                <code className="rounded bg-muted px-1 text-[10px]">--mode=&lt;word&gt;</code>,{" "}
                <code className="rounded bg-muted px-1 text-[10px]">--execute=false</code>
              </p>
            </div>

            {/* Forbidden tokens */}
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
                🚫 Forbidden tokens
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {FORBIDDEN_TOKENS.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 font-mono text-[11px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Commands are executed with <code className="rounded bg-muted px-1">spawn(shell:false)</code>.
                No shell interpretation occurs — the allowlist regex is the primary gate.
              </p>

              <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Execution safety
              </h3>
              <ul className="space-y-1 text-[11px] text-muted-foreground">
                <li>• Fresh temp workspace per job (auto-cleaned)</li>
                <li>• Per-command timeout ({process.env.NEXT_PUBLIC_COMMAND_TIMEOUT_MS || "10 min"})</li>
                <li>• Per-job overall timeout ({process.env.NEXT_PUBLIC_JOB_TIMEOUT_MS || "30 min"})</li>
                <li>• Log size capped ({process.env.NEXT_PUBLIC_MAX_LOG_BYTES || "500 KB"} per stream)</li>
                <li>• Secret redaction on all captured output</li>
                <li>• Concurrency limited to {process.env.NEXT_PUBLIC_MAX_CONCURRENT_JOBS || "1"} job at a time</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
