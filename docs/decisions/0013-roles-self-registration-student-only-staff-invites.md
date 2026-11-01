# 0013 — Roles: self-registration is Student-only; staff roles granted by admins or staff invites

- Status: Accepted
- Date: 2026-10-22
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §11.2, §11.11; ADR-0008, ADR-0012

## Context and Problem Statement

Sathi has three roles: Student, Instructor, Admin. Instructors can publish content that every student of a course sees; Admins can read run ledgers, enable debug capture and change roles. Release 1 assigned staff roles only through seed data. How do people become instructors or admins, and how fast does a role change take effect on a live session?

## Decision Drivers

- No self-service privilege escalation: nobody chooses their own role.
- Onboarding an instructor must not require database access.
- A revoked role or a locked account must stop working quickly, without forcing everyone to sign in again.
- Every privilege change is auditable.

## Considered Options

1. Role picker at sign-up ("I am an instructor").
2. Student-only self-registration; Admins grant roles on a Users page; Admins send **staff invites** (Instructor or Admin, optionally bound to a course).
3. External identity provider groups (Entra ID / Google Workspace) mapped to roles.

## Decision Outcome

Chosen option: **2**.

- `POST /auth/register` always creates a **Student**. The UI never offers a role choice and the API ignores any role field.
- **Users page** (`/admin/users`): Admins search users, set roles (`PUT /admin/users/{id}/roles`), lock/unlock, resend verification. Guards: `ROLE_SELF_DEMOTION` (removing your own Admin role or locking yourself) and `ROLE_LAST_ADMIN`.
- **Staff invites** (`POST /admin/staff-invites {email, role, courseId?}`): 7-day single-use link `/auth/register?staffInvite={token}` (SHA-256 of the token stored). Registering — or, for an existing account, accepting while signed in — **with the same email** adds the role (in addition to Student) and, with `courseId`, an `instructor` row on that course.
- Roles live in `user_roles` and travel as claims in the auth cookie. The UI uses them only for navigation; every rule is an API authorization policy.
- `SecurityStampValidatorOptions.ValidationInterval = 1 minute`. Every role change, lock and password reset updates the security stamp, so an active session picks up the change (or is signed out) within about a minute.
- Every role, lock and invite action writes `audit_events` (`user.roles_changed` with before/after, `user.locked`, `staff_invite.created`, …).

### Consequences

- Good: escalation requires an Admin action or a token sent to a specific mailbox; changes are audited and take effect within a minute.
- Good: instructors can be onboarded (and attached to a course) with one form.
- Bad: one extra database read per user per minute for stamp validation (negligible at this scale).
- Bad: an invite link is a bearer credential until used or expired — mitigated by the email binding, single use, 7-day expiry and revocation (threat model §5.11).
- Bad: no MFA yet for staff accounts (tracked in the threat model backlog).

### Confirmation

- Tests: register with a role field → Student only; non-admin calls to `/admin/*` → 403; self-demotion and last-admin guards; staff invite with a different email → rejected; after a role removal an existing cookie loses access within the validation interval.

## Pros and Cons of the Options

- **1. Role picker** — Good: no admin work. Bad: anyone becomes an instructor; unacceptable.
- **2. Admin grants + staff invites** — Good: controlled, audited, simple. Bad: admin effort; invite links must be protected.
- **3. IdP groups** — Good: central lifecycle. Bad: requires an organisation IdP; future option when Sathi serves institutions.

## Links

- ASP.NET Core Identity security stamp validation
- contracts.md §11.2
