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

function cleanupState(state: OAuthStateFile, nowMs = Date.now()): void {
  const replayRetentionMs = 24 * 60 * 60 * 1000;
  for (const [hash, code] of Object.entries(state.consumedAuthorizationCodes)) {
    if (new Date(code.expiresAt).getTime() + replayRetentionMs < nowMs) {
      delete state.consumedAuthorizationCodes[hash];
    }
  }

  const refreshRetentionMs = 7 * 24 * 60 * 60 * 1000;
  for (const [hash, grant] of Object.entries(state.refreshGrants)) {
    const expiresAt = new Date(grant.expiresAt).getTime();
    const terminalAt = grant.revokedAt
      ? new Date(grant.revokedAt).getTime()
      : grant.rotatedAt
        ? new Date(grant.rotatedAt).getTime()
        : 0;
    if (
      expiresAt + refreshRetentionMs < nowMs ||
      (terminalAt > 0 && terminalAt + refreshRetentionMs < nowMs)
    ) {
      delete state.refreshGrants[hash];
    }
  }
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

function revokeFamily(state: OAuthStateFile, familyId: string, now: string): void {
  for (const grant of Object.values(state.refreshGrants)) {
    if (grant.familyId !== familyId) continue;
    grant.status = "revoked";
    grant.revokedAt = grant.revokedAt || now;
  }
}

export async function consumeAuthorizationCodeOnce(
  code: string,
  expiresAtSeconds: number
): Promise<boolean> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
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

export async function issueRefreshCredential(input: {
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
  expiresAtSeconds: number;
  familyId?: string;
}): Promise<{ credential: string; record: OAuthRefreshGrantRecord }> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const credential = randomBytes(32).toString("base64url");
    const credentialHash = valueHash(credential);
    const record: OAuthRefreshGrantRecord = {
      credentialHash,
      familyId: input.familyId || randomBytes(16).toString("base64url"),
      clientId: input.clientId,
      subject: input.subject,
      scope: input.scope,
      resource: input.resource,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(input.expiresAtSeconds * 1000).toISOString(),
      status: "active",
    };
    state.refreshGrants[credentialHash] = record;
    await writeState(state);
    return { credential, record };
  });
}

export type RotateRefreshCredentialResult =
  | { ok: true; credential: string; record: OAuthRefreshGrantRecord }
  | {
      ok: false;
      reason:
        | "invalid"
        | "expired"
        | "replayed"
        | "revoked"
        | "mismatch"
        | "invalid_scope";
      description?: string;
    };

export async function rotateRefreshCredential(input: {
  credential: string;
  clientId: string;
  resource: string;
  requestedScope?: string;
  expiresAtSeconds: number;
}): Promise<RotateRefreshCredentialResult> {
  return serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const credentialHash = valueHash(input.credential);
    const current = state.refreshGrants[credentialHash];
    if (!current) return { ok: false, reason: "invalid" };

    const now = new Date();
    const nowIso = now.toISOString();
    if (new Date(current.expiresAt).getTime() <= now.getTime()) {
      revokeFamily(state, current.familyId, nowIso);
      await writeState(state);
      return { ok: false, reason: "expired" };
    }
    if (current.status === "rotated") {
      revokeFamily(state, current.familyId, nowIso);
      await writeState(state);
      return {
        ok: false,
        reason: "replayed",
        description: "Refresh credential replay detected; the credential family has been revoked",
      };
    }
    if (current.status === "revoked") {
      return { ok: false, reason: "revoked" };
    }
    if (current.clientId !== input.clientId || current.resource !== input.resource) {
      return {
        ok: false,
        reason: "mismatch",
        description: "Refresh credential client or resource mismatch",
      };
    }

    let nextScope = current.scope;
    if (input.requestedScope) {
      const granted = new Set(current.scope.split(/\s+/).filter(Boolean));
      const requested = [
        ...new Set(input.requestedScope.split(/\s+/).filter(Boolean)),
      ];
      if (
        requested.length === 0 ||
        requested.some((scope) => !granted.has(scope))
      ) {
        return {
          ok: false,
          reason: "invalid_scope",
          description: "Requested scope exceeds the original refresh grant",
        };
      }
      nextScope = requested.join(" ");
    }

    const nextCredential = randomBytes(32).toString("base64url");
    const nextHash = valueHash(nextCredential);
    const nextRecord: OAuthRefreshGrantRecord = {
      credentialHash: nextHash,
      familyId: current.familyId,
      clientId: current.clientId,
      subject: current.subject,
      scope: nextScope,
      resource: current.resource,
      createdAt: nowIso,
      expiresAt: new Date(input.expiresAtSeconds * 1000).toISOString(),
      status: "active",
    };
    current.status = "rotated";
    current.rotatedAt = nowIso;
    current.replacedByHash = nextHash;
    state.refreshGrants[credentialHash] = current;
    state.refreshGrants[nextHash] = nextRecord;
    await writeState(state);
    return { ok: true, credential: nextCredential, record: nextRecord };
  });
}

export async function revokeRefreshCredentialFamily(
  credential: string
): Promise<void> {
  await serialized(async () => {
    const state = await readState();
    cleanupState(state);
    const current = state.refreshGrants[valueHash(credential)];
    if (!current) return;
    revokeFamily(state, current.familyId, new Date().toISOString());
    await writeState(state);
  });
}

export async function resetOAuthStateForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test-only OAuth state reset");
  }
  await serialized(async () => {
    await fs.rm(oauthDir(), { recursive: true, force: true });
  });
}
