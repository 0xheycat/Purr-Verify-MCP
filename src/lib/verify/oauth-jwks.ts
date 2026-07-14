import { exportJWK } from "jose";
import { getOAuthSigningKey, oauthSigningAlgorithm } from "./oauth-keys";

/**
 * Returns public signing keys for OAuth discovery.
 * Kept separate from the server handlers so key rotation can be added later.
 */
export async function getOAuthJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const key = getOAuthSigningKey();
  const jwk = await exportJWK(key.publicKey);

  return {
    keys: [
      {
        ...jwk,
        kid: key.kid,
        use: "sig",
        alg: oauthSigningAlgorithm(),
      },
    ],
  };
}
