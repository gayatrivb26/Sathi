/** Common IANA time zones for the reminder picker (the user's current zone is always included). */
export const TIMEZONES: string[] = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'Africa/Nairobi',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
];

export function timezonesWith(current: string | null | undefined): string[] {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Array.from(new Set([current, browser, ...TIMEZONES].filter((z): z is string => !!z)));
}

export function hourLabel(h: number): string {
  const suffix = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:00 ${suffix}`;
}
