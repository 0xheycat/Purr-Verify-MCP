"use client";

// QR Code dialog for sharing a job's public URL via a scannable QR code.
// Useful for opening the share link on a mobile device quickly.

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Download, Loader2, QrCode } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface QrCodeDialogProps {
  url: string;
  label?: string;
  // Optional title for the QR code (e.g., the job short id).
  title?: string;
  // Render as a small icon-only button instead of a labeled button.
  iconOnly?: boolean;
  // Optional className override for the trigger button.
  triggerClassName?: string;
}

export function QrCodeDialog({
  url,
  label = "QR",
  title,
  iconOnly = false,
  triggerClassName,
}: QrCodeDialogProps) {
  const [open, setOpen] = useState(false);

  // Regenerate the QR code whenever the dialog opens (the URL may have
  // changed since the last open) or the URL itself changes. We track the
  // in-flight request via a ref so the effect body itself doesn't call
  // setState synchronously (which would trigger cascading renders).
  const [dataUrl, setDataUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !url) {
      return;
    }
    let cancelled = false;
    const generate = async () => {
      setLoading(true);
      setDataUrl("");
      try {
        const d = await QRCode.toDataURL(url, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 480,
          color: {
            dark: "#0f0f0f",
            light: "#ffffff",
          },
        });
        if (cancelled) return;
        setDataUrl(d);
      } catch (e) {
        if (cancelled) return;
        const errMsg = (e as Error)?.message || String(e);
        toast.error(`Failed to generate QR code: ${errMsg}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void generate();
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  const handleDownload = () => {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    const safeTitle = (title || "purr-verify-share").replace(/[^a-z0-9-]/gi, "_").slice(0, 60);
    a.download = `${safeTitle}-qr.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast.success("QR code downloaded");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {iconOnly ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={triggerClassName ?? "h-7 px-2 text-[11px]"}
            aria-label={`Show QR code for ${url}`}
            title="Show QR code"
          >
            <QrCode className="h-3 w-3" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={triggerClassName ?? "h-7 gap-1 px-2 text-[11px]"}
            aria-label={`Show QR code for ${url}`}
          >
            <QrCode className="h-3 w-3" />
            {label}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-4 w-4 text-amber-600" />
            Scan to view
          </DialogTitle>
          <DialogDescription>
            Open your phone camera and point it at the code to open the share link.
            {title && (
              <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                {title}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center justify-center gap-3 py-4">
          {loading ? (
            <div className="flex h-48 w-48 items-center justify-center rounded-xl border-2 border-dashed border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/20">
              <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
            </div>
          ) : dataUrl ? (
            <div className="relative rounded-xl border-2 border-amber-200 bg-white p-3 shadow-sm dark:border-amber-900 animate-scale-in">
              <img
                src={dataUrl}
                alt={`QR code for ${url}`}
                width={240}
                height={240}
                className="h-60 w-60"
              />
              {/* Subtle corner accents */}
              <span className="pointer-events-none absolute -left-1 -top-1 h-3 w-3 border-l-2 border-t-2 border-amber-500" />
              <span className="pointer-events-none absolute -right-1 -top-1 h-3 w-3 border-r-2 border-t-2 border-amber-500" />
              <span className="pointer-events-none absolute -left-1 -bottom-1 h-3 w-3 border-l-2 border-b-2 border-amber-500" />
              <span className="pointer-events-none absolute -right-1 -bottom-1 h-3 w-3 border-r-2 border-b-2 border-amber-500" />
            </div>
          ) : (
            <div className="flex h-48 w-48 items-center justify-center rounded-xl border-2 border-dashed border-rose-200 bg-rose-50/40 text-xs text-rose-600 dark:border-rose-900 dark:bg-rose-950/20">
              Could not generate QR
            </div>
          )}

          <div className="w-full break-all rounded-lg bg-muted/40 px-3 py-2 text-center font-mono text-[10px] text-muted-foreground">
            {url}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={handleDownload}
            disabled={!dataUrl || loading}
          >
            <Download className="h-3.5 w-3.5" />
            Download PNG
          </Button>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              if (!url) return;
              navigator.clipboard
                .writeText(url)
                .then(() => toast.success("Share URL copied"))
                .catch(() => toast.error("Could not copy URL"));
            }}
          >
            Copy URL
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
