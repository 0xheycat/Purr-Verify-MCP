import { createHash, randomBytes, randomUUID } from "node:crypto";
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

export interface OAuthRefreshTokenRecord {
  tokenHash: string;
  familyId: string;
  parentHash?: string;
  clientId: string;
  scope: string;
  resource: string;
  subject: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

interface OAuthStateFile {
  version: 1;
  clients: Record<string, OAuthClientRecord>;
  authorizationCodes: Record<string, OAuthAuthorizationCodeRecord>;
  refreshTokens: Record<string, OAuthRefreshTokenRecord>;
  revokedFamilies: Record<string, string>;
}

interface OAuthStoreGlobal {
  __purrOAuthStoreGate?: Promise<void>;
}

const EMPTY_STATE: OAuthStateFile = {
  version: 1,
  clients: {},
  authorizationCodes: {},
  refreshTokens: {},
  revokedFamilies: {},
};

function oauthDir(): string {
  return path.join(getConfig().dataDir, "oauth");
}

function stateFile(): string {
  return path.join(oauthDir(), "state.json");
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newOpaqueToken(bytes = 32): string {
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
    typeof state.authorizationCodes === "object" &&
    !!state.refreshTokens &&
    typeof state.refreshTokens === "object" &&
    !!state.revokedFamilies &&
    typeof state.revokedFamilies === "object"
  );
}

async function readState(): Promise<OAuthStateFile> {
  try {
    const raw = await fs.readFile(stateFile(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (validState(parsed)) return parsed;
  } catch {
    // Missing or corrupt state fails closed for existing credentials and starts
    // with an empty registry. The write path remains atomic.
  }
  return structuredClone(EMPTY_STATE);
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
  const codeRetentionMs = 24 * 60 * 60 * 1000;
  const refreshRetentionMs = 7 * 24 * 60 * 60 * 1000;

  for (const [hash, code] of Object.entries(state.authorizationCodes)) {
    const expiredAt = new Date(code.expiresAt).getTime();
    const consumedAt = code.consumedAt ? new Date(code.consumedAt).getTime() : 0;
    if (expiredAt + codeRetentionMs < nowMs || (consumedAt && consumedAt + codeRetentionMs < nowMs)) {
      delete state.authorizationCodes[hash];
    }
  }

  for (const [hash, token] of Object.entries(state.refreshTokens)) {
    const expiredAt = new Date(token.expiresAt).getTime();
    const terminalAt = token.revokedAt
      ? new Date(token.revokedAt).getTime()
      : token.consumedAt
        ? new Date(token.consumedAt).getTime()
        : 0;
    if (expiredAt + refreshRetentionMs < nowMs || (terminalAt && terminalAt + refreshRetentionMs < nowMs)) {
      delete state.refreshTokens[hash];
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
  globalStore.__purrOAuthStoreGate = previous.catch(() => undefined).then(() => gate);
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
      clientId: `purr_${newOpaqueToken(24)}`,
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

export async function getOAuthClient(clientId: string): Promise<OAuthClientRecord | null> {
  const state = await readState();
  return state.clients[clientId] ?? null;
}

export async function createAuthorizationCode(input: Omit<OAuthAuthorizationCodeRecord, "codeHash" | "createdAt" | "consumedAt">): Promise<string> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const code = newOpaqueToken(32);
    const hash = tokenHash(code);
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
  | { ok: false; reason: "invalid" | "expired" | "replayed" | "mismatch"; description?: string };

export async function consumeAuthorizationCode(
  code: string,
  validate: (record: OAuthAuthorizationCodeRecord) => string | null
): Promise<ConsumeCodeResult> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const hash = tokenHash(code);
    const record = state.authorizationCodes[hash];
    if (!record) return { ok: false, reason: "invalid" };
    if (record.consumedAt) return { ok: false, reason: "replayed" };
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      return { ok: false, reason: "expired" };
    }
    const mismatch = validate(record);
    if (mismatch) return { ok: false, reason: "mismatch", description: mismatch };
    record.consumedAt = new Date().toISOString();
    state.authorizationCodes[hash] = record;
    await writeState(state);
    return { ok: true, record };
  });
}

export async function createRefreshToken(input: {
  clientId: string;
  scope: string;
  resource: string;
  subject: string;
  expiresAt: string;
}): Promise<{ token: string; record: OAuthRefreshTokenRecord }> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const token = newOpaqueToken(48);
    const hash = tokenHash(token);
    const record: OAuthRefreshTokenRecord = {
      tokenHash: hash,
      familyId: randomUUID(),
      clientId: input.clientId,
      scope: input.scope,
      resource: input.resource,
      subject: input.subject,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    };
    state.refreshTokens[hash] = record;
    await writeState(state);
    return { token, record };
  });
}

export type RotateRefreshResult =
  | { ok: true; token: string; record: OAuthRefreshTokenRecord; previous: OAuthRefreshTokenRecord }
  | { ok: false; reason: "invalid" | "expired" | "replayed" | "revoked" | "mismatch"; description?: string };

export async function rotateRefreshToken(
  rawToken: string,
  expiresAt: string,
  validate: (record: OAuthRefreshTokenRecord) => string | null
): Promise<RotateRefreshResult> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const hash = tokenHash(rawToken);
    const current = state.refreshTokens[hash];
    if (!current) return { ok: false, reason: "invalid" };

    if (state.revokedFamilies[current.familyId] || current.revokedAt) {
      return { ok: false, reason: "revoked" };
    }

    if (current.consumedAt) {
      const revokedAt = new Date().toISOString();
      state.revokedFamilies[current.familyId] = revokedAt;
      for (const token of Object.values(state.refreshTokens)) {
        if (token.familyId === current.familyId && !token.revokedAt) token.revokedAt = revokedAt;
      }
      await writeState(state);
      return { ok: false, reason: "replayed" };
    }

    if (new Date(current.expiresAt).getTime() <= Date.now()) {
      return { ok: false, reason: "expired" };
    }

    const mismatch = validate(current);
    if (mismatch) return { ok: false, reason: "mismatch", description: mismatch };

    current.consumedAt = new Date().toISOString();
    state.refreshTokens[hash] = current;

    const token = newOpaqueToken(48);
    const nextHash = tokenHash(token);
    const next: OAuthRefreshTokenRecord = {
      tokenHash: nextHash,
      familyId: current.familyId,
      parentHash: hash,
      clientId: current.clientId,
      scope: current.scope,
      resource: current.resource,
      subject: current.subject,
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    state.refreshTokens[nextHash] = next;
    await writeState(state);
    return { ok: true, token, record: next, previous: current };
  });
}

export async function isRefreshFamilyRevoked(familyId: string): Promise<boolean> {
  const state = await readState();
  return Boolean(state.revokedFamilies[familyId]);
}

export async function resetOAuthStoreForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only OAuth reset");
  await serialized(async () => {
    await fs.rm(oauthDir(), { recursive: true, force: true });
  });
}
