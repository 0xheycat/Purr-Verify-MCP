"use client";

// localStorage-backed set of favorited/pinned job IDs. Lets users star
// frequently-accessed jobs and filter the dashboard to just those.

const FAVORITES_KEY = "purr_verify_favorites";

function readSet(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function writeSet(s: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(s)));
  } catch {
    // ignore quota / private mode errors
  }
}

export function getFavorites(): string[] {
  return Array.from(readSet());
}

export function isFavorite(jobId: string): boolean {
  return readSet().has(jobId);
}

export function toggleFavorite(jobId: string): boolean {
  const s = readSet();
  let nowFavorite: boolean;
  if (s.has(jobId)) {
    s.delete(jobId);
    nowFavorite = false;
  } else {
    s.add(jobId);
    nowFavorite = true;
  }
  writeSet(s);
  // Notify other components (e.g., the table and the command palette) that
  // the favorites set changed. We use a storage event simulator since
  // localStorage 'storage' events only fire in OTHER windows.
  window.dispatchEvent(new CustomEvent("purr-verify-favorites-changed", { detail: { jobId, nowFavorite } }));
  return nowFavorite;
}

export function clearFavorites(): void {
  writeSet(new Set());
  window.dispatchEvent(new CustomEvent("purr-verify-favorites-changed", { detail: { cleared: true } }));
}

// React hook helper: subscribe to favorites changes. Returns the current
// list of favorite job IDs and re-renders when the set changes.
import { useEffect, useState } from "react";

export function useFavorites(): string[] {
  const [favorites, setFavorites] = useState<string[]>(() => getFavorites());
  useEffect(() => {
    const handler = () => setFavorites(getFavorites());
    window.addEventListener("purr-verify-favorites-changed", handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("purr-verify-favorites-changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  return favorites;
}
