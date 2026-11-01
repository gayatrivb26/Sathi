# Sathi web (`apps/web`)

Angular 21 (standalone, signals, zoneless) + Angular Material M3 themed from the Sathi design tokens.
API shapes follow `docs/architecture/contracts.md` §5 exactly (see `src/app/core/models/api.models.ts`).

## Run

| What | Command |
| --- | --- |
| Install | `npm ci` |
| Dev against the real API (proxies `/api`, `/hangfire` → `http://localhost:5080`) | `npm start` → http://localhost:4200 |
| Dev with the **mock API** (no backend needed) | `npm run start:mock` → http://localhost:4300 |
| Production build | `npm run build` → `dist/web/browser` |
| Unit tests (Vitest) | `npm test` |
| E2E journeys + axe checks (mock API) | `npm run e2e:install` once, then `npm run e2e` |
| Screenshot tour (desktop 1440×900 + phone 390×844 → `e2e/screenshots/`) | `npx playwright test screenshots` |
| Docker image (context = repo root) | `docker build -f apps/web/Dockerfile -t sathi-web .` |

### Mock mode

`--configuration mock` swaps `core/mock/mock.providers.ts` for `mock.providers.mock.ts` (file replacement), so mock
code is never part of development or production bundles. State lives in `sessionStorage` (one fresh database per tab).

- Demo accounts (any password except `wrong`): `asha@sathi.dev` (student), `new@sathi.dev` (needs onboarding),
  `instructor@sathi.dev`, `admin@sathi.dev`. Registering works too; the check-email page shows the demo link.
- Tutor triggers: a question containing **error** fails once with a reference ID (Retry succeeds), **slow** waits 7 s
  before the first token, **drop** cuts the stream (reported as `sse_drop`), **quota** + web search → 429.
- Notes: a file name containing **scan** fails with `INGEST_NO_TEXT`; Retry succeeds.
- Admin: look up `7F3A-91C2`.
- Release 2 (contracts.md §11):
  - Class codes: `DEEP-LAB7` (private "Deep Learning Lab", Asha isn't a member yet), `MNDY-CHRT` (Asha's class),
    `WKND-B4TC` (joining off). Join at `/join` or `/join?code=…`; leave in Settings → My classes.
  - Class invite links: `/join/demo-class-invite` (for `new@sathi.dev`), `/join/demo-class-invite-expired`.
  - Staff invite: `/auth/register?staffInvite=demo-staff-invite` (sent to `teacher@school.in`); signed-in users go to `/staff-invite/:token`.
  - Guardian consent: `/consent/demo-consent` (learner `tara@sathi.dev`, who sees "waiting for your guardian" at sign-in).
    Registering with a date of birth under 18 asks for a guardian email; the check-email page shows both demo links.
  - Second instructor for the Co-instructors panel: `instructor2@sathi.dev`. Admin → Users has ~30 people to page through.
  - Tutor history has 28 conversations (Load older), one stopped answer ("Explain LoRA") and one interrupted
    stream ("What is a mixture of experts?"). Stop calls `POST …/messages/{id}/cancel`; the mock keeps generating
    after a browser disconnect, like the API, and only cancel stops it.
- Force any endpoint to fail: `sessionStorage.setItem('sathi.mock.fail', '/api/v1/progress')`.

## Structure

```
src/app/core/      api clients, auth store + guards, interceptors (traceparent, errors), SSE client/parser,
                   markdown (marked + DOMPurify + KaTeX + citation chips), error reporting, mock API
src/app/shared/    UI building blocks (icons, states, mastery bars, markdown view, question card, chart)
src/app/layout/    shell: 220 px sidebar on desktop, top bar + bottom nav under 720 px
src/app/features/  auth, onboarding, home, course, lesson, tutor, practice, revision, notes, progress,
                   settings, teach (instructor), admin, not-found — all lazy-loaded
```
