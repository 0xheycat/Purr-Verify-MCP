"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  notificationsPermission,
  notificationsSupported,
  requestNotificationPermission,
} from "@/lib/verify/notifications";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function NotificationsToggle() {
  // Always start with the same SSR/CSR initial state to avoid hydration mismatch.
  // The real permission is read in useEffect after mount.
  const [mounted, setMounted] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    setPermission(notificationsPermission());
  }, []);

  // Render a stable placeholder on the server and during the first client render.
  // After mount, render the real button (only if browser supports notifications).
  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-hidden="true" tabIndex={-1}>
        <Bell className="h-4 w-4 opacity-0" />
      </Button>
    );
  }

  // After mount: if not supported, render nothing.
  if (!notificationsSupported()) return null;

  const enabled = permission === "granted";

  const handleClick = async () => {
    if (enabled) {
      // Already enabled — can't revoke programmatically; show instructions.
      toast.info("To disable notifications, revoke permission in your browser settings.");
      return;
    }
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      toast.success("Notifications enabled — you'll be alerted when jobs complete.");
      // Fire a test notification.
      try {
        const n = new Notification("🔔 Notifications on", {
          body: "Purr Verify MCP will alert you when jobs finish.",
          tag: "purr-verify-test",
        });
        setTimeout(() => n.close(), 4000);
      } catch {
        // ignore
      }
    } else if (result === "denied") {
      toast.error("Notifications were blocked. Update site permissions to enable.");
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleClick}
            aria-label={enabled ? "Notifications enabled" : "Enable notifications"}
          >
            {enabled ? (
              <BellRing className="h-4 w-4 text-emerald-500" />
            ) : permission === "denied" ? (
              <BellOff className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            {enabled && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {enabled
            ? "Notifications enabled"
            : permission === "denied"
            ? "Notifications blocked (update in browser settings)"
            : "Enable desktop notifications"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
