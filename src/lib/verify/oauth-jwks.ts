import { getOAuthPublicJwks } from "./oauth-keys";

/** Returns all currently accepted OAuth verification keys. */
export function getOAuthJwks(): { keys: Record<string, unknown>[] } {
  return { keys: getOAuthPublicJwks() };
}
