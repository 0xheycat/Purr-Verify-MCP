export function sanitizeGitRemote(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return raw.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1");
  }
}

export function isEnvironmentTemplateFile(name: string): boolean {
  return /(?:\.example|\.sample|\.template)$/i.test(name);
}
