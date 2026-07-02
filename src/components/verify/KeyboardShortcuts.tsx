"use client";

import { useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

/**
 * Global keyboard shortcuts for the dashboard.
 * - Escape: go back from job detail to dashboard
 * - Ctrl/Cmd+Enter: focus the submit form (scroll to top)
 * - Ctrl/Cmd+K: open the command palette (dispatches a global event that
 *   page.tsx listens for). Falls back to focusing the jobs-table search
 *   input if the palette isn't mounted (e.g., on the shared job view).
 * - ?: show keyboard shortcuts toast
 */
export function useKeyboardShortcuts() {
  const router = useRouter();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Escape: go back if on job detail page
      if (e.key === "Escape") {
        const params = new URLSearchParams(window.location.search);
        if (params.get("job") || params.get("rerun")) {
          e.preventDefault();
          router.push("/");
          return;
        }
      }

      // Ctrl/Cmd+Enter: focus submit form
      if (isMod && e.key === "Enter") {
        e.preventDefault();
        const refInput = document.querySelector<HTMLInputElement>('#ref');
        if (refInput) {
          refInput.scrollIntoView({ behavior: "smooth", block: "center" });
          refInput.focus();
        }
        return;
      }

      // Ctrl/Cmd+K: open the command palette. The palette is mounted by
      // page.tsx and listens for the `purr-verify-open-command-palette`
      // event. If no listener responds within 50ms (i.e., the palette
      // isn't mounted — e.g., on the shared job view), fall back to
      // focusing the jobs-table search input.
      if (isMod && e.key === "k") {
        e.preventDefault();
        let handled = false;
        const ack = () => { handled = true; };
        window.addEventListener("purr-verify-open-command-palette-ack", ack, { once: true });
        window.dispatchEvent(new CustomEvent("purr-verify-open-command-palette"));
        // Give the palette a tick to acknowledge; if not, fall back.
        setTimeout(() => {
          window.removeEventListener("purr-verify-open-command-palette-ack", ack);
          if (!handled) {
            const searchInput = document.querySelector<HTMLInputElement>('input[placeholder="Search repo / ref…"]');
            if (searchInput) {
              searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
              searchInput.focus();
            }
          }
        }, 50);
        return;
      }

      // ? (question mark): show shortcuts
      if (e.key === "?" && !e.shiftKey && !isMod && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        e.preventDefault();
        toast.info("Keyboard shortcuts", {
          description: "⌘+Enter → Focus form  ·  ⌘+K → Command palette  ·  Esc → Back  ·  ? → This help",
          duration: 4000,
        });
      }
    },
    [router]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
