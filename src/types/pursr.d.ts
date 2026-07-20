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
    screenshot(sessionId: string, options?: Record<string, unknown>): Promise<{
      sessionId: string;
      out: string;
      url: string;
      data: string;
      mimeType: string;
    }>;
    inspect(sessionId: string, selector: string): Promise<Record<string, unknown>>;
    diagnostics(sessionId: string, options?: { clear?: boolean }): Record<string, unknown>;
    close(sessionId: string): Promise<Record<string, unknown>>;
    closeAll(): Promise<void>;
  }
}
