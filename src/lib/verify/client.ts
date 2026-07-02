"use client";

// Browser-side helpers for talking to the Purr Verify MCP API.
// The verify token is stored in localStorage and sent as a Bearer header.

import type { HealthResponse, Job, JobAnnotation, PublicJobView, VerifyRequest } from "./types";

const TOKEN_KEY = "purr_verify_token";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): HeadersInit {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function getHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

export async function listJobs(limit = 50): Promise<Job[]> {
  const res = await fetch(`/api/jobs?limit=${limit}`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`list jobs ${res.status}`);
  const data = await res.json();
  return data.jobs as Job[];
}

export async function getJob(jobId: string): Promise<Job> {
  const res = await fetch(`/api/verify/${jobId}`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get job ${res.status}`);
  return res.json();
}

export async function getJobMarkdown(jobId: string): Promise<string> {
  const res = await fetch(`/api/verify/${jobId}?format=markdown`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`get markdown ${res.status}`);
  const data = await res.json();
  return data.markdown as string;
}

export async function createJob(req: VerifyRequest): Promise<{ jobId: string; status: string; statusUrl: string }> {
  const res = await fetch("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `create job ${res.status}`);
  return data;
}

export async function updateJobTags(
  jobId: string,
  tags: string[]
): Promise<{ jobId: string; tags: string[] }> {
  const res = await fetch(`/api/verify/${jobId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ tags }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `update tags ${res.status}`);
  return data;
}

export async function cancelJob(jobId: string): Promise<{ canceled: boolean; status: string }> {
  const res = await fetch(`/api/verify/${jobId}/cancel`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `cancel ${res.status}`);
  return data;
}

export interface WebhookRetryResult {
  jobId: string;
  ok: boolean;
  status: "success" | "failed" | "timeout";
  statusCode: number | null;
  error: string | null;
  attempt: number;
}

export async function retryWebhook(jobId: string): Promise<WebhookRetryResult> {
  const res = await fetch(`/api/verify/${jobId}/webhook/retry`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `retry webhook ${res.status}`);
  return data as WebhookRetryResult;
}

export async function deleteJob(jobId: string): Promise<{ deleted: boolean; jobId: string }> {
  const res = await fetch(`/api/verify/${jobId}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `delete ${res.status}`);
  return data;
}

export async function deleteAllJobs(): Promise<{ deleted: number }> {
  const res = await fetch("/api/jobs", {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `delete all ${res.status}`);
  return data;
}

export async function validateJob(req: VerifyRequest): Promise<{ valid: boolean; commands?: string[]; errors?: string[] }> {
  const res = await fetch("/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `validate ${res.status}`);
  return data;
}

export interface QueuePositionInfo {
  jobId: string;
  position: number | null;
  totalQueued: number;
  estimatedWaitMs: number | null;
}

export async function getQueuePosition(jobId: string): Promise<QueuePositionInfo> {
  const res = await fetch(`/api/verify/${jobId}/queue-position`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `queue-position ${res.status}`);
  return data as QueuePositionInfo;
}

/**
 * Open an SSE connection to stream live job updates.
 *
 * Since EventSource doesn't support custom headers, the auth token is passed
 * as a `?token=xxx` query parameter.
 *
 * @returns A cleanup function that closes the EventSource connection.
 */
export function streamJob(
  jobId: string,
  onUpdate: (job: Job) => void,
  onError?: (err: Event) => void
): () => void {
  const token = getToken();
  const url = `/api/verify/${jobId}/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const es = new EventSource(url);

  es.addEventListener("job", (e: MessageEvent) => {
    try {
      const job = JSON.parse(e.data) as Job;
      onUpdate(job);
    } catch {
      // ignore parse errors
    }
  });

  if (onError) {
    es.addEventListener("error", onError);
  }

  // Return cleanup function.
  return () => {
    es.close();
  };
}


// ============================================================================
// Annotation helpers
// ============================================================================

export async function addAnnotation(
  jobId: string,
  text: string,
  author?: string
): Promise<JobAnnotation> {
  const res = await fetch(`/api/verify/${jobId}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ text, ...(author ? { author } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `add annotation ${res.status}`);
  return data as JobAnnotation;
}

export async function deleteAnnotation(
  jobId: string,
  annotationId: string
): Promise<{ deleted: boolean; annotationId: string }> {
  const res = await fetch(`/api/verify/${jobId}/annotations/${annotationId}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `delete annotation ${res.status}`);
  return data as { deleted: boolean; annotationId: string };
}

// Force re-resolve marker (Phase 5)

// ============================================================================
// Share token helpers
// ============================================================================

export interface ShareTokenInfo {
  token: string;
  jobId: string;
  createdAt: string;
  expiresAt: string;
  note: string | null;
  shareUrl: string;
  ttlHours: number;
}

export interface CreateShareOpts {
  ttlHours?: number;
  note?: string;
}

export async function createShareToken(
  jobId: string,
  opts: CreateShareOpts = {}
): Promise<ShareTokenInfo> {
  const res = await fetch(`/api/verify/${jobId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      ...(opts.ttlHours !== undefined ? { ttlHours: opts.ttlHours } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `create share ${res.status}`);
  return data as ShareTokenInfo;
}

export async function listShareTokens(
  jobId: string
): Promise<{ jobId: string; tokens: ShareTokenInfo[] }> {
  const res = await fetch(`/api/verify/${jobId}/share`, {
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `list shares ${res.status}`);
  return data as { jobId: string; tokens: ShareTokenInfo[] };
}

export async function revokeAllShares(
  jobId: string
): Promise<{ jobId: string; revoked: number }> {
  const res = await fetch(`/api/verify/${jobId}/share`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `revoke shares ${res.status}`);
  return data as { jobId: string; revoked: number };
}

// Fetch a public shared job (no auth required).
export async function getSharedJob(
  token: string
): Promise<PublicJobView> {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `shared job ${res.status}`);
  }
  return res.json();
}

export async function getSharedJobMarkdown(token: string): Promise<string> {
  const res = await fetch(
    `/api/share/${encodeURIComponent(token)}?format=markdown`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `shared markdown ${res.status}`);
  }
  const data = await res.json();
  return data.markdown as string;
}
