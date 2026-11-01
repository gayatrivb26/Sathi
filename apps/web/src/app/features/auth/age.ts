/** Age rules for registration (contracts.md §11.4). The API enforces them; the UI explains them early. */
export const MINIMUM_AGE = 8;
export const AGE_OF_MAJORITY = 18;

/** Parses `YYYY-MM-DD` as a calendar date (no time zone shifts). */
export function parseIsoDate(value: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Whole years between the date of birth and `today` (a birthday counts on the day itself). */
export function ageOn(dateOfBirth: string, today: Date = new Date()): number | null {
  const dob = parseIsoDate(dateOfBirth);
  if (!dob) return null;
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  let age = ty - dob.y;
  if (tm < dob.m || (tm === dob.m && td < dob.d)) age--;
  return age;
}

export type AgeBand = 'invalid' | 'future' | 'too-young' | 'minor' | 'adult';

export function ageBand(dateOfBirth: string, today: Date = new Date()): AgeBand {
  const age = ageOn(dateOfBirth, today);
  if (age === null) return 'invalid';
  if (age < 0) return 'future';
  if (age > 120) return 'invalid';
  if (age < MINIMUM_AGE) return 'too-young';
  if (age < AGE_OF_MAJORITY) return 'minor';
  return 'adult';
}

/** `YYYY-MM-DD` for a local date (used for the date input's max). */
export function isoDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}
