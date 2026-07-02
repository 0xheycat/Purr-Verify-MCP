"use client";

import { useEffect, useState } from "react";
import { KeyRound, LogOut, ShieldCheck, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getHealth, clearToken, getToken, setToken } from "@/lib/verify/client";
import { cn } from "@/lib/utils";
import type { HealthResponse } from "@/lib/verify/types";

export function TokenGate({ onTokenChanged }: { onTokenChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [value, setValue] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    // Reading localStorage is an external-system sync; safe to set state here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasToken(!!getToken());
  }, [open]);

  // Fetch health once to adapt the UI text to the active auth mode.
  useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => {
        if (alive) setHealth(h);
      })
      .catch(() => {
        // ignore — UI falls back to server_token wording
      });
    return () => {
      alive = false;
    };
  }, []);

  const passthrough = health?.authMode === "github_passthrough";
  const tokenLabel = passthrough ? "GitHub PAT" : "VERIFY_TOKEN";
  const placeholder = passthrough ? "ghp_… or github_pat_…" : "purr-verify-…";

  const save = () => {
    setToken(value.trim());
    setHasToken(true);
    setValue("");
    setOpen(false);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1500);
    // Notify parent so it can re-fetch data now that auth is available.
    onTokenChanged?.();
  };

  const logout = () => {
    clearToken();
    setHasToken(false);
    onTokenChanged?.();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {hasToken ? (
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "gap-2 transition-all duration-300",
              justSaved
                ? "border-emerald-400 animate-glow-pulse dark:border-emerald-500"
                : "shadow-[0_0_8px_rgba(16,185,129,0.2)] dark:shadow-[0_0_8px_rgba(16,185,129,0.15)]"
            )}
          >
            {justSaved ? (
              <Check className="h-4 w-4 text-emerald-600 animate-in fade-in zoom-in duration-200" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            )}
            Token set
          </Button>
        ) : (
          <Button variant="default" size="sm" className="gap-2">
            <KeyRound className="h-4 w-4" />
            Set API token
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify API token</DialogTitle>
          <DialogDescription>
            {passthrough ? (
              <>
                This server runs in <code className="rounded bg-muted px-1 py-0.5 text-xs">github_passthrough</code> mode.
                Paste a <strong>GitHub PAT</strong> as the bearer token — the server validates it
                via the GitHub API and uses it to clone private repos. It is stored only in your
                browser&apos;s localStorage and sent as a Bearer header on authenticated requests.
              </>
            ) : (
              <>
                Enter the <code className="rounded bg-muted px-1 py-0.5 text-xs">VERIFY_TOKEN</code>{" "}
                value configured on the server. It is stored only in your browser&apos;s localStorage
                and sent as a Bearer header on authenticated requests.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="token">Bearer token ({tokenLabel})</Label>
          <Input
            id="token"
            type="password"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          {passthrough && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              Tip: create a fine-grained PAT with <code className="font-mono">Contents: Read</code> on
              the repos you want to verify.
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {hasToken ? (
            <Button variant="ghost" size="sm" className="gap-2 text-rose-600" onClick={logout}>
              <LogOut className="h-4 w-4" /> Clear token
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save} disabled={!value.trim()}>
            Save token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
