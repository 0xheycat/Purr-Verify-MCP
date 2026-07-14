import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

export interface OAuthSigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

interface OAuthKeySet {
  active: OAuthSigningKey;
  verificationKeys: Map<string, KeyObject>;
}

interface VerificationKeyConfig {
  kid?: unknown;
  public_key?: unknown;
}

function envKey(name: string): string {
  return process.env[name]?.trim() || "";
}

function decodePem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function assertEd25519(key: KeyObject, name: string): void {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${name} must be an Ed25519 key`);
  }
}

function derivedKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return `ed25519-${createHash("sha256").update(der).digest("base64url").slice(0, 22)}`;
}

function samePublicKey(a: KeyObject, b: KeyObject): boolean {
  const left = a.export({ format: "der", type: "spki" });
  const right = b.export({ format: "der", type: "spki" });
  return Buffer.from(left).equals(Buffer.from(right));
}

function allowEphemeralKeys(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.OAUTH_ALLOW_EPHEMERAL_KEYS === "true";
}

function parseAdditionalVerificationKeys(raw: string): Map<string, KeyObject> {
  const result = new Map<string, KeyObject>();
  if (!raw) return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OAUTH_VERIFICATION_PUBLIC_KEYS must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("OAUTH_VERIFICATION_PUBLIC_KEYS must be a JSON array");
  }

  for (const entry of parsed as VerificationKeyConfig[]) {
    const kid = typeof entry?.kid === "string" ? entry.kid.trim() : "";
    const publicPem = typeof entry?.public_key === "string" ? entry.public_key.trim() : "";
    if (!kid || !publicPem) {
      throw new Error("Each OAuth verification key requires kid and public_key");
    }
    if (result.has(kid)) throw new Error(`Duplicate OAuth verification kid: ${kid}`);
    const publicKey = createPublicKey(decodePem(publicPem));
    assertEd25519(publicKey, `OAuth verification key ${kid}`);
    result.set(kid, publicKey);
  }
  return result;
}

let cachedFingerprint = "";
let cachedKeySet: OAuthKeySet | undefined;

function loadOAuthKeySet(): OAuthKeySet {
  const privatePem = envKey("OAUTH_PRIVATE_KEY");
  const configuredPublicPem = envKey("OAUTH_PUBLIC_KEY");
  const configuredKid = envKey("OAUTH_ACTIVE_KEY_ID");
  const additionalRaw = envKey("OAUTH_VERIFICATION_PUBLIC_KEYS");
  const fingerprint = [privatePem, configuredPublicPem, configuredKid, additionalRaw, process.env.NODE_ENV, process.env.OAUTH_ALLOW_EPHEMERAL_KEYS].join("\0");
  if (cachedKeySet && cachedFingerprint === fingerprint) return cachedKeySet;

  let privateKey: KeyObject;
  let publicKey: KeyObject;

  if (privatePem) {
    privateKey = createPrivateKey(decodePem(privatePem));
    assertEd25519(privateKey, "OAUTH_PRIVATE_KEY");
    publicKey = createPublicKey(privateKey);
    if (configuredPublicPem) {
      const configuredPublicKey = createPublicKey(decodePem(configuredPublicPem));
      assertEd25519(configuredPublicKey, "OAUTH_PUBLIC_KEY");
      if (!samePublicKey(publicKey, configuredPublicKey)) {
        throw new Error("OAUTH_PUBLIC_KEY does not match OAUTH_PRIVATE_KEY");
      }
    }
  } else {
    if (configuredPublicPem) {
      throw new Error("OAUTH_PRIVATE_KEY is required when OAUTH_PUBLIC_KEY is configured");
    }
    if (!allowEphemeralKeys()) {
      throw new Error("OAUTH_PRIVATE_KEY is required in production; ephemeral OAuth keys are disabled");
    }
    const generated = generateKeyPairSync("ed25519");
    privateKey = generated.privateKey;
    publicKey = generated.publicKey;
  }

  const kid = configuredKid || derivedKeyId(publicKey);
  const verificationKeys = parseAdditionalVerificationKeys(additionalRaw);
  const existing = verificationKeys.get(kid);
  if (existing && !samePublicKey(existing, publicKey)) {
    throw new Error(`OAUTH_ACTIVE_KEY_ID conflicts with verification key: ${kid}`);
  }
  verificationKeys.set(kid, publicKey);

  cachedFingerprint = fingerprint;
  cachedKeySet = { active: { kid, privateKey, publicKey }, verificationKeys };
  return cachedKeySet;
}

export function getOAuthSigningKey(): OAuthSigningKey {
  return loadOAuthKeySet().active;
}

export function signEd25519(payload: string): Buffer {
  return sign(null, Buffer.from(payload), getOAuthSigningKey().privateKey);
}

export function verifyEd25519(payload: string, signature: Buffer, kid: string): boolean {
  const key = loadOAuthKeySet().verificationKeys.get(kid);
  if (!key) return false;
  return verify(null, Buffer.from(payload), key, signature);
}

export function getOAuthPublicJwks(): Record<string, unknown>[] {
  return [...loadOAuthKeySet().verificationKeys.entries()].map(([kid, publicKey]) => {
    const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    return { ...jwk, kid, use: "sig", alg: oauthSigningAlgorithm() };
  });
}

export function oauthSigningAlgorithm(): "EdDSA" {
  return "EdDSA";
}
