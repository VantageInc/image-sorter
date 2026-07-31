const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export const PACKAGED_BLOCKED_URL_PATTERNS = Object.freeze([
  'http://*/*',
  'https://*/*',
  'ws://*/*',
  'wss://*/*',
]);

export function trustedDevServerUrl(
  value: string | undefined,
  isPackaged: boolean,
): string | undefined {
  if (isPackaged || !value) return undefined;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0
      || !LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}
