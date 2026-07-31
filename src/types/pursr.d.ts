declare module "pursr" {
  export const VERSION: string;
}

declare module "pursr/browser-discovery" {
  export interface PursrBrowserDiscovery {
    found: string[];
    preferred: string | null;
    candidates: string[];
    env: Record<string, boolean>;
  }

  export function discoverBrowsers(options?: Record<string, unknown>): PursrBrowserDiscovery;
}

declare module "pursr/session" {
  export class BrowserSessionManager {
    constructor(options?: {
      outputDir?: string;
      launchBrowser?: (options: Record<string, unknown>) => Promise<unknown>;
      connectBrowser?: (
        endpointURL: string,
        options: Record<string, unknown>,
      ) => Promise<unknown>;
    });
    open(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    list(): Array<Record<string, unknown>>;
    snapshot(sessionId: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    act(sessionId: string, actions: Array<Record<string, unknown>>): Promise<Record<string, unknown>>;
    screenshot(sessionId: string, options?: {
      out?: string;
      full?: boolean;
      selector?: string;
      timeoutMs?: number;
      strategy?: "auto" | "playwright" | "cdp" | "stitched";
      animations?: "auto" | "allow" | "disabled";
    }): Promise<{
      sessionId: string;
      out: string;
      url: string | null;
      data: string;
      mimeType: string;
      captureMode: string;
      fallbackUsed: boolean;
      elapsedMs: number;
      requestedTimeoutMs: number;
      attempts: Array<{
        strategy: string;
        status: string;
        durationMs: number;
        errorCode?: string;
        error?: string;
      }>;
      image: {
        width: number;
        height: number;
        bytes: number;
        mimeType: string;
      };
      fallbackError?: string;
    }>;
    inspect(sessionId: string, selector: string): Promise<Record<string, unknown>>;
    diagnostics(sessionId: string, options?: { clear?: boolean }): Record<string, unknown>;
    close(sessionId: string): Promise<Record<string, unknown>>;
    closeAll(): Promise<void>;
  }
}
