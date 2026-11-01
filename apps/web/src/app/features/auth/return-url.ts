/**
 * Remembers where to go after signing in when the trip goes through email verification
 * (e.g. a class invite → register → verify → sign in → back to the invite). Per-device convenience only.
 */
const KEY = 'sathi.returnAfterAuth';

/** Only same-app relative URLs (prevents open redirects) and never back into /auth. */
export function safeReturnUrl(url: string | null | undefined): string {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') && !url.startsWith('/auth') ? url : '';
}

export function rememberReturnUrl(url: string): void {
  const safe = safeReturnUrl(url);
  if (!safe) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ url: safe, at: Date.now() }));
  } catch {
    /* storage unavailable — fine */
  }
}

/** Returns and forgets a remembered URL (ignored after 2 days). */
export function takeReturnUrl(): string {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (!raw) return '';
    const { url, at } = JSON.parse(raw) as { url: string; at: number };
    return Date.now() - at < 2 * 86_400_000 ? safeReturnUrl(url) : '';
  } catch {
    return '';
  }
}
