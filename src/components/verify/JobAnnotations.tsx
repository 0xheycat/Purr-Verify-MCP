"use client";

import { useState } from "react";
import {
  ChevronDown,
  MessageSquare,
  Plus,
  Trash2,
  Loader2,
  User,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addAnnotation, deleteAnnotation } from "@/lib/verify/client";
import type { JobAnnotation } from "@/lib/verify/types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Relative time formatter
function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function JobAnnotations({
  jobId,
  annotations,
  onAnnotationsChanged,
}: {
  jobId: string;
  annotations: JobAnnotation[];
  onAnnotationsChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const count = annotations.length;

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      toast.error("Annotation text is required");
      return;
    }
    if (trimmed.length > 2000) {
      toast.error("Annotation text must be ≤ 2000 characters");
      return;
    }
    setSubmitting(true);
    try {
      await addAnnotation(jobId, trimmed, author.trim() || undefined);
      setText("");
      toast.success("Annotation added");
      onAnnotationsChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (annotationId: string) => {
    setDeletingId(annotationId);
    try {
      await deleteAnnotation(jobId, annotationId);
      toast.success("Annotation deleted");
      onAnnotationsChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/20 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse annotations" : "Expand annotations"}
      >
        <MessageSquare className="h-4 w-4 text-amber-500" />
        <h2 className="text-sm font-semibold">Annotations</h2>
        {count > 0 && (
          <span className="inline-flex items-center justify-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
            {count}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-180"
          )}
        />
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3">
          {/* Add annotation form */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                placeholder="Add a note…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-8 flex-1 text-xs"
                disabled={submitting}
                maxLength={2000}
              />
              <Button
                type="button"
                size="sm"
                className={cn(
                  "h-8 gap-1 px-3 text-xs",
                  "bg-amber-500 text-white hover:bg-amber-600 shadow-sm shadow-amber-500/20"
                )}
                disabled={submitting || !text.trim()}
                onClick={handleSubmit}
              >
                {submitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Add
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <User className="h-3 w-3 text-muted-foreground/50" />
              <Input
                placeholder="Author (optional)"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                className="h-6 flex-1 text-[11px] bg-transparent border-dashed"
                disabled={submitting}
                maxLength={100}
              />
            </div>
          </div>

          {/* Annotation list */}
          {count === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1.5 py-6 text-xs text-muted-foreground">
              <MessageSquare className="h-5 w-5 text-amber-500 opacity-30" />
              <span>No annotations yet.</span>
              <span className="text-[10px] text-muted-foreground/60">
                Add a note to document this job.
              </span>
            </div>
          ) : (
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {annotations.map((annotation) => (
                <div
                  key={annotation.id}
                  className="group relative rounded-lg border bg-muted/20 p-3 transition-colors hover:bg-amber-50/30 dark:hover:bg-amber-950/10"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex-1 text-xs whitespace-pre-wrap break-words leading-relaxed">
                      {annotation.text}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 shrink-0 p-0 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity hover:text-rose-600"
                      disabled={deletingId === annotation.id}
                      onClick={() => handleDelete(annotation.id)}
                      aria-label="Delete annotation"
                      title="Delete annotation"
                    >
                      {deletingId === annotation.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/70">
                    <span className="flex items-center gap-0.5">
                      <Clock className="h-2.5 w-2.5" />
                      {relativeTime(annotation.createdAt)}
                    </span>
                    {annotation.author && (
                      <span className="flex items-center gap-0.5">
                        <User className="h-2.5 w-2.5" />
                        {annotation.author}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
