import { AdminUser, Role } from '../../core/models/api.models';

export const ROLE_INFO: { id: Role; label: string; text: string }[] = [
  { id: 'Student', label: 'Student', text: 'Learns: tutor, practice, revision and notes. Everyone starts here.' },
  { id: 'Instructor', label: 'Instructor', text: 'Builds courses and runs classes — only for courses they’re added to.' },
  { id: 'Admin', label: 'Admin', text: 'Manages users, roles and every course, and can trace problems.' },
];

const ORDER: Role[] = ['Student', 'Instructor', 'Admin'];

/** Canonical order, no duplicates. */
export function normalizeRoles(roles: readonly Role[]): Role[] {
  return ORDER.filter((r) => roles.includes(r));
}

export function sameRoles(a: readonly Role[], b: readonly Role[]): boolean {
  return normalizeRoles(a).join() === normalizeRoles(b).join();
}

/**
 * Why a role checkbox can't be changed in the UI (the API enforces the same rules with 409s).
 * Returns null when the admin may toggle it.
 */
export function roleLockReason(role: Role, target: Pick<AdminUser, 'id' | 'roles'>, meId: string | null | undefined, selected: readonly Role[]): string | null {
  if (role === 'Admin' && target.id === meId && target.roles.includes('Admin')) return 'You can’t remove your own Admin role.';
  if (selected.length === 1 && selected[0] === role) return 'Everyone needs at least one role.';
  return null;
}

export function statusPills(u: AdminUser): { label: string; tone: 'mint' | 'amber' | 'danger' | 'neutral' }[] {
  const out: { label: string; tone: 'mint' | 'amber' | 'danger' | 'neutral' }[] = [];
  if (u.accountStatus === 'deleted') out.push({ label: 'Deleted', tone: 'neutral' });
  else if (u.accountStatus === 'pending_guardian') out.push({ label: 'Waiting for guardian', tone: 'amber' });
  else out.push({ label: 'Active', tone: 'mint' });
  if (u.lockedOut) out.push({ label: 'Locked', tone: 'danger' });
  if (!u.emailConfirmed) out.push({ label: 'Email not verified', tone: 'amber' });
  if (u.isMinor) out.push({ label: 'Under 18', tone: 'neutral' });
  return out;
}
