import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";

export interface OAuthSigningKey {
  kid: string;
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKey: ReturnType<typeof createPublicKey>;
}

function envKey(name: string): string {
  return process.env[name]?.trim() || "";
}

function decodePem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

let cachedKey: OAuthSigningKey | undefined;

/**
 * Loads an Ed25519 signing key for OAuth JWTs.
 *
 * The first phase keeps key loading isolated from token handling so existing
 * OAuth flow can migrate without changing authorization semantics.
 */
export function getOAuthSigningKey(): OAuthSigningKey {
  if (cachedKey) return cachedKey;

  const privatePem = envKey("OAUTH_PRIVATE_KEY");
  const publicPem = envKey("OAUTH_PUBLIC_KEY");

  if (privatePem && publicPem) {
    cachedKey = {
      kid: envKey("OAUTH_ACTIVE_KEY_ID") || randomUUID(),
      privateKey: createPrivateKey(decodePem(privatePem)),
      publicKey: createPublicKey(decodePem(publicPem)),
    };
    return cachedKey;
  }

  const generated = generateKeyPairSync("ed25519");
  cachedKey = {
    kid: envKey("OAUTH_ACTIVE_KEY_ID") || randomUUID(),
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
  };

  return cachedKey;
}

export function signEd25519(payload: string): Buffer {
  return sign(null, Buffer.from(payload), getOAuthSigningKey().privateKey);
}

export function verifyEd25519(payload: string, signature: Buffer): boolean {
  return verify(null, Buffer.from(payload), getOAuthSigningKey().publicKey, signature);
}

export function oauthSigningAlgorithm(): string {
  return "EdDSA";
}
