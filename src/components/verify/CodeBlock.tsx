"use client";

// A <pre> code block with a copy-to-clipboard button. Used in the API &
// MCP reference section so users can grab the curl example with one click.

import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  // Optional language label (e.g., "bash", "json") shown in the top-right.
  language?: string;
  className?: string;
}

export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground",
        className
      )}
    >
      {language && (
        <span className="pointer-events-none absolute right-2 top-2 rounded border border-border/40 bg-background/60 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
          {language}
        </span>
      )}
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy code to clipboard"
        title="Copy code to clipboard"
        className={cn(
          "absolute right-2 top-2 z-10 inline-flex h-6 items-center gap-1 rounded border border-border/60 bg-background/80 px-2 text-[10px] font-medium opacity-0 backdrop-blur transition-all hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 group-hover:opacity-100 dark:hover:border-amber-700 dark:hover:bg-amber-950/40 dark:hover:text-amber-300",
          language && "right-12"
        )}
      >
        {copied ? (
          <>
            <Check className="h-3 w-3 text-emerald-600" /> Copied
          </>
        ) : (
          <>
            <ClipboardCopy className="h-3 w-3" /> Copy
          </>
        )}
      </button>
      <pre className="overflow-x-auto pr-20">{code}</pre>
    </div>
  );
}
