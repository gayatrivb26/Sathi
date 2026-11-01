# 0014 — Under-18 learners: verifiable guardian consent (DPDP Act 2023, s.9)

- Status: Accepted (pending legal review — see "Open legal questions")
- Date: 2026-10-22
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §11.4; [threat-model.md](../architecture/threat-model.md) §6; ADR-0013

## Context and Problem Statement

Sathi targets Indian learners, including school students. Under India's Digital Personal Data Protection Act, 2023 a **child** is anyone under 18, and s.9(1) requires *verifiable consent of the parent or lawful guardian* before processing a child's personal data; s.9(2)–(3) forbid processing likely to harm a child's well-being and tracking, behavioural monitoring or targeted advertising directed at children. Release 1 had no age information at all. Do we exclude minors, or let them in with guardian consent — and how?

## Decision Drivers

- Lawful processing for under-18 users; consent provable later (who, when, which notice).
- Minimal data: only what is needed to decide and prove consent.
- Withdrawal as easy as giving consent.
- No dependency on government ID or a paid verification provider at this stage.

## Considered Options

1. 18+ only (age declaration, block minors).
2. Date of birth at registration; under 18 → guardian email; account inactive until the guardian grants consent through an emailed link; consent record kept.
3. Option 2 plus identity/age verification of the guardian (DigiLocker or a verification provider).

## Decision Outcome

Chosen option: **2**, with option 3 as a planned upgrade if counsel or the DPDP Rules require it.

- Registration requires `dateOfBirth`. Age < `Privacy:MinimumAge` (default **8**) → 400 `AUTH_TOO_YOUNG`. Age < `Privacy:AgeOfMajority` (default **18**; do not lower it for India) → `guardianEmail` required and different from the learner's email.
- The learner gets the normal verification email; the guardian gets a consent email with `${APP_BASE_URL}/consent/{token}` (7-day token, SHA-256 stored). The consent page shows the learner (masked email), the policy version and the list of data processed.
- Sign-in requires a confirmed email **and** consent `not_required` or `granted`, else 403 `AUTH_GUARDIAN_CONSENT_PENDING` / `AUTH_GUARDIAN_CONSENT_DECLINED`.
- **What we store** (`users`): `date_of_birth` (null = adult/legacy), `is_minor`, `guardian_email_normalized`, `guardian_consent_status`, `guardian_consent_at`. **Consent record** (`guardian_consents`): guardian email, token hash, `policy_version` (`Privacy:ConsentPolicyVersion`), requested/expires/decided timestamps, decision, and *hashes* of IP and user agent — no raw IP, no ID documents.
- **Retention**: consent records are kept for the long retention period (proof of lawful processing), also after the learner account is deleted; the learner's own data follows the normal deletion/purge rules (30 days after soft delete). Exact periods to be confirmed by counsel.
- **Withdrawal**: the "granted" confirmation email repeats the link; `declined` or `withdrawn` soft-deletes the learner and triggers the `user.deleted` outbox (AI data, files), exactly like `DELETE /me`.
- Sathi has no advertising, ad SDKs or third-party behavioural tracking; learning analytics (mastery, recommendations) are used only to tutor that learner.
- Configuration: `PRIVACY_MINIMUM_AGE`, `PRIVACY_AGE_OF_MAJORITY`, `PRIVACY_CONSENT_POLICY_VERSION` in `.env` → `Privacy__*`. Bump the policy version whenever the notice or consent text changes.

### Consequences

- Good: minors can use Sathi with a provable, revocable guardian consent; no extra personal data beyond DOB and a guardian email.
- Bad: "verifiable" here means *control of the guardian's mailbox*. A child can enter their own second address as the guardian. This is the weakest acceptable form and may not satisfy the Rules (see below).
- Bad: DOB is self-declared; a minor can claim to be an adult. Accepted residual risk, stated in the notice.
- Bad: more support load (expired consent links → `POST /auth/resend-guardian-consent`).

### Open legal questions (flag for legal review before real minors use the system)

1. **DPDP Rules** (notified November 2025, phased commencement) set *how* consent must be verified — e.g. checking that the parent is an identifiable adult using details already held or a virtual token from an authorised entity (such as DigiLocker). Email-only verification may be insufficient; counsel to confirm and set a date for option 3.
2. Whether mastery tracking and recommendations count as "behavioural monitoring" under s.9(3), and whether any Rules exemption for educational purposes applies to Sathi (do not assume it does).
3. Retention period for consent records and for audit events after erasure.
4. Whether `Privacy:MinimumAge` (8) is appropriate for the product and the notice language.

### Confirmation

- API tests: under-minimum age → `AUTH_TOO_YOUNG`; minor without guardian email or with the same email → `VALIDATION_FAILED`; minor cannot sign in until `granted`; `declined`/`withdrawn` soft-delete the learner and enqueue `user.deleted`; expired token → status `expired`.
- Review: consent page text, data list and policy version reviewed by counsel; threat model §6 updated.

## Pros and Cons of the Options

- **1. 18+ only** — Good: simplest, no child data. Bad: excludes the core school audience; self-declared age is still unverifiable.
- **2. Guardian email consent** — Good: workable now, provable, revocable, minimal data. Bad: weak verification.
- **3. Verified guardian identity** — Good: strongest compliance. Bad: integration cost, more personal data, provider dependency.

## Links

- Digital Personal Data Protection Act, 2023 — s.2(f) (child), s.9 (processing of children's data)
- Digital Personal Data Protection Rules, 2025 (verifiable consent for children)
