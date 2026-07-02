// Secret redaction for captured logs and error messages.
// Never prints the GitHub token, bearer token, or obvious secret patterns.

import { getConfig } from "./config";

// Literal secret values that must always be scrubbed.
function literalSecrets(): string[] {
  const cfg = getConfig();
  const secrets: string[] = [];
  if (cfg.verifyToken) secrets.push(cfg.verifyToken);
  if (cfg.githubToken) secrets.push(cfg.githubToken);
  return secrets.filter(Boolean);
}

// Regex patterns for common secret shapes.
const SECRET_PATTERNS: RegExp[] = [
  // GitHub classic PAT / OAuth / App tokens: ghp_, gho_, ghu_, ghs_, ghr_
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  // GitHub fine-grained PATs: github_pat_<id>_<random>
  /github_pat_[A-Za-z0-9_]{16,}/g,
  // Classic github tokens (hex)
  /\b[a-f0-9]{40}\b/g,
  // x-access-token:<anything>@ in URLs (git clone credential form)
  /x-access-token:[^@\s]+@/g,
  // <user>:<token>@ in git URLs (e.g. https://token@host)
  /https?:\/\/[^:/@\s]+:[^:@\s]+@/g,
  // Generic key=value assignments for common secret keys
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*['"]?[^\s'"&]+/gi,
  // Authorization: Bearer <token>
  /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._\-]+/gi,
];

export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  // Literal secret values first (exact substring removal).
  for (const secret of literalSecrets()) {
    if (secret && secret.length >= 4) {
      // Escape regex metachars in the secret.
      const esc = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(esc, "g"), "***REDACTED***");
    }
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      // Preserve URL scheme where possible for readability.
      if (/^https?:\/\//.test(m)) {
        return m.replace(/:[^:@\s]+@/, ":***@");
      }
      if (/^(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\b/i.test(m)) {
        return m.replace(/[:=]\s*['"]?[^\s'"&]+/i, "=***REDACTED***");
      }
      return "***REDACTED***";
    });
  }
  return out;
}
