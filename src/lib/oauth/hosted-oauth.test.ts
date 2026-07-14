import { afterEach, describe, expect, test } from "bun:test";

import {
  isSafeRedirectUri,
  normalizeRequestedScopes,
  pkceS256,
} from "./hosted-oauth";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("hosted OAuth protocol helpers", () => {
  test("computes the RFC 7636 S256 challenge", () => {
    expect(pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("accepts HTTPS and loopback redirects only", () => {
    expect(isSafeRedirectUri("https://chatgpt.com/connector/oauth/callback")).toBe(true);
    expect(isSafeRedirectUri("http://127.0.0.1:4444/callback")).toBe(true);
    expect(isSafeRedirectUri("http://localhost:4444/callback")).toBe(true);
    expect(isSafeRedirectUri("http://example.com/callback")).toBe(false);
    expect(isSafeRedirectUri("https://user:pass@example.com/callback")).toBe(false);
    expect(isSafeRedirectUri("https://example.com/callback#fragment")).toBe(false);
  });

  test("normalizes and deduplicates Purr Verify scopes", () => {
    expect(normalizeRequestedScopes("verify:read verify:run verify:read"))
      .toEqual(["verify:read", "verify:run"]);
    expect(normalizeRequestedScopes(undefined)).toEqual(["verify:read"]);
  });

  test("rejects GitHub and unknown scopes", () => {
    expect(() => normalizeRequestedScopes("repo read:user"))
      .toThrow("Unsupported scope");
    expect(() => normalizeRequestedScopes("verify:admin"))
      .toThrow("Unsupported scope");
  });
});
