"use client";

// Browser Notifications helper for Purr Verify MCP.
// Tracks active jobs and fires a desktop notification when they complete.

import type { Job } from "./types";

const NOTIFIED_KEY = "purr_verify_notified_jobs";
const NOTIFIED_TTL_MS = 1000 * 60 * 60 * 24; // 24h

interface NotifiedRecord {
  jobId: string;
  status: string;
  ts: number;
}

function readNotified(): Map<string, NotifiedRecord> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    if (!raw) return new Map();
    const arr = JSON.parse(raw) as NotifiedRecord[];
    const now = Date.now();
    const map = new Map<string, NotifiedRecord>();
    for (const r of arr) {
      if (now - r.ts < NOTIFIED_TTL_MS) map.set(r.jobId, r);
    }
    return map;
  } catch {
    return new Map();
  }
}

function writeNotified(map: Map<string, NotifiedRecord>): void {
  if (typeof window === "undefined") return;
  try {
    const arr = Array.from(map.values()).slice(-200);
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(arr));
  } catch {
    // ignore quota errors
  }
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationsPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Given the latest list of jobs, fire a notification for any job that just
 * reached a terminal state AND we haven't notified about it yet.
 *
 * Returns the count of notifications fired.
 */
export function fireCompletionNotifications(jobs: Job[]): number {
  if (!notificationsSupported() || Notification.permission !== "granted") return 0;
  const notified = readNotified();
  let fired = 0;
  let dirty = false;
  for (const job of jobs) {
    const isTerminal =
      job.status === "success" ||
      job.status === "failed" ||
      job.status === "canceled" ||
      job.status === "timeout";
    if (!isTerminal) continue;
    const prev = notified.get(job.jobId);
    if (prev && prev.status === job.status) continue;
    // Fire notification.
    const title =
      job.status === "success"
        ? "✅ Verification passed"
        : job.status === "failed"
        ? "❌ Verification failed"
        : job.status === "timeout"
        ? "⏱ Verification timed out"
        : "🚫 Verification canceled";
    const body = `${job.repo}@${job.ref} · ${job.jobId.slice(0, 8)}${
      job.durationMs != null ? ` · ${(job.durationMs / 1000).toFixed(1)}s` : ""
    }`;
    try {
      const n = new Notification(title, {
        body,
        tag: job.jobId,
        icon: "/favicon.ico",
        silent: false,
      });
      // Auto-close after 6s.
      setTimeout(() => n.close(), 6000);
      n.onclick = () => {
        window.focus();
        n.close();
      };
      fired++;
    } catch {
      // ignore — some browsers throw if notifications are blocked mid-flight
    }
    notified.set(job.jobId, { jobId: job.jobId, status: job.status, ts: Date.now() });
    dirty = true;
  }
  if (dirty) writeNotified(notified);
  return fired;
}

/**
 * Clear notified-jobs cache (useful after manual review).
 */
export function clearNotifiedCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(NOTIFIED_KEY);
  } catch {
    // ignore
  }
}
