"use client";

// LocalStorage-backed command presets and recently-used refs.
// These are browser-only utilities — never imported from server code.

const PRESETS_KEY = "purr_verify_command_presets";
const RECENT_REFS_KEY = "purr_verify_recent_refs";
const RECENT_REPOS_KEY = "purr_verify_recent_repos";

const MAX_PRESETS = 20;
const MAX_RECENT = 10;

// ---- Command Presets ----

export interface CommandPreset {
  name: string;
  commands: string;
  continueOnError: boolean;
  createdAt: number;
}

export function getPresets(): CommandPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as CommandPreset[];
    return Array.isArray(arr) ? arr.sort((a, b) => b.createdAt - a.createdAt) : [];
  } catch {
    return [];
  }
}

export function savePreset(preset: Omit<CommandPreset, "createdAt">): CommandPreset | null {
  if (typeof window === "undefined") return null;
  if (!preset.name.trim() || !preset.commands.trim()) return null;
  const all = getPresets();
  // Replace if name exists (case-insensitive).
  const idx = all.findIndex((p) => p.name.toLowerCase() === preset.name.toLowerCase());
  const entry: CommandPreset = { ...preset, createdAt: Date.now() };
  if (idx >= 0) all[idx] = entry;
  else all.unshift(entry);
  // Cap.
  const capped = all.slice(0, MAX_PRESETS);
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(capped));
    return entry;
  } catch {
    return null;
  }
}

export function deletePreset(name: string): void {
  if (typeof window === "undefined") return;
  const all = getPresets();
  const filtered = all.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(filtered));
  } catch {
    // ignore
  }
}

// ---- Recently-used refs (per repo) ----

export interface RecentRef {
  repo: string;
  ref: string;
  ts: number;
}

export function getRecentRefs(repo?: string): RecentRef[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_REFS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as RecentRef[];
    const filtered = repo ? arr.filter((r) => r.repo === repo) : arr;
    return filtered.sort((a, b) => b.ts - a.ts).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function addRecentRef(repo: string, ref: string): void {
  if (typeof window === "undefined") return;
  if (!repo || !ref.trim()) return;
  try {
    const raw = localStorage.getItem(RECENT_REFS_KEY);
    const arr = raw ? (JSON.parse(raw) as RecentRef[]) : [];
    // Remove existing entry with same repo+ref.
    const filtered = arr.filter((r) => !(r.repo === repo && r.ref === ref));
    filtered.unshift({ repo, ref, ts: Date.now() });
    // Cap per repo: keep latest MAX_RECENT per repo.
    const byRepo = new Map<string, RecentRef[]>();
    for (const r of filtered) {
      if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
      byRepo.get(r.repo)!.push(r);
    }
    const capped: RecentRef[] = [];
    for (const list of byRepo.values()) {
      capped.push(...list.slice(0, MAX_RECENT));
    }
    localStorage.setItem(RECENT_REFS_KEY, JSON.stringify(capped));
  } catch {
    // ignore
  }
}

export function clearRecentRefs(repo?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (!repo) {
      localStorage.removeItem(RECENT_REFS_KEY);
      return;
    }
    const raw = localStorage.getItem(RECENT_REFS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw) as RecentRef[];
    const filtered = arr.filter((r) => r.repo !== repo);
    localStorage.setItem(RECENT_REFS_KEY, JSON.stringify(filtered));
  } catch {
    // ignore
  }
}

// ---- Recently-used repos (tracking which repos user submits most) ----

export function getRecentRepos(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as { repo: string; ts: number }[];
    return arr.sort((a, b) => b.ts - a.ts).map((r) => r.repo);
  } catch {
    return [];
  }
}

export function addRecentRepo(repo: string): void {
  if (typeof window === "undefined") return;
  if (!repo) return;
  try {
    const raw = localStorage.getItem(RECENT_REPOS_KEY);
    const arr = raw ? (JSON.parse(raw) as { repo: string; ts: number }[]) : [];
    const filtered = arr.filter((r) => r.repo !== repo);
    filtered.unshift({ repo, ts: Date.now() });
    localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(filtered.slice(0, 10)));
  } catch {
    // ignore
  }
}
