# 0012 — Course access through public/private courses and classes (join codes, email invites)

- Status: Accepted
- Date: 2026-10-22
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §11.1, §11.11; ADR-0013

## Context and Problem Statement

Release 1 had one implicit rule: every published course is visible to every signed-in student. Instructors now need to teach a specific group (a school section, a cohort, a paid batch) without exposing the course to everyone, see that group's progress, and let several instructors share one course. How does a student get access to a course, and how does an instructor share it?

## Decision Drivers

- Simple for instructors: share one link or code, or paste a list of emails.
- Simple for students: no approval round-trips for the common case.
- Authorization enforced in the API, testable as one rule.
- Insights and grading per group, not only per course.
- No unbounded per-student ACL rows to manage by hand.

## Considered Options

1. Per-student sharing: an instructor adds each student to the course individually (ACL rows).
2. Course visibility (`public`/`private`) plus **classes** (groups inside a course) joined by code, link or email invite.
3. Organisation/tenant model (schools own courses and students).

## Decision Outcome

Chosen option: **2 — visibility plus classes**.

- `courses.visibility`: `public` (any signed-in student can see and self-enrol) or `private` (reachable only through an active membership in a non-archived class of that course). Existing courses default to `public`.
- `course_instructors` with roles `owner` / `instructor` lets several instructors manage a course; the creator is `owner`; the last owner cannot be removed (`COURSE_LAST_OWNER`).
- A **class** belongs to one course and has a join code (8 chars from an unambiguous alphabet, shown `XXXX-XXXX`), an on/off switch, and archive. Students join by code (`POST /classes/join`), by link (`/join?code=XXXX-XXXX`) or by a 14-day **email invite** bound to the invited email (`/join/{token}`; only the SHA-256 of the 32-byte token is stored).
- Joining a class enrols the student in the course (idempotent). Leaving or removal (`removed_at`) withdraws access to a private course.
- Every course/lesson/practice/tutor endpoint returns 404 `NOT_FOUND` for a course the student cannot see (no existence leak). Instructor insights and the grading queue accept `classId`.

### Consequences

- Good: one rule (`public OR active class member`) covers all student endpoints; classes give per-group insights for free.
- Good: join codes scale to large groups; invites give per-person control where needed; both can be revoked (regenerate code, disable joining, revoke invite).
- Bad: a leaked join code admits anyone with an account until it is regenerated or joining is disabled — instructors must treat codes as shared secrets for private courses (see threat model §5.11).
- Bad: one more level (course → class → member) in the UI and in tests.
- Neutral: no organisation/tenant concept yet; an org model can later own classes without changing the access rule.

### Confirmation

- API integration tests: a student who is not a member gets 404 on every endpoint of a private course; joining by code/invite grants access; removal and archive revoke it; invite accepted with another email → 403 `CLASS_INVITE_EMAIL_MISMATCH`; expired → 410.
- Instructor tests: non-instructors of a course get 404/403 on its management endpoints; last-owner rule.

## Pros and Cons of the Options

- **1. Per-student sharing** — Good: precise. Bad: unmanageable for 100+ students; no group insights; every share is a manual step.
- **2. Visibility + classes** — Good: matches how teaching works; codes, links and invites; group insights. Bad: shared-secret codes; more UI.
- **3. Tenants** — Good: institutional control. Bad: far more scope (billing, org admins, data separation) than needed now.

## Links

- contracts.md §11.1 (schema, endpoints, rules)
