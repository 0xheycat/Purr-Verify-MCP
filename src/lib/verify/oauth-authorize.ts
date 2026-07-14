import { NextRequest, NextResponse } from "next/server";
import {
  oauthIssuer,
  oauthResourceUrl,
  oauthSubject,
  supportedOauthScopes,
} from "./oauth-crypto";
import {
  codeTtlSeconds,
  configurationFailure,
  html,
  oauthJson,
  ownerCode,
  rateLimit,
  readOAuthParams,
  renderAuthorizePage,
  requestedScopes,
  safeEqual,
  validateAuthorizeParams,
} from "./oauth-http";
import { createAuthorizationCode } from "./oauth-store";

export async function handleAuthorize(req: NextRequest): Promise<Response> {
  const configFailure = configurationFailure(req);
  if (configFailure) return configFailure;

  const limited = rateLimit(
    req,
    req.method === "POST" ? "authorize-post" : "authorize-get",
    req.method === "POST" ? 12 : 60,
    10 * 60 * 1000
  );
  if (limited) return limited;

  if (req.method === "GET") {
    const url = new URL(req.url);
    const error = await validateAuthorizeParams(url.searchParams, req);
    return html(
      renderAuthorizePage(url.searchParams, req, error),
      error ? 400 : 200
    );
  }
  if (req.method !== "POST") {
    return oauthJson(
      { error: "method_not_allowed" },
      405,
      { Allow: "GET, POST" }
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

  const error = await validateAuthorizeParams(params, req);
  if (error) return html(renderAuthorizePage(params, req, error), 400);
  if (!safeEqual(params.get("owner_code") || "", ownerCode())) {
    return html(
      renderAuthorizePage(params, req, "Invalid owner approval code."),
      401
    );
  }

  const scopes = requestedScopes(params.get("scope"));
  if (!scopes.ok) {
    return html(renderAuthorizePage(params, req, scopes.reason), 400);
  }
  const code = await createAuthorizationCode({
    clientId: params.get("client_id") || "",
    redirectUri: params.get("redirect_uri") || "",
    scope: scopes.value,
    resource: params.get("resource") || "",
    codeChallenge: params.get("code_challenge") || "",
    codeChallengeMethod: "S256",
    subject: oauthSubject(),
    expiresAt: new Date(Date.now() + codeTtlSeconds() * 1000).toISOString(),
  });

  const callback = new URL(params.get("redirect_uri") || "");
  callback.searchParams.set("code", code);
  const state = params.get("state");
  if (state) callback.searchParams.set("state", state);
  callback.searchParams.set("iss", oauthIssuer(req));
  return NextResponse.redirect(callback.toString(), 303);
}

export function oauthAuthorizationSummary(req: NextRequest) {
  return {
    issuer: oauthIssuer(req),
    resource: oauthResourceUrl(req),
    scopes: supportedOauthScopes(),
  };
}
