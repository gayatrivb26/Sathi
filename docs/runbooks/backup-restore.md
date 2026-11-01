# Runbook — backup and restore

> **Drill status:** backup → wipe → restore → verify executed successfully on 2026-10-17 against the production-rehearsal stack (`compose.prod.yaml`: read-only Postgres/MinIO containers): app and ai tables, an HNSW-indexed `vector` column, schema owners, extensions, role search paths and a MinIO object all came back. Re-run the drill after any change to the init script or the storage layout.

What is backed up:

| Data | Tool | Contains |
| --- | --- | --- |
| PostgreSQL `sathi` (schemas `app`, `ai`, `hangfire`, `extensions`) | `pg_dump -Fc` (custom format) | All application data, chunks + embeddings, job state, the AI run ledger, audit events |
| MinIO bucket `sathi-documents` | `mc mirror` | Uploaded originals (`uploads/...`) and parsed text (`parsed/...`) |
| Secrets (`.env` / secret store) | the secret store's own backup | Role passwords, service-token key pair (`SERVICE_TOKEN_*`), storage user secrets (`STORAGE_APP_*`, `STORAGE_AI_*`, recreated by `minio-init` from `.env`), `LOG_HASH_SALT` — **a database backup is useless without the matching role passwords** |

Not backed up: Loki/Tempo/Prometheus data (diagnostic, short retention), Grafana (provisioned from the repo).

Production uses the managed database's automated backups with point-in-time restore plus storage versioning/replication; the commands below are for local stacks, the production-rehearsal stack and pre-migration safety copies. Run them from the repository root. The examples use project `sathi` (dev); add `-p sathi-prod -f compose.yaml -f compose.prod.yaml` for the rehearsal stack.

> Git Bash on Windows: prefix the commands with `MSYS_NO_PATHCONV=1` so container paths like `/tmp/...` are not rewritten.

## 1. Backup

`pg_dump` and `pg_restore` run in a **one-off container** of the `postgres` service that connects to the running database over the internal network and writes to a bind-mounted folder. This works with the read-only production container (whose `/tmp` is a tmpfs that `docker cp` cannot see) and avoids binary output passing through the shell (PowerShell 5.1 corrupts binary redirection).

### bash

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$(pwd)/backups/${STAMP}"          # Git Bash: DEST="$(pwd -W)/backups/${STAMP}"
mkdir -p "${DEST}/minio"
PGPW="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
MINIO_USER="$(grep '^MINIO_ROOT_USER=' .env | cut -d= -f2-)"
MINIO_PW="$(grep '^MINIO_ROOT_PASSWORD=' .env | cut -d= -f2-)"

# PostgreSQL: custom format, all schemas, owners and grants included
docker compose run --rm --no-deps -e PGPASSWORD="${PGPW}" -v "${DEST}:/backup" \
  --entrypoint pg_dump postgres -h postgres -U postgres -d sathi -Fc -Z 6 --no-comments -f /backup/sathi.dump

# Check the dump is readable (lists schemas, extensions, tables)
docker compose run --rm --no-deps -v "${DEST}:/backup:ro" --entrypoint pg_restore postgres --list /backup/sathi.dump | head -n 20

# MinIO: mirror the bucket with the mc image used by minio-init (same network, same credentials)
docker compose run --rm --no-deps \
  -e MC_HOST_sathi="http://${MINIO_USER}:${MINIO_PW}@minio:9000" \
  -v "${DEST}/minio:/backup" \
  --entrypoint mc minio-init mirror --overwrite --preserve sathi/sathi-documents /backup/sathi-documents

# Checksums
( cd "${DEST}" && find . -type f ! -name SHA256SUMS -print0 | xargs -0 sha256sum > SHA256SUMS )
```

### PowerShell

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$dest  = Join-Path $PWD "backups\$stamp"
New-Item -ItemType Directory -Force "$dest\minio" | Out-Null
$envs  = Get-Content .env | Where-Object { $_ -match '^[A-Z_]+=' } | ConvertFrom-StringData

docker compose run --rm --no-deps -e "PGPASSWORD=$($envs.POSTGRES_PASSWORD)" -v "${dest}:/backup" `
  --entrypoint pg_dump postgres -h postgres -U postgres -d sathi -Fc -Z 6 --no-comments -f /backup/sathi.dump

docker compose run --rm --no-deps `
  -e "MC_HOST_sathi=http://$($envs.MINIO_ROOT_USER):$($envs.MINIO_ROOT_PASSWORD)@minio:9000" `
  -v "${dest}\minio:/backup" `
  --entrypoint mc minio-init mirror --overwrite --preserve sathi/sathi-documents /backup/sathi-documents

Get-ChildItem -Recurse -File $dest | Get-FileHash -Algorithm SHA256 | Out-File "$dest\SHA256SUMS.txt"
```

(`ConvertFrom-StringData` treats `\` as an escape character; generated secrets are hex/base64 and safe.)

`backups/` is git- and docker-ignored; in real use keep backups outside the repository and encrypt anything that leaves the machine. Role passwords are not in the dump — they come from the secret store / `.env`.

## 2. Restore

Restore into an **empty** database so the init script creates roles, schemas and extensions with the passwords from the current `.env`, then load the data.

```bash
DEST="$(pwd)/backups/<STAMP>"           # Git Bash: "$(pwd -W)/backups/<STAMP>"
PGPW="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
MINIO_USER="$(grep '^MINIO_ROOT_USER=' .env | cut -d= -f2-)"
MINIO_PW="$(grep '^MINIO_ROOT_PASSWORD=' .env | cut -d= -f2-)"

# 1. Stop writers
docker compose stop web api jobs ai-service ai-ingest

# 2. Fresh database volume (the init script runs on first start)
docker compose rm -sf postgres
docker volume rm sathi_postgres-data            # <project>_postgres-data
docker compose up -d --wait postgres

# 3. Load the dump. Schemas/extensions already exist (init script), so --clean --if-exists
#    replaces them; ownership returns to sathi_app / sathi_ai / sathi_hangfire.
docker compose run --rm --no-deps -e PGPASSWORD="${PGPW}" -v "${DEST}:/backup:ro" \
  --entrypoint pg_restore postgres -h postgres -U postgres -d sathi \
  --clean --if-exists --exit-on-error --single-transaction /backup/sathi.dump

# 4. Re-apply grants and search paths (idempotent). PGPASSWORD is needed because
#    local socket auth is scram-sha-256.
docker compose exec -T -e PGPASSWORD="${PGPW}" postgres bash /docker-entrypoint-initdb.d/01-init.sh

# 5. Objects: wipe-and-mirror back into the bucket (minio-init recreates it if missing)
docker compose up -d --wait minio minio-init
docker compose run --rm --no-deps \
  -e MC_HOST_sathi="http://${MINIO_USER}:${MINIO_PW}@minio:9000" \
  -v "${DEST}/minio:/backup:ro" \
  --entrypoint mc minio-init mirror --overwrite --preserve /backup/sathi-documents sathi/sathi-documents

# 6. Start everything (migrators run and are no-ops when the schema is current)
docker compose up -d --wait
```

## 3. Verify a restore (do this, a backup is only real once restored)

```bash
PGPW="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
q() { docker compose exec -T -e PGPASSWORD="${PGPW}" postgres psql -U postgres -d sathi -Atc "$1"; }
q "select count(*) from app.users"
q "select count(*) from app.documents where deleted_at is null and status = 'ready'"
q "select count(*) from ai.document_chunks"
q "select count(*) from ai.chunk_embeddings"
q "select nspname, pg_get_userbyid(nspowner) from pg_namespace where nspname in ('app','ai','hangfire')"
q "select extname, extversion from pg_extension"
docker compose run --rm --no-deps --entrypoint sh minio-init -c \
  'mc alias set s http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc du s/sathi-documents'
```

Then sign in, open a conversation (history present), ask the tutor about an uploaded note (retrieval works → embeddings restored) and open an uploaded file's status (object present).

## 4. Notes

- **Deletion and backups:** data deleted through `DELETE /me` / document delete stays in older backups until they expire. Keep backup retention short and documented (DPDP Act: erase on request "unless retention is required by law"); never restore a backup without re-running pending deletions — after a restore, check `app.outbox_messages` and re-run `ProcessOutboxJob`, and re-apply deletions recorded in `app.audit_events` (`user.delete_requested`, `document.delete`) after the backup time.
- **Hangfire:** restoring `hangfire` brings back queued jobs from backup time; jobs are idempotent, but review the dashboard before starting `jobs`.
- **Embeddings model:** chunks are tied to `EMBEDDING_MODEL`; restoring into a stack configured with a different model requires the re-embedding job (ADR 0004).
- **Managed Postgres:** use the provider's PITR for disasters; use `pg_dump`/`pg_restore` (same commands, `-h <server>` and `sslmode=require`) for pre-migration copies and environment clones. The admin role there is not a true superuser: restore with `--no-owner --role=<owner>` per schema if ownership changes fail.
