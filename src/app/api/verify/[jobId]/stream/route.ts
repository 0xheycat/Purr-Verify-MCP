// GET /api/verify/:jobId/stream — SSE streaming endpoint for live job updates.
//
// Sends `job` events (full job JSON) on connect and on every change,
// `heartbeat` events every 15 seconds, and closes when the job reaches
// a terminal state (success/failed/canceled/timeout).

import { NextRequest } from "next/server";
import { checkAuth, unauthorized, notFound } from "@/lib/verify/auth";
import { getJob, loadPersisted } from "@/lib/verify/store";
import type { JobStatus } from "@/lib/verify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMINAL_STATUSES: JobStatus[] = ["success", "failed", "canceled", "timeout"];
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;

function sseMessage(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string }> }
) {
  const auth = await checkAuth(req);
  if (!auth.ok) return unauthorized(auth.reason || "unauthorized");

  await loadPersisted();
  const { jobId } = await ctx.params;
  const initialJob = getJob(jobId);
  if (!initialJob) return notFound(`job not found: ${jobId}`);

  // If the job is already in a terminal state, return a single event and close.
  if (TERMINAL_STATUSES.includes(initialJob.status)) {
    const body = sseMessage("job", JSON.stringify(initialJob));
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET",
      },
    });
  }

  const encoder = new TextEncoder();
  let lastJobJson = JSON.stringify(initialJob);

  const stream = new ReadableStream({
    start(controller) {
      // Send initial job state.
      controller.enqueue(encoder.encode(sseMessage("job", lastJobJson)));

      // Poll the store for changes.
      const pollTimer = setInterval(() => {
        try {
          const job = getJob(jobId);
          if (!job) {
            // Job was deleted — close stream.
            clearInterval(pollTimer);
            clearInterval(heartbeatTimer);
            controller.enqueue(
              encoder.encode(sseMessage("error", JSON.stringify({ message: "job not found" })))
            );
            controller.close();
            return;
          }
          const currentJson = JSON.stringify(job);
          if (currentJson !== lastJobJson) {
            lastJobJson = currentJson;
            controller.enqueue(encoder.encode(sseMessage("job", currentJson)));
            // If the job is now terminal, close after a short delay so the
            // client receives the final state.
            if (TERMINAL_STATUSES.includes(job.status)) {
              clearInterval(pollTimer);
              clearInterval(heartbeatTimer);
              // Small delay to ensure the final event is flushed.
              setTimeout(() => {
                try {
                  controller.close();
                } catch {
                  // already closed
                }
              }, 100);
            }
          }
        } catch {
          // If polling fails, keep the connection alive — the client can
          // handle gaps in the event stream.
        }
      }, POLL_INTERVAL_MS);

      // Heartbeat to keep the connection alive through proxies/CDNs.
      const heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(sseMessage("heartbeat", "")));
        } catch {
          // stream already closed
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
        }
      }, HEARTBEAT_INTERVAL_MS);

      // If the client disconnects, clean up timers.
      // Note: ReadableStream doesn't have a built-in "close" event,
      // but the interval callbacks will fail silently once the controller
      // is closed, and we catch that above.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET",
    },
  });
}
