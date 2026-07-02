"use client";

// Command palette (Cmd+K / Ctrl+K) — a single keyboard-driven entry point for
// everything you can do in the dashboard:
//   - Quick actions (toggle theme, toggle notifications, refresh)
//   - Navigation (back to dashboard, recent jobs)
//   - Quick-fill form with a preset command list
//   - Toggle favorites filter
//
// The palette is rendered globally by page.tsx and opened via the global
// `purr-verify-open-command-palette` event (which useKeyboardShortcuts fires
// on Cmd+K). It's also opened directly by the header CommandPaletteButton.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Cat,
  CornerDownLeft,
  Moon,
  RefreshCw,
  Sparkles,
  Star,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";
import type { Job } from "@/lib/verify/types";
import { toggleFavorite, useFavorites } from "@/lib/verify/favorites";
import { toast } from "sonner";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobs: Job[];
  onRefresh: () => void;
  onApplyPreset: (commands: string[]) => void;
  onToggleFavoritesFilter: () => void;
  favoritesFilterActive: boolean;
}

const PRESETS: { name: string; commands: string[]; description: string }[] = [
  {
    name: "Bun install + test",
    commands: ["bun install", "bun test"],
    description: "Install deps and run the test suite",
  },
  {
    name: "Bun CI check",
    commands: ["bun install", "bun run ci:check"],
    description: "Install + run lint/typecheck/tests",
  },
  {
    name: "Bun build",
    commands: ["bun install", "bun run build"],
    description: "Install + production build",
  },
  {
    name: "Prisma + build",
    commands: ["bun install", "bunx prisma generate", "bun run build"],
    description: "Install + prisma client + build",
  },
  {
    name: "Frozen install + test",
    commands: ["bun install --frozen-lockfile", "bun test"],
    description: "Reproducible install + tests",
  },
];

const STATUS_ORDER: Record<string, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  timeout: 3,
  canceled: 4,
  success: 5,
};

export function CommandPalette({
  open,
  onOpenChange,
  jobs,
  onRefresh,
  onApplyPreset,
  onToggleFavoritesFilter,
  favoritesFilterActive,
}: CommandPaletteProps) {
  const router = useRouter();
  const favorites = useFavorites();
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const [search, setSearch] = useState("");

  // Reset search when the palette closes.
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => setSearch(""), 150);
      return () => clearTimeout(t);
    }
  }, [open]);

  const goJob = (id: string) => {
    onOpenChange(false);
    router.push(`/?job=${id}`);
  };

  const sortedJobs = useMemo(() => {
    return [...jobs].sort((a, b) => {
      // Favorites first, then by status priority, then by most recent.
      const fa = favoriteSet.has(a.jobId) ? 0 : 1;
      const fb = favoriteSet.has(b.jobId) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const sa = STATUS_ORDER[a.status] ?? 99;
      const sb = STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      const ta = new Date(a.queuedAt).getTime();
      const tb = new Date(b.queuedAt).getTime();
      return tb - ta;
    });
  }, [jobs, favoriteSet]);

  const recentJobs = sortedJobs.slice(0, 8);
  const favoriteJobs = sortedJobs.filter((j) => favoriteSet.has(j.jobId)).slice(0, 6);

  const handleToggleTheme = () => {
    onOpenChange(false);
    // Defer so the dialog closes before the theme toggle's transition runs.
    setTimeout(() => {
      // Use next-themes' setter directly via a custom event so ThemeToggle
      // can pick it up. Simpler: just simulate a click on the existing
      // toggle button so we don't duplicate the theme logic here.
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Toggle theme"]');
      if (btn) btn.click();
    }, 50);
  };

  const handleToggleNotifications = () => {
    onOpenChange(false);
    setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Enable notifications"], button[aria-label="Disable notifications"]');
      if (btn) btn.click();
      else toast.info("Notifications toggle not found");
    }, 50);
  };

  const handleApplyPreset = (commands: string[]) => {
    onOpenChange(false);
    onApplyPreset(commands);
    toast.success(`Applied preset: ${commands.length} command${commands.length === 1 ? "" : "s"}`);
  };

  const handleToggleFav = (id: string) => {
    const nowFav = toggleFavorite(id);
    toast.success(nowFav ? "Added to favorites" : "Removed from favorites", {
      description: id.slice(0, 8),
    });
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a job, run a preset, or toggle a setting."
      className="sm:max-w-[560px]"
    >
      <CommandInput
        placeholder="Type a command, search jobs, or paste a repo…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-[460px]">
        <CommandEmpty>
          <div className="flex flex-col items-center gap-2 py-6 text-xs text-muted-foreground">
            <X className="h-5 w-5 opacity-50" />
            <span>No results for &ldquo;{search}&rdquo;</span>
          </div>
        </CommandEmpty>

        {/* Quick actions */}
        <CommandGroup heading="Quick actions">
          <CommandItem
            onSelect={() => {
              onOpenChange(false);
              router.push("/");
              setTimeout(onRefresh, 100);
            }}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4 text-amber-500" />
            <span>Refresh dashboard</span>
            <CommandShortcut>↻</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleTheme} className="gap-2">
            <Sun className="h-4 w-4 text-amber-500 dark:hidden" />
            <Moon className="hidden h-4 w-4 text-amber-400 dark:block" />
            <span>Toggle dark / light theme</span>
            <CommandShortcut>theme</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleNotifications} className="gap-2">
            <Cat className="h-4 w-4 text-amber-500" />
            <span>Toggle desktop notifications</span>
          </CommandItem>
          <CommandItem
            onSelect={() => {
              onOpenChange(false);
              onToggleFavoritesFilter();
              toast.info(
                favoritesFilterActive
                  ? "Showing all jobs (favorites filter off)"
                  : "Now showing only favorite jobs",
              );
            }}
            className="gap-2"
          >
            <Star className={favoriteSet.size > 0 ? "h-4 w-4 text-amber-500" : "h-4 w-4"} />
            <span>{favoritesFilterActive ? "Show all jobs (clear favorites filter)" : "Show only favorites"}</span>
            {favoriteSet.size > 0 && (
              <Badge variant="outline" className="ml-auto h-5 px-1.5 text-[10px] font-mono">
                {favoriteSet.size}
              </Badge>
            )}
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Presets */}
        <CommandGroup heading="Quick-fill form with preset">
          {PRESETS.map((p) => (
            <CommandItem
              key={p.name}
              onSelect={() => handleApplyPreset(p.commands)}
              className="gap-2"
            >
              <Sparkles className="h-4 w-4 text-orange-500" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{p.name}</span>
                <span className="truncate text-[10px] text-muted-foreground">{p.description}</span>
              </div>
              <code className="ml-auto hidden max-w-[160px] truncate font-mono text-[10px] text-muted-foreground sm:inline">
                {p.commands.join(" → ")}
              </code>
            </CommandItem>
          ))}
        </CommandGroup>

        {/* Favorites (only show if there are any) */}
        {favoriteJobs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Favorites">
              {favoriteJobs.map((j) => (
                <CommandItem
                  key={j.jobId}
                  onSelect={() => goJob(j.jobId)}
                  className="gap-2"
                >
                  <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" />
                  <code className="font-mono text-xs">{j.jobId.slice(0, 8)}</code>
                  <span className="truncate text-xs text-muted-foreground">{j.repo}</span>
                  <span className="ml-auto">
                    <StatusBadge status={j.status} />
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* Recent jobs */}
        {recentJobs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent jobs">
              {recentJobs.map((j) => (
                <CommandItem
                  key={j.jobId}
                  onSelect={() => goJob(j.jobId)}
                  className="gap-2"
                >
                  {favoriteSet.has(j.jobId) ? (
                    <Star
                      className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleToggleFav(j.jobId);
                      }}
                    />
                  ) : (
                    <Star
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 hover:text-amber-500"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleToggleFav(j.jobId);
                      }}
                    />
                  )}
                  <code className="font-mono text-xs">{j.jobId.slice(0, 8)}</code>
                  <span className="truncate text-xs">
                    <span className="font-medium">{j.repo}</span>{" "}
                    <span className="text-muted-foreground">{j.ref}</span>
                  </span>
                  <span className="ml-auto">
                    <StatusBadge status={j.status} />
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />

        {/* Footer hint */}
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" />
            to select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted/40 px-1 font-mono">↑↓</kbd>
            to navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted/40 px-1 font-mono">Esc</kbd>
            to close
          </span>
        </div>
      </CommandList>
    </CommandDialog>
  );
}

// Tiny standalone button that opens the palette. Rendered in the header.
export function CommandPaletteButton({
  onClick,
  hasToken,
}: {
  onClick: () => void;
  hasToken: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open command palette"
      title="Open command palette (⌘K)"
      className="hidden md:inline-flex h-8 items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-amber-300 hover:bg-amber-50/50 hover:text-amber-700 dark:hover:border-amber-700 dark:hover:bg-amber-950/20 dark:hover:text-amber-300"
    >
      <Terminal className="h-3 w-3" />
      <span>Quick actions</span>
      <kbd className="rounded border bg-muted/60 px-1 py-px font-mono text-[9px]">⌘K</kbd>
    </button>
  );
}
