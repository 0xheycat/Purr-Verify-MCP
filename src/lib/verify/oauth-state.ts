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

interface IssueRefreshCredentialInput {
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
  expiresAtSeconds: number;
  familyId?: string;
}

interface ConsumeCodeAndIssueRefreshCredentialInput {
  code: string;
  codeExpiresAtSeconds: number;
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
  refreshExpiresAtSeconds: number;
}

interface RotateRefreshCredentialInput {
  credential: string;
  clientId: string;
  resource?: string;
  requestedScope?: string;
  expiresAtSeconds: number;
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

type ConsumeCodeAndIssueRefreshCredentialResult =
  | { ok: true; credential: string; record: OAuthRefreshGrantRecord }
  | { ok: false; reason: "replayed" };

interface OAuthStateStore {
  consumeAuthorizationCodeOnce(
    code: string,
    expiresAtSeconds: number
  ): Promise<boolean>;
  issueRefreshCredential(
    input: IssueRefreshCredentialInput
  ): Promise<{ credential: string; record: OAuthRefreshGrantRecord }>;
  consumeCodeAndIssueRefreshCredential(
    input: ConsumeCodeAndIssueRefreshCredentialInput
  ): Promise<ConsumeCodeAndIssueRefreshCredentialResult>;
  rotateRefreshCredential(
    input: RotateRefreshCredentialInput
  ): Promise<RotateRefreshCredentialResult>;
  revokeRefreshCredentialFamily(credential: string): Promise<void>;
  resetForTests(): Promise<void>;
}

interface PrismaOAuthAuthorizationCodeDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  deleteMany(args?: Record<string, unknown>): Promise<unknown>;
}

interface PrismaOAuthRefreshGrantRow {
  credentialHash: string;
  familyId: string;
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  replacedByHash: string | null;
  version: number;
}

interface PrismaOAuthRefreshGrantDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findUnique(args: {
    where: { credentialHash: string };
  }): Promise<PrismaOAuthRefreshGrantRow | null>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  deleteMany(args?: Record<string, unknown>): Promise<unknown>;
}

interface OAuthPrismaClient {
  oAuthAuthorizationCode: PrismaOAuthAuthorizationCodeDelegate;
  oAuthRefreshGrant: PrismaOAuthRefreshGrantDelegate;
  $transaction<T>(operation: (tx: OAuthPrismaClient) => Promise<T>): Promise<T>;
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

function newRefreshCredential(): string {
  return randomBytes(32).toString("base64url");
}

function newRefreshFamilyId(): string {
  return randomBytes(16).toString("base64url");
}

function refreshGrantRecord(input: {
  credentialHash: string;
  familyId: string;
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
  expiresAtSeconds: number;
  createdAtIso?: string;
}): OAuthRefreshGrantRecord {
  return {
    credentialHash: input.credentialHash,
    familyId: input.familyId,
    clientId: input.clientId,
    subject: input.subject,
    scope: input.scope,
    resource: input.resource,
    createdAt: input.createdAtIso || new Date().toISOString(),
    expiresAt: new Date(input.expiresAtSeconds * 1000).toISOString(),
    status: "active",
  };
}

function narrowScope(
  grantedScope: string,
  requestedScope?: string
): { ok: true; scope: string } | { ok: false } {
  if (!requestedScope) return { ok: true, scope: grantedScope };
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
  const requested = [...new Set(requestedScope.split(/\s+/).filter(Boolean))];
  if (
    requested.length === 0 ||
    requested.some((scope) => !granted.has(scope))
  ) {
    return { ok: false };
  }
  return { ok: true, scope: requested.join(" ") };
}

function invalidScopeResult(): RotateRefreshCredentialResult {
  return {
    ok: false,
    reason: "invalid_scope",
    description: "Requested scope exceeds the original refresh grant",
  };
}

function replayResult(): RotateRefreshCredentialResult {
  return {
    ok: false,
    reason: "replayed",
    description:
      "Refresh credential replay detected; the credential family has been revoked",
  };
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
  globalStore.__purrOAuthStateGate = previous
    .catch(() => undefined)
    .then(() => gate);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function revokeJsonFamily(
  state: OAuthStateFile,
  familyId: string,
  now: string
): void {
  for (const grant of Object.values(state.refreshGrants)) {
    if (grant.familyId !== familyId) continue;
    grant.status = "revoked";
    grant.revokedAt = grant.revokedAt || now;
  }
}

class JsonOAuthStateStore implements OAuthStateStore {
  async consumeAuthorizationCodeOnce(
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

  async issueRefreshCredential(
    input: IssueRefreshCredentialInput
  ): Promise<{ credential: string; record: OAuthRefreshGrantRecord }> {
    return serialized(async () => {
      const state = await readState();
      cleanupState(state);
      const credential = newRefreshCredential();
      const record = refreshGrantRecord({
        credentialHash: valueHash(credential),
        familyId: input.familyId || newRefreshFamilyId(),
        clientId: input.clientId,
        subject: input.subject,
        scope: input.scope,
        resource: input.resource,
        expiresAtSeconds: input.expiresAtSeconds,
      });
      state.refreshGrants[record.credentialHash] = record;
      await writeState(state);
      return { credential, record };
    });
  }

  async consumeCodeAndIssueRefreshCredential(
    input: ConsumeCodeAndIssueRefreshCredentialInput
  ): Promise<ConsumeCodeAndIssueRefreshCredentialResult> {
    return serialized(async () => {
      const state = await readState();
      cleanupState(state);
      const codeHash = valueHash(input.code);
      if (state.consumedAuthorizationCodes[codeHash]) {
        return { ok: false, reason: "replayed" };
      }

      const nowIso = new Date().toISOString();
      const credential = newRefreshCredential();
      const record = refreshGrantRecord({
        credentialHash: valueHash(credential),
        familyId: newRefreshFamilyId(),
        clientId: input.clientId,
        subject: input.subject,
        scope: input.scope,
        resource: input.resource,
        expiresAtSeconds: input.refreshExpiresAtSeconds,
        createdAtIso: nowIso,
      });
      state.consumedAuthorizationCodes[codeHash] = {
        codeHash,
        expiresAt: new Date(input.codeExpiresAtSeconds * 1000).toISOString(),
        consumedAt: nowIso,
      };
      state.refreshGrants[record.credentialHash] = record;
      await writeState(state);
      return { ok: true, credential, record };
    });
  }

  async rotateRefreshCredential(
    input: RotateRefreshCredentialInput
  ): Promise<RotateRefreshCredentialResult> {
    return serialized(async () => {
      const state = await readState();
      cleanupState(state);
      const credentialHash = valueHash(input.credential);
      const current = state.refreshGrants[credentialHash];
      if (!current) return { ok: false, reason: "invalid" };

      const now = new Date();
      const nowIso = now.toISOString();
      if (new Date(current.expiresAt).getTime() <= now.getTime()) {
        revokeJsonFamily(state, current.familyId, nowIso);
        await writeState(state);
        return { ok: false, reason: "expired" };
      }
      if (current.status === "rotated") {
        revokeJsonFamily(state, current.familyId, nowIso);
        await writeState(state);
        return replayResult();
      }
      if (current.status === "revoked") {
        return { ok: false, reason: "revoked" };
      }
      if (
        current.clientId !== input.clientId ||
        (input.resource !== undefined && current.resource !== input.resource)
      ) {
        return {
          ok: false,
          reason: "mismatch",
          description: "Refresh credential client or resource mismatch",
        };
      }

      const narrowed = narrowScope(current.scope, input.requestedScope);
      if (!narrowed.ok) return invalidScopeResult();

      const nextCredential = newRefreshCredential();
      const nextRecord = refreshGrantRecord({
        credentialHash: valueHash(nextCredential),
        familyId: current.familyId,
        clientId: current.clientId,
        subject: current.subject,
        scope: narrowed.scope,
        resource: current.resource,
        expiresAtSeconds: input.expiresAtSeconds,
        createdAtIso: nowIso,
      });
      current.status = "rotated";
      current.rotatedAt = nowIso;
      current.replacedByHash = nextRecord.credentialHash;
      state.refreshGrants[credentialHash] = current;
      state.refreshGrants[nextRecord.credentialHash] = nextRecord;
      await writeState(state);
      return { ok: true, credential: nextCredential, record: nextRecord };
    });
  }

  async revokeRefreshCredentialFamily(credential: string): Promise<void> {
    await serialized(async () => {
      const state = await readState();
      cleanupState(state);
      const current = state.refreshGrants[valueHash(credential)];
      if (!current) return;
      revokeJsonFamily(state, current.familyId, new Date().toISOString());
      await writeState(state);
    });
  }

  async resetForTests(): Promise<void> {
    await serialized(async () => {
      await fs.rm(oauthDir(), { recursive: true, force: true });
    });
  }
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

async function prismaClient(): Promise<OAuthPrismaClient> {
  const { db } = await import("../db");
  return db as unknown as OAuthPrismaClient;
}

function recordFromPrismaRow(
  row: PrismaOAuthRefreshGrantRow
): OAuthRefreshGrantRecord {
  const status: OAuthRefreshGrantRecord["status"] =
    row.status === "rotated" || row.status === "revoked"
      ? row.status
      : "active";
  return {
    credentialHash: row.credentialHash,
    familyId: row.familyId,
    clientId: row.clientId,
    subject: row.subject,
    scope: row.scope,
    resource: row.resource,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status,
    rotatedAt: row.rotatedAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    replacedByHash: row.replacedByHash || undefined,
  };
}

function prismaRefreshGrantData(record: OAuthRefreshGrantRecord): Record<string, unknown> {
  return {
    credentialHash: record.credentialHash,
    familyId: record.familyId,
    clientId: record.clientId,
    subject: record.subject,
    scope: record.scope,
    resource: record.resource,
    status: record.status,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
    rotatedAt: record.rotatedAt ? new Date(record.rotatedAt) : null,
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
    replacedByHash: record.replacedByHash || null,
  };
}

async function cleanupPrismaState(
  tx: OAuthPrismaClient,
  nowMs = Date.now()
): Promise<void> {
  const codeCutoff = new Date(nowMs - 24 * 60 * 60 * 1000);
  const refreshCutoff = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
  await tx.oAuthAuthorizationCode.deleteMany({
    where: { expiresAt: { lt: codeCutoff } },
  });
  await tx.oAuthRefreshGrant.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: refreshCutoff } },
        { rotatedAt: { lt: refreshCutoff } },
        { revokedAt: { lt: refreshCutoff } },
      ],
    },
  });
}

async function revokePrismaFamily(
  tx: OAuthPrismaClient,
  familyId: string,
  now: Date
): Promise<void> {
  await tx.oAuthRefreshGrant.updateMany({
    where: { familyId },
    data: {
      status: "revoked",
      revokedAt: now,
      version: { increment: 1 },
    },
  });
}

class PrismaOAuthStateStore implements OAuthStateStore {
  async consumeAuthorizationCodeOnce(
    code: string,
    expiresAtSeconds: number
  ): Promise<boolean> {
    const prisma = await prismaClient();
    try {
      return await prisma.$transaction(async (tx) => {
        await cleanupPrismaState(tx);
        const now = new Date();
        await tx.oAuthAuthorizationCode.create({
          data: {
            codeHash: valueHash(code),
            clientId: "",
            subject: "",
            scope: "",
            resource: "",
            expiresAt: new Date(expiresAtSeconds * 1000),
            consumedAt: now,
          },
        });
        return true;
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async issueRefreshCredential(
    input: IssueRefreshCredentialInput
  ): Promise<{ credential: string; record: OAuthRefreshGrantRecord }> {
    const prisma = await prismaClient();
    return prisma.$transaction(async (tx) => {
      await cleanupPrismaState(tx);
      const credential = newRefreshCredential();
      const record = refreshGrantRecord({
        credentialHash: valueHash(credential),
        familyId: input.familyId || newRefreshFamilyId(),
        clientId: input.clientId,
        subject: input.subject,
        scope: input.scope,
        resource: input.resource,
        expiresAtSeconds: input.expiresAtSeconds,
      });
      await tx.oAuthRefreshGrant.create({
        data: prismaRefreshGrantData(record),
      });
      return { credential, record };
    });
  }

  async consumeCodeAndIssueRefreshCredential(
    input: ConsumeCodeAndIssueRefreshCredentialInput
  ): Promise<ConsumeCodeAndIssueRefreshCredentialResult> {
    const prisma = await prismaClient();
    try {
      return await prisma.$transaction(async (tx) => {
        await cleanupPrismaState(tx);
        const now = new Date();
        const credential = newRefreshCredential();
        const record = refreshGrantRecord({
          credentialHash: valueHash(credential),
          familyId: newRefreshFamilyId(),
          clientId: input.clientId,
          subject: input.subject,
          scope: input.scope,
          resource: input.resource,
          expiresAtSeconds: input.refreshExpiresAtSeconds,
          createdAtIso: now.toISOString(),
        });
        await tx.oAuthAuthorizationCode.create({
          data: {
            codeHash: valueHash(input.code),
            clientId: input.clientId,
            subject: input.subject,
            scope: input.scope,
            resource: input.resource,
            expiresAt: new Date(input.codeExpiresAtSeconds * 1000),
            consumedAt: now,
          },
        });
        await tx.oAuthRefreshGrant.create({
          data: prismaRefreshGrantData(record),
        });
        return { ok: true, credential, record };
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        return { ok: false, reason: "replayed" };
      }
      throw error;
    }
  }

  async rotateRefreshCredential(
    input: RotateRefreshCredentialInput
  ): Promise<RotateRefreshCredentialResult> {
    const prisma = await prismaClient();
    return prisma.$transaction(async (tx) => {
      await cleanupPrismaState(tx);
      const credentialHash = valueHash(input.credential);
      const currentRow = await tx.oAuthRefreshGrant.findUnique({
        where: { credentialHash },
      });
      if (!currentRow) return { ok: false, reason: "invalid" };

      const current = recordFromPrismaRow(currentRow);
      const now = new Date();
      if (currentRow.expiresAt.getTime() <= now.getTime()) {
        await revokePrismaFamily(tx, current.familyId, now);
        return { ok: false, reason: "expired" };
      }
      if (current.status === "rotated") {
        await revokePrismaFamily(tx, current.familyId, now);
        return replayResult();
      }
      if (current.status === "revoked") {
        return { ok: false, reason: "revoked" };
      }
      if (
        current.clientId !== input.clientId ||
        (input.resource !== undefined && current.resource !== input.resource)
      ) {
        return {
          ok: false,
          reason: "mismatch",
          description: "Refresh credential client or resource mismatch",
        };
      }

      const narrowed = narrowScope(current.scope, input.requestedScope);
      if (!narrowed.ok) return invalidScopeResult();

      const nextCredential = newRefreshCredential();
      const nextRecord = refreshGrantRecord({
        credentialHash: valueHash(nextCredential),
        familyId: current.familyId,
        clientId: current.clientId,
        subject: current.subject,
        scope: narrowed.scope,
        resource: current.resource,
        expiresAtSeconds: input.expiresAtSeconds,
        createdAtIso: now.toISOString(),
      });

      const rotated = await tx.oAuthRefreshGrant.updateMany({
        where: {
          credentialHash,
          status: "active",
          version: currentRow.version,
        },
        data: {
          status: "rotated",
          rotatedAt: now,
          replacedByHash: nextRecord.credentialHash,
          version: { increment: 1 },
        },
      });
      if (rotated.count !== 1) {
        await revokePrismaFamily(tx, current.familyId, now);
        return replayResult();
      }

      await tx.oAuthRefreshGrant.create({
        data: prismaRefreshGrantData(nextRecord),
      });
      return { ok: true, credential: nextCredential, record: nextRecord };
    });
  }

  async revokeRefreshCredentialFamily(credential: string): Promise<void> {
    const prisma = await prismaClient();
    await prisma.$transaction(async (tx) => {
      await cleanupPrismaState(tx);
      const current = await tx.oAuthRefreshGrant.findUnique({
        where: { credentialHash: valueHash(credential) },
      });
      if (!current) return;
      await revokePrismaFamily(tx, current.familyId, new Date());
    });
  }

  async resetForTests(): Promise<void> {
    const prisma = await prismaClient();
    await prisma.$transaction(async (tx) => {
      await tx.oAuthAuthorizationCode.deleteMany();
      await tx.oAuthRefreshGrant.deleteMany();
    });
  }
}

function oauthStateStore(): OAuthStateStore {
  return getConfig().oauthStorageMode === "prisma"
    ? new PrismaOAuthStateStore()
    : new JsonOAuthStateStore();
}

export async function consumeAuthorizationCodeOnce(
  code: string,
  expiresAtSeconds: number
): Promise<boolean> {
  return oauthStateStore().consumeAuthorizationCodeOnce(code, expiresAtSeconds);
}

export async function issueRefreshCredential(
  input: IssueRefreshCredentialInput
): Promise<{ credential: string; record: OAuthRefreshGrantRecord }> {
  return oauthStateStore().issueRefreshCredential(input);
}

export async function consumeCodeAndIssueRefreshCredential(
  input: ConsumeCodeAndIssueRefreshCredentialInput
): Promise<ConsumeCodeAndIssueRefreshCredentialResult> {
  return oauthStateStore().consumeCodeAndIssueRefreshCredential(input);
}

export async function rotateRefreshCredential(
  input: RotateRefreshCredentialInput
): Promise<RotateRefreshCredentialResult> {
  return oauthStateStore().rotateRefreshCredential(input);
}

export async function revokeRefreshCredentialFamily(
  credential: string
): Promise<void> {
  await oauthStateStore().revokeRefreshCredentialFamily(credential);
}

export async function resetOAuthStateForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test-only OAuth state reset");
  }
  await oauthStateStore().resetForTests();
}