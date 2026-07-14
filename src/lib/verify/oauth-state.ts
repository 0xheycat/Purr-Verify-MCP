import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";

export interface OAuthRefreshGrantRecord {
  credentialHash: string;
  familyId: string;
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
  createdAt: string;
  expiresAt: string;
  status: "active" | "rotated" | "revoked";
  rotatedAt?: string;
  revokedAt?: string;
  replacedByHash?: string;
}

interface ConsumedAuthorizationCodeRecord {
  codeHash: string;
  expiresAt: string;
  consumedAt: string;
}

interface OAuthStateFile {
  version: 1;
  consumedAuthorizationCodes: Record<string, ConsumedAuthorizationCodeRecord>;
  refreshGrants: Record<string, OAuthRefreshGrantRecord>;
}

interface OAuthStateGlobal {
  __purrOAuthStateGate?: Promise<void>;
}

const EMPTY_STATE: OAuthStateFile = {
  version: 1,
  consumedAuthorizationCodes: {},
  refreshGrants: {},
};

function oauthDir(): string {
  return path.join(getConfig().dataDir, "oauth");
}

function stateFile(): string {
  return path.join(oauthDir(), "state.json");
}

function valueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validState(value: unknown): value is OAuthStateFile {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OAuthStateFile>;
  return (
    state.version === 1 &&
    !!state.consumedAuthorizationCodes &&
    typeof state.consumedAuthorizationCodes === "object" &&
    !!state.refreshGrants &&
    typeof state.refreshGrants === "object"
  );
}

async function readState(): Promise<OAuthStateFile> {
  let raw: string;
  try {
    raw = await fs.readFile(stateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_STATE);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("OAuth state is corrupt and cannot be parsed");
  }
  if (!validState(parsed)) {
    throw new Error("OAuth state has an unsupported or invalid schema");
  }
  return parsed;
}

async function writeState(state: OAuthStateFile): Promise<void> {
  await fs.mkdir(oauthDir(), { recursive: true, mode: 0o700 });
  const target = stateFile();
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, target);
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const globalStore = globalThis as OAuthStateGlobal;
  const previous = globalStore.__purrOAuthStateGate ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalStore.__purrOAuthStateGate = previous.catch(() => undefined).then(() => gate);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function consumeAuthorizationCodeOnce(
  code: string,
  expiresAtSeconds: number
): Promise<boolean> {
  return serialized(async () => {
    const state = await readState();
    const codeHash = valueHash(code);
    if (state.consumedAuthorizationCodes[codeHash]) return false;
    state.consumedAuthorizationCodes[codeHash] = {
      codeHash,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      consumedAt: new Date().toISOString(),
    };
    await writeState(state);
    return true;
  });
}
