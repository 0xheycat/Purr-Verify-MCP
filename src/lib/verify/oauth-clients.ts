import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "./config";

export interface OAuthDynamicClientRecord {
  clientId: string;
  redirectUris: string[];
  createdAt: string;
}

interface OAuthDynamicClientFile {
  version: 1;
  clients: Record<string, OAuthDynamicClientRecord>;
}

interface OAuthDynamicClientGlobal {
  __purrOAuthDynamicClientGate?: Promise<void>;
}

interface PrismaOAuthDynamicClientRow {
  clientId: string;
  redirectUrisJson: string;
  createdAt: Date;
  revokedAt: Date | null;
}

interface PrismaOAuthDynamicClientDelegate {
  findUnique(args: {
    where: { clientId: string };
  }): Promise<PrismaOAuthDynamicClientRow | null>;
  upsert(args: {
    where: { clientId: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
  deleteMany(args?: Record<string, unknown>): Promise<unknown>;
}

interface OAuthDynamicClientPrisma {
  oAuthDynamicClient: PrismaOAuthDynamicClientDelegate;
}

const EMPTY_FILE: OAuthDynamicClientFile = {
  version: 1,
  clients: {},
};

function oauthDir(): string {
  return path.join(getConfig().dataDir, "oauth");
}

function clientFile(): string {
  return path.join(oauthDir(), "clients.json");
}

function normalizeRedirectUris(redirectUris: string[]): string[] {
  return [...new Set(redirectUris.map((uri) => uri.trim()).filter(Boolean))];
}

function validRecord(value: unknown): value is OAuthDynamicClientRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OAuthDynamicClientRecord>;
  return (
    typeof record.clientId === "string" &&
    Array.isArray(record.redirectUris) &&
    record.redirectUris.every((uri) => typeof uri === "string") &&
    typeof record.createdAt === "string"
  );
}

async function readClientFile(): Promise<OAuthDynamicClientFile> {
  let raw: string;
  try {
    raw = await fs.readFile(clientFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_FILE);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("OAuth dynamic-client state is corrupt and cannot be parsed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("OAuth dynamic-client state has an invalid schema");
  }
  const state = parsed as Partial<OAuthDynamicClientFile>;
  if (
    state.version !== 1 ||
    !state.clients ||
    typeof state.clients !== "object" ||
    !Object.values(state.clients).every(validRecord)
  ) {
    throw new Error("OAuth dynamic-client state has an invalid schema");
  }
  return state as OAuthDynamicClientFile;
}

async function writeClientFile(state: OAuthDynamicClientFile): Promise<void> {
  await fs.mkdir(oauthDir(), { recursive: true, mode: 0o700 });
  const target = clientFile();
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temp, target);
}

async function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const globalStore = globalThis as OAuthDynamicClientGlobal;
  const previous =
    globalStore.__purrOAuthDynamicClientGate ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalStore.__purrOAuthDynamicClientGate = previous
    .catch(() => undefined)
    .then(() => gate);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function prismaClient(): Promise<OAuthDynamicClientPrisma> {
  const { db } = await import("../db");
  return db as unknown as OAuthDynamicClientPrisma;
}

function recordFromPrismaRow(
  row: PrismaOAuthDynamicClientRow
): OAuthDynamicClientRecord | null {
  if (row.revokedAt) return null;
  let redirectUris: unknown;
  try {
    redirectUris = JSON.parse(row.redirectUrisJson) as unknown;
  } catch {
    return null;
  }
  if (
    !Array.isArray(redirectUris) ||
    !redirectUris.every((uri) => typeof uri === "string")
  ) {
    return null;
  }
  return {
    clientId: row.clientId,
    redirectUris: normalizeRedirectUris(redirectUris),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function registerOAuthDynamicClient(
  record: OAuthDynamicClientRecord
): Promise<void> {
  const normalized: OAuthDynamicClientRecord = {
    ...record,
    redirectUris: normalizeRedirectUris(record.redirectUris),
  };
  if (getConfig().oauthStorageMode === "prisma") {
    const prisma = await prismaClient();
    await prisma.oAuthDynamicClient.upsert({
      where: { clientId: normalized.clientId },
      create: {
        clientId: normalized.clientId,
        redirectUrisJson: JSON.stringify(normalized.redirectUris),
        createdAt: new Date(normalized.createdAt),
        revokedAt: null,
      },
      update: {
        redirectUrisJson: JSON.stringify(normalized.redirectUris),
        revokedAt: null,
      },
    });
    return;
  }

  await serialized(async () => {
    const state = await readClientFile();
    state.clients[normalized.clientId] = normalized;
    await writeClientFile(state);
  });
}

export async function findOAuthDynamicClient(
  clientId: string
): Promise<OAuthDynamicClientRecord | null> {
  if (getConfig().oauthStorageMode === "prisma") {
    const prisma = await prismaClient();
    const row = await prisma.oAuthDynamicClient.findUnique({
      where: { clientId },
    });
    return row ? recordFromPrismaRow(row) : null;
  }

  return serialized(async () => {
    const state = await readClientFile();
    return state.clients[clientId] ?? null;
  });
}

export async function resetOAuthDynamicClientsForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("test-only OAuth dynamic-client reset");
  }
  if (getConfig().oauthStorageMode === "prisma") {
    const prisma = await prismaClient();
    await prisma.oAuthDynamicClient.deleteMany();
    return;
  }
  await serialized(async () => {
    await fs.rm(clientFile(), { force: true });
  });
}