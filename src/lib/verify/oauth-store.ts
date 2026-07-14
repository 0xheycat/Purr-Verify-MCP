import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";

export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  clientName?: string;
  clientUri?: string;
  createdAt: string;
}

export interface OAuthAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  subject: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

interface OAuthStateFile {
  version: 1;
  clients: Record<string, OAuthClientRecord>;
  authorizationCodes: Record<string, OAuthAuthorizationCodeRecord>;
}

interface OAuthStoreGlobal {
  __purrOAuthStoreGate?: Promise<void>;
}

const EMPTY_STATE: OAuthStateFile = {
  version: 1,
  clients: {},
  authorizationCodes: {},
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

function newOpaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function validState(value: unknown): value is OAuthStateFile {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OAuthStateFile>;
  return (
    state.version === 1 &&
    !!state.clients &&
    typeof state.clients === "object" &&
    !!state.authorizationCodes &&
    typeof state.authorizationCodes === "object"
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

function cleanupState(state: OAuthStateFile, nowMs = Date.now()): void {
  const retentionMs = 24 * 60 * 60 * 1000;
  for (const [hash, code] of Object.entries(state.authorizationCodes)) {
    const expiredAt = new Date(code.expiresAt).getTime();
    const consumedAt = code.consumedAt
      ? new Date(code.consumedAt).getTime()
      : 0;
    if (
      expiredAt + retentionMs < nowMs ||
      (consumedAt && consumedAt + retentionMs < nowMs)
    ) {
      delete state.authorizationCodes[hash];
    }
  }
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const globalStore = globalThis as OAuthStoreGlobal;
  const previous = globalStore.__purrOAuthStoreGate ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalStore.__purrOAuthStoreGate = previous
    .catch(() => undefined)
    .then(() => gate);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function registerOAuthClient(input: {
  redirectUris: string[];
  clientName?: string;
  clientUri?: string;
}): Promise<OAuthClientRecord> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const client: OAuthClientRecord = {
      clientId: `purr_${newOpaqueValue(24)}`,
      redirectUris: [...new Set(input.redirectUris)],
      tokenEndpointAuthMethod: "none",
      clientName: input.clientName,
      clientUri: input.clientUri,
      createdAt: new Date().toISOString(),
    };
    state.clients[client.clientId] = client;
    await writeState(state);
    return client;
  });
}

export async function getOAuthClient(
  clientId: string
): Promise<OAuthClientRecord | null> {
  const state = await readState();
  return state.clients[clientId] ?? null;
}

export async function createAuthorizationCode(
  input: Omit<
    OAuthAuthorizationCodeRecord,
    "codeHash" | "createdAt" | "consumedAt"
  >
): Promise<string> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const code = newOpaqueValue(32);
    const hash = valueHash(code);
    state.authorizationCodes[hash] = {
      ...input,
      codeHash: hash,
      createdAt: new Date().toISOString(),
    };
    await writeState(state);
    return code;
  });
}

export type ConsumeCodeResult =
  | { ok: true; record: OAuthAuthorizationCodeRecord }
  | {
      ok: false;
      reason: "invalid" | "expired" | "replayed" | "mismatch";
      description?: string;
    };

export async function consumeAuthorizationCode(
  code: string,
  validate: (record: OAuthAuthorizationCodeRecord) => string | null
): Promise<ConsumeCodeResult> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const hash = valueHash(code);
    const record = state.authorizationCodes[hash];
    if (!record) return { ok: false, reason: "invalid" };
    if (record.consumedAt) return { ok: false, reason: "replayed" };
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      return { ok: false, reason: "expired" };
    }
    const mismatch = validate(record);
    if (mismatch) {
      return { ok: false, reason: "mismatch", description: mismatch };
    }

    record.consumedAt = new Date().toISOString();
    state.authorizationCodes[hash] = record;
    await writeState(state);
    return { ok: true, record };
  });
}

export async function resetOAuthStoreForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test-only OAuth reset");
  }
  await serialized(async () => {
    await fs.rm(oauthDir(), { recursive: true, force: true });
  });
}
