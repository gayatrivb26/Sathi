# 0016 — Per-service object-storage credentials (no root keys in applications)

- Status: Accepted
- Date: 2026-10-22
- Deciders: project owner
- Related: [contracts.md](../architecture/contracts.md) §2, §11.8; [threat-model.md](../architecture/threat-model.md) §5.10; ADR-0015

## Context and Problem Statement

Until Release 2 `api`, `jobs`, `ai-service` and `ai-ingest` all used the MinIO **root** credentials. Any of them — including the AI containers that parse untrusted files — could read, overwrite or delete every object, change bucket policy, create users or make the bucket public. Which storage credentials should each service have?

## Decision Drivers

- Least privilege per service and per key prefix.
- The parser container must not be able to tamper with original uploads.
- Same model on MinIO locally and on S3 / Azure Blob in production.
- Idempotent provisioning; no manual console steps.

## Considered Options

1. Keep root credentials everywhere.
2. One non-root user shared by all services.
3. One user per service *role* with prefix-scoped policies, created by `minio-init`.

## Decision Outcome

Chosen option: **3**.

| User (env) | Used by | Policy on bucket `sathi-documents` | Policy file |
| --- | --- | --- | --- |
| `STORAGE_APP_ACCESS_KEY` / `STORAGE_APP_SECRET_KEY` | api, jobs | Get/Put/Delete on `uploads/*` and `lessons/*`; Delete on `parsed/*`; ListBucket | `infrastructure/docker/minio/app-storage-policy.json` (`sathi-app-storage`) |
| `STORAGE_AI_ACCESS_KEY` / `STORAGE_AI_SECRET_KEY` | ai-service, ai-ingest | Get on `uploads/*` and `lessons/*`; Get/Put/Delete on `parsed/*`; ListBucket | `infrastructure/docker/minio/ai-storage-policy.json` (`sathi-ai-storage`) |

- `minio-init` (`infrastructure/docker/minio/init.sh`) creates the bucket (private), (re)applies both policies, creates or updates both users with the secrets from `.env`, and leaves each user with exactly its one policy. Re-running is safe.
- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` are passed only to `minio` and `minio-init` (and used by operators for the console and backups). `migrator-app` and `migrator-ai` get no storage credentials.
- Compose maps the app user to `Storage__AccessKey` / `Storage__SecretKey` (api, jobs) and the AI user to `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` (ai-service, ai-ingest).
- The bucket is provisioned only by `minio-init`; applications must not try to create it (the scoped users have no `s3:CreateBucket`).
- Production: the same two identities become IAM roles / managed identities with equivalent prefix policies (S3 bucket policy or Azure Blob RBAC with container/prefix scoping).

### Consequences

- Good: a compromised AI container can read originals but cannot alter or delete them, cannot touch other prefixes, and cannot administer storage.
- Good: the app side can clean up `parsed/*` on deletion (outbox) without being able to forge parse output.
- Bad: two more secrets to rotate (`mc admin user add` with a new secret is idempotent; restart the consumers).
- Bad: policies are deliberately exact — no `s3:AbortMultipartUpload` or version-level actions. If a client starts using multipart uploads or version deletes, the policy must be extended in the same change.
- Bad: bucket versioning is enabled by `minio-init`; deletes create delete markers and keep non-current versions. A lifecycle rule to expire non-current versions is needed for complete erasure (threat model backlog).

### Confirmation

- `mc` policy test (run for this ADR against `postgres + minio + minio-init`): AI user `PUT uploads/…` denied, app user `PUT parsed/…` denied, app user `DELETE parsed/…` allowed, both users denied `mc admin` and bucket creation, all expected reads/writes allowed.
- `docker compose config`: root credentials appear only in `minio` and `minio-init`.

## Pros and Cons of the Options

- **1. Root everywhere** — Good: nothing to manage. Bad: total compromise from any service.
- **2. One shared user** — Good: no root in apps. Bad: the parser can still overwrite originals.
- **3. Per-role users** — Good: least privilege, mirrors cloud IAM. Bad: more secrets and policy upkeep.

## Links

- MinIO policy-based access control; AWS S3 policy actions
