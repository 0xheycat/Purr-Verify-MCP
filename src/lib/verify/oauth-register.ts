import { NextRequest } from "next/server";
import {
  configurationFailure,
  dcrEnabled,
  oauthJson,
  rateLimit,
  validHttpsUrl,
  validRedirectUri,
} from "./oauth-http";
import { registerOAuthClient } from "./oauth-store";

export async function handleRegister(req: NextRequest): Promise<Response> {
  const configFailure = configurationFailure(req);
  if (configFailure) return configFailure;
  if (!dcrEnabled()) {
    return oauthJson({ error: "registration_not_supported" }, 404);
  }

  const limited = rateLimit(req, "register", 10, 60 * 60 * 1000);
  if (limited) return limited;
  if (req.method !== "POST") {
    return oauthJson(
      { error: "method_not_allowed" },
      405,
      { Allow: "POST" }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await req.text()) as Record<string, unknown>;
  } catch {
    return oauthJson(
      {
        error: "invalid_client_metadata",
        error_description: "Body must be JSON",
      },
      400
    );
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter(
        (uri): uri is string => typeof uri === "string"
      )
    : [];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return oauthJson(
      {
        error: "invalid_redirect_uri",
        error_description: "1 to 10 redirect_uris are required",
      },
      400
    );
  }
  if (
    redirectUris.some(
      (uri) => uri.length > 2048 || !validRedirectUri(uri)
    )
  ) {
    return oauthJson({ error: "invalid_redirect_uri" }, 400);
  }

  const grantTypes = Array.isArray(body.grant_types)
    ? body.grant_types
    : ["authorization_code"];
  const responseTypes = Array.isArray(body.response_types)
    ? body.response_types
    : ["code"];
  const authMethod =
    typeof body.token_endpoint_auth_method === "string"
      ? body.token_endpoint_auth_method
      : "none";

  if (
    grantTypes.length !== 1 ||
    grantTypes[0] !== "authorization_code" ||
    responseTypes.length !== 1 ||
    responseTypes[0] !== "code" ||
    authMethod !== "none"
  ) {
    return oauthJson(
      {
        error: "invalid_client_metadata",
        error_description:
          "Only authorization_code + code + token_endpoint_auth_method=none is supported",
      },
      400
    );
  }

  const clientName =
    typeof body.client_name === "string"
      ? body.client_name.trim().slice(0, 120)
      : undefined;
  const clientUri =
    typeof body.client_uri === "string" && validHttpsUrl(body.client_uri)
      ? body.client_uri
      : undefined;
  const client = await registerOAuthClient({
    redirectUris,
    clientName,
    clientUri,
  });

  return oauthJson(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(
        new Date(client.createdAt).getTime() / 1000
      ),
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(client.clientName ? { client_name: client.clientName } : {}),
      ...(client.clientUri ? { client_uri: client.clientUri } : {}),
    },
    201
  );
}
