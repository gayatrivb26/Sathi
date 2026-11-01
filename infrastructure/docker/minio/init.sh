#!/bin/sh
# minio-init (one-shot, idempotent): bucket + per-service users and policies.
# Contract: docs/architecture/contracts.md §11.8, ADR 0016.
#
#   user (env)                                     policy               used by
#   STORAGE_APP_ACCESS_KEY / STORAGE_APP_SECRET_KEY  sathi-app-storage    api, jobs
#   STORAGE_AI_ACCESS_KEY  / STORAGE_AI_SECRET_KEY   sathi-ai-storage     ai-service, ai-ingest
#
# The root account (MINIO_ROOT_USER/PASSWORD) is used only here and by the minio server itself.
# Re-running is safe: the bucket is kept, policies are re-applied from the JSON files, user
# secrets are reset to the values in .env, and each user ends with exactly its one policy.
# Secrets are never echoed.
set -eu

BUCKET="${STORAGE_BUCKET:-sathi-documents}"
POLICY_DIR="${POLICY_DIR:-/policies}"

fail() { echo "minio-init: $*" >&2; exit 1; }

for v in MINIO_ROOT_USER MINIO_ROOT_PASSWORD STORAGE_APP_ACCESS_KEY STORAGE_APP_SECRET_KEY STORAGE_AI_ACCESS_KEY STORAGE_AI_SECRET_KEY; do
  eval "val=\${${v}:-}"
  # shellcheck disable=SC2154
  [ -n "${val}" ] || fail "${v} is empty (run scripts/generate-secrets --add-missing)"
done
[ "${STORAGE_APP_ACCESS_KEY}" != "${MINIO_ROOT_USER}" ] || fail "STORAGE_APP_ACCESS_KEY must differ from MINIO_ROOT_USER"
[ "${STORAGE_AI_ACCESS_KEY}" != "${MINIO_ROOT_USER}" ] || fail "STORAGE_AI_ACCESS_KEY must differ from MINIO_ROOT_USER"
[ "${STORAGE_APP_ACCESS_KEY}" != "${STORAGE_AI_ACCESS_KEY}" ] || fail "STORAGE_APP_ACCESS_KEY and STORAGE_AI_ACCESS_KEY must differ"
[ "${#STORAGE_APP_SECRET_KEY}" -ge 8 ] || fail "STORAGE_APP_SECRET_KEY must be at least 8 characters"
[ "${#STORAGE_AI_SECRET_KEY}" -ge 8 ] || fail "STORAGE_AI_SECRET_KEY must be at least 8 characters"

mc alias set sathi http://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null

mc mb --ignore-existing "sathi/${BUCKET}"
mc anonymous set none "sathi/${BUCKET}" >/dev/null
mc version enable "sathi/${BUCKET}" >/dev/null 2>&1 || true
# Versioning protects against accidental overwrites, but erasure must be real (DPDP "delete my data"):
# noncurrent versions and orphaned delete markers are purged after 1 day. `ilm import` replaces the whole
# lifecycle configuration, so re-running stays idempotent.
mc ilm import "sathi/${BUCKET}" < "${POLICY_DIR}/lifecycle.json" >/dev/null

# Policies: `policy create` overwrites an existing policy of the same name.
mc admin policy create sathi sathi-app-storage "${POLICY_DIR}/app-storage-policy.json" >/dev/null
mc admin policy create sathi sathi-ai-storage "${POLICY_DIR}/ai-storage-policy.json" >/dev/null

# ensure_user <access-key> <secret-key> <policy>
ensure_user() {
  # `user add` creates the user or resets the secret of an existing one.
  mc admin user add sathi "$1" "$2" >/dev/null
  # Detach every other policy so the user holds exactly one. The mc image has no sed/grep/tr,
  # so the comma-separated "policyName" value is cut out of the JSON with parameter expansion.
  info="$(mc admin user info sathi "$1" --json)"
  current=""
  case "${info}" in
    *'"policyName"'*)
      rest="${info#*\"policyName\":}"; rest="${rest# }"; rest="${rest#\"}"
      current="${rest%%\"*}" ;;
  esac
  attached=0
  old_ifs="${IFS}"; IFS=','
  for p in ${current}; do
    IFS="${old_ifs}"
    if [ "${p}" = "$3" ]; then attached=1; continue; fi
    [ -n "${p}" ] && mc admin policy detach sathi "${p}" --user "$1" >/dev/null
  done
  IFS="${old_ifs}"
  if [ "${attached}" -eq 0 ]; then
    mc admin policy attach sathi "$3" --user "$1" >/dev/null
  fi
  echo "minio-init: user ${1} -> policy ${3}"
}

ensure_user "${STORAGE_APP_ACCESS_KEY}" "${STORAGE_APP_SECRET_KEY}" sathi-app-storage
ensure_user "${STORAGE_AI_ACCESS_KEY}" "${STORAGE_AI_SECRET_KEY}" sathi-ai-storage

echo "minio-init: bucket ${BUCKET} ready (private), service users configured"
