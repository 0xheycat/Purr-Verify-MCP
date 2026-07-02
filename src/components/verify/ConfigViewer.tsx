"use client";

import { useState } from "react";
import { Settings, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getHealth } from "@/lib/verify/client";
import type { HealthResponse } from "@/lib/verify/types";
import { cn } from "@/lib/utils";
import { useEffect } from "react";

const ENV_VARS = [
  { key: "AUTH_MODE", description: "Auth mode: server_token or github_passthrough", secret: false },
  { key: "VERIFY_TOKEN", description: "Bearer token for API auth (server_token mode)", secret: true },
  { key: "GITHUB_TOKEN", description: "GitHub PAT for private repos (server_token mode fallback)", secret: true },
  { key: "ALLOWED_REPOS", description: "Comma-separated repo allowlist", secret: false },
  { key: "MAX_CONCURRENT_JOBS", description: "Max parallel jobs", secret: false },
  { key: "COMMAND_TIMEOUT_MS", description: "Per-command timeout", secret: false },
  { key: "JOB_TIMEOUT_MS", description: "Per-job overall timeout", secret: false },
  { key: "MAX_LOG_BYTES", description: "Log size cap per stream", secret: false },
  { key: "WORKDIR_BASE", description: "Workspace directory base", secret: false },
];

export function ConfigViewer() {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const h = await getHealth();
        if (alive) setHealth(h);
      } catch {
        // ignore
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-muted/30"
        onClick={() => setOpen(!open)}
      >
        <Settings className="h-5 w-5 text-amber-600" />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Server configuration</span>
            <Badge variant="outline" className="text-[10px] font-mono">
              {health?.version || "—"}
            </Badge>
            {health?.configured ? (
              <Badge className="text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900">
                configured
              </Badge>
            ) : (
              <Badge className="text-[10px] bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900">
                unconfigured
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Current environment variables and server settings (secrets redacted).
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
          {/* Server info */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <InfoCard label="Service" value={health?.service || "—"} />
            <InfoCard label="Version" value={health?.version || "—"} mono />
            <InfoCard label="Active Jobs" value={String(health?.activeJobs ?? 0)} />
            <InfoCard label="Total Jobs" value={String(health?.totalJobs ?? 0)} />
          </div>

          {/* Allowed repos */}
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Authentication &amp; Allowed Repositories
            </h3>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-1 text-xs font-mono">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    health?.authMode === "github_passthrough" ? "bg-amber-500" : "bg-emerald-500"
                  )}
                />
                AUTH_MODE={health?.authMode || "—"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-1 text-xs font-mono">
                githubTokenSource={health?.githubTokenSource || "—"}
              </span>
              {health?.authMode === "github_passthrough" ? (
                <span className="text-[11px] text-muted-foreground">
                  Bearer token is a GitHub PAT (validated via api.github.com, used to clone private
                  repos). VERIFY_TOKEN not required.
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  Bearer token is VERIFY_TOKEN; private repos use env GITHUB_TOKEN
                  {health?.githubTokenSource === "none" ? " (not set — public repos only)" : ""}.
                </span>
              )}
            </div>
            {health?.allowAllRepos ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Unrestricted — any owner/repo
                </span>
                <span className="text-[11px] text-muted-foreground">
                  ALLOWED_REPOS is empty or "*", or ALLOW_ALL_REPOS=true is set.
                  Any repo matching <code className="font-mono">owner/repo</code>{" "}
                  is accepted; cloning is always from github.com.
                </span>
              </div>
            ) : health?.allowedRepos && health.allowedRepos.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {health.allowedRepos.map((repo) => (
                  <span
                    key={repo}
                    className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-1 text-xs font-mono"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {repo}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">(none)</span>
            )}
          </div>

          {/* Environment variables */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Environment Variables
              </h3>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition"
                onClick={() => setShowSecrets(!showSecrets)}
              >
                {showSecrets ? (
                  <EyeOff className="h-3 w-3" />
                ) : (
                  <Eye className="h-3 w-3" />
                )}
                {showSecrets ? "Hide secrets" : "Show secrets"}
              </button>
            </div>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Variable</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-left font-medium">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {ENV_VARS.map((v) => (
                    <tr key={v.key} className="hover:bg-muted/20 transition">
                      <td className="px-3 py-2 font-mono text-foreground">{v.key}</td>
                      <td className="px-3 py-2 text-muted-foreground">{v.description}</td>
                      <td className="px-3 py-2">
                        {v.secret && !showSecrets ? (
                          <span className="rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground">
                            ••••••••
                          </span>
                        ) : (
                          <span className="font-mono text-muted-foreground">
                            {getEnvValue(v.key, health)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-semibold ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function getEnvValue(key: string, health: HealthResponse | null): string {
  switch (key) {
    case "AUTH_MODE":
      return health?.authMode || "server_token";
    case "VERIFY_TOKEN":
      return health?.authMode === "github_passthrough"
        ? "(optional in passthrough)"
        : health?.configured
          ? "(set)"
          : "(not set)";
    case "GITHUB_TOKEN":
      return health?.githubTokenSource === "env" ? "(set)" : "(check server .env)";
    case "ALLOWED_REPOS":
      if (health?.allowAllRepos) return "* (unrestricted)";
      return health?.allowedRepos?.join(", ") || "(none)";
    case "MAX_CONCURRENT_JOBS":
      return process.env.NEXT_PUBLIC_MAX_CONCURRENT_JOBS || "1";
    case "COMMAND_TIMEOUT_MS":
      return process.env.NEXT_PUBLIC_COMMAND_TIMEOUT_MS || "600000";
    case "JOB_TIMEOUT_MS":
      return process.env.NEXT_PUBLIC_JOB_TIMEOUT_MS || "1800000";
    case "MAX_LOG_BYTES":
      return process.env.NEXT_PUBLIC_MAX_LOG_BYTES || "512000";
    case "WORKDIR_BASE":
      return ".verify-workspaces";
    default:
      return "—";
  }
}
