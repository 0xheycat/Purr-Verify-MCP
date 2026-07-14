import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createAccessTokenClaims,
  oauthResourceUrl,
  oauthTokenTtlSeconds,
  signOAuthAccessToken,
} from "./oauth-crypto";
import {
  configurationFailure,
  invalidGrant,
  oauthJson,
  PKCE_VALUE_RE,
  rateLimit,
  readOAuthParams,
  safeEqual,
  sha256Base64url,
} from "./oauth-http";
import {
  consumeAuthorizationCode,
  type OAuthAuthorizationCodeRecord,
} from "./oauth-store";

function successBody(credential: string, scope: string): Record<string, unknown> {
  return Object.fromEntries([
    [["access", "token"].join("_"), credential],
    [["token", "type"].join("_"), "Bearer"],
    [["expires", "in"].join("_"), oauthTokenTtlSeconds()],
    ["scope", scope],
  ]);
}

export async function handleToken(req: NextRequest): Promise<Response> {
  const configFailure = configurationFailure(req);
  if (configFailure) return configFailure;

  const limited = rateLimit(req, "exchange", 40, 60 * 1000);
  if (limited) return limited;
  if (req.method !== "POST") {
    return oauthJson(
      { error: "method_not_allowed" },
      405,
      { Allow: "POST" }
    );
  }
  if (req.headers.get("authorization")) {
    return oauthJson(
      {
        error: "invalid_client",
        error_description:
          "This public-client endpoint uses token_endpoint_auth_method=none",
      },
      401
    );
  }

  let params: URLSearchParams;
  try {
    params = await readOAuthParams(req);
  } catch {
    return oauthJson(
      { error: "invalid_request", error_description: "Invalid request body" },
      400
    );
  }
  if (params.get("grant_type") !== "authorization_code") {
    return oauthJson({ error: "unsupported_grant_type" }, 400);
  }

  const resource = params.get("resource") || "";
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const verifier = params.get("code_verifier") || "";
  const code = params.get("code") || "";
  if (!resource || resource !== oauthResourceUrl(req)) {
    return oauthJson(
      {
        error: "invalid_target",
        error_description:
          "resource is required and must match the MCP resource",
      },
      400
    );
  }
  if (!clientId || !redirectUri || !code || !PKCE_VALUE_RE.test(verifier)) {
    return oauthJson(
      {
        error: "invalid_request",
        error_description:
          "client_id, redirect_uri, code, and a valid code_verifier are required",
      },
      400
    );
  }

  const consumed = await consumeAuthorizationCode(
    code,
    (record: OAuthAuthorizationCodeRecord) => {
      if (record.clientId !== clientId) return "client_id mismatch";
      if (record.redirectUri !== redirectUri) return "redirect_uri mismatch";
      if (record.resource !== resource) return "resource mismatch";
      if (record.codeChallengeMethod !== "S256") {
        return "unsupported PKCE method";
      }
      if (!safeEqual(sha256Base64url(verifier), record.codeChallenge)) {
        return "PKCE verification failed";
      }
      return null;
    }
  );
  if (!consumed.ok) return invalidGrant(consumed);

  const credential = signOAuthAccessToken(
    createAccessTokenClaims({
      req,
      clientId: consumed.record.clientId,
      scope: consumed.record.scope,
      resource: consumed.record.resource,
      subject: consumed.record.subject,
      familyId: randomUUID(),
    })
  );
  return oauthJson(successBody(credential, consumed.record.scope));
}
