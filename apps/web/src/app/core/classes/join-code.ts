/**
 * Class join codes (contracts.md §11.1): 8 characters from an alphabet without look-alikes
 * (no I, O, 0, 1), displayed as `XXXX-XXXX`. The server accepts any case and with or without the dash.
 */
export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 8;

/** Upper-cases and strips spaces and dashes: " abcd-ef23 " → "ABCDEF23". */
export function normalizeJoinCode(input: string | null | undefined): string {
  return (input ?? '').toUpperCase().replace(/[\s\-–—_]/g, '');
}

/** "ABCDEF23" → "ABCD-EF23". Partial input formats as the user types: "ABCDE" → "ABCD-E". */
export function formatJoinCode(input: string | null | undefined): string {
  const raw = normalizeJoinCode(input).slice(0, JOIN_CODE_LENGTH);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

export type JoinCodeProblem = 'empty' | 'short' | 'long' | 'chars' | null;

/** Explains what is wrong with a code before we send it (null = looks valid). */
export function joinCodeProblem(input: string | null | undefined): JoinCodeProblem {
  const raw = normalizeJoinCode(input);
  if (!raw) return 'empty';
  if ([...raw].some((ch) => !JOIN_CODE_ALPHABET.includes(ch))) return 'chars';
  if (raw.length < JOIN_CODE_LENGTH) return 'short';
  if (raw.length > JOIN_CODE_LENGTH) return 'long';
  return null;
}

export function isValidJoinCode(input: string | null | undefined): boolean {
  return joinCodeProblem(input) === null;
}

export function joinCodeMessage(problem: JoinCodeProblem): string {
  switch (problem) {
    case 'empty':
      return 'Enter the 8-character code from your teacher.';
    case 'short':
      return 'Class codes have 8 characters, like ABCD-EF23.';
    case 'long':
      return 'That’s longer than a class code. Codes have 8 characters, like ABCD-EF23.';
    case 'chars':
      return 'Class codes use letters and the digits 2–9 only (no 0, 1, I or O).';
    default:
      return '';
  }
}

/** `${origin}/join?code=XXXX-XXXX` */
export function joinLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/join?code=${formatJoinCode(code)}`;
}

/** A ready-to-paste message for a class group chat or email. */
export function shareText(opts: { className: string; courseTitle: string; code: string; origin: string }): string {
  const code = formatJoinCode(opts.code);
  return [
    `Join “${opts.className}” (${opts.courseTitle}) on Sathi:`,
    joinLink(opts.origin, code),
    `Or open Sathi, choose “Join a class” and enter the code ${code}.`,
  ].join('\n');
}

const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;

/**
 * Splits pasted text (commas, semicolons, spaces, new lines, "Name <a@b.c>") into unique emails.
 * Comparison is case-insensitive; the first spelling is kept.
 */
export function parseEmailList(text: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  const tokens = text
    .replace(/[<>]/g, ' ')
    .split(/[\s,;]+/)
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  for (const t of tokens) {
    if (!t.includes('@')) {
      // Words around an address ("Asha Verma <asha@x.in>") are not errors on their own.
      continue;
    }
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (EMAIL.test(t) ? valid : invalid).push(t);
  }
  return { valid, invalid };
}
