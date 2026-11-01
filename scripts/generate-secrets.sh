#!/usr/bin/env bash
# Create (or upgrade) .env from .env.example, replacing every placeholder with a fresh value:
#   __GENERATE__                       -> 48 hex chars (safe in URLs and connection strings)
#   __GENERATE_BASE64__                -> 32 random bytes, base64
#   __GENERATE_PASSWORD__              -> login password that satisfies the Sathi password policy
#   __GENERATE_RSA_PRIVATE_PEM_B64__   -> base64 of a 2048-bit RSA private key, PKCS#8 PEM  } one key pair
#   __GENERATE_RSA_PUBLIC_PEM_B64__    -> base64 of the matching public key, SPKI PEM      } (openssl)
#
# Usage: scripts/generate-secrets.sh [--add-missing | --force] [--output PATH]
#   (no flag)      create PATH (default .env); refuses to overwrite an existing file
#   --add-missing  upgrade an existing file: keep every value, append only the variables that are
#                  missing (with fresh values), fill leftover placeholders, drop obsolete variables.
#                  DB passwords and other existing secrets are NOT rotated. A backup is kept.
#   --force        re-create PATH from scratch (rotates every secret)
# Prints variable names only, never values.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${ROOT}/.env.example"
OUTPUT="${ROOT}/.env"
FORCE=0
ADD_MISSING=0

# Variables removed by a release. --add-missing deletes them (and their stock comment line).
OBSOLETE_VARS=(SERVICE_TOKEN_SECRET)
OBSOLETE_COMMENTS=("# HS256 key for the api/jobs -> ai-service token. >= 32 random bytes, base64.")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f) FORCE=1; shift ;;
    --add-missing|-a) ADD_MISSING=1; shift ;;
    --output|-o) OUTPUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ ${FORCE} -eq 1 && ${ADD_MISSING} -eq 1 ]]; then
  echo "--force and --add-missing are mutually exclusive" >&2; exit 2
fi
if [[ ${ADD_MISSING} -eq 1 && ! -f "${OUTPUT}" ]]; then
  echo "${OUTPUT} does not exist - creating it from scratch."
  ADD_MISSING=0
fi
if [[ ${ADD_MISSING} -eq 0 && -f "${OUTPUT}" && ${FORCE} -eq 0 ]]; then
  echo "${OUTPUT} already exists." >&2
  echo "  Upgrade it (keeps existing secrets):  scripts/generate-secrets.sh --add-missing" >&2
  echo "  Re-create it (rotates every secret; an existing Postgres volume keeps the OLD role" >&2
  echo "  passwords - run scripts/reset-db.sh afterwards):  scripts/generate-secrets.sh --force" >&2
  exit 1
fi

rand_bytes() { head -c "$1" /dev/urandom; }
hex() { rand_bytes 24 | od -An -tx1 | tr -d ' \n'; }
b64() { rand_bytes 32 | base64 | tr -d '\r\n'; }
password() { printf 'Sa%s!7' "$(rand_bytes 12 | od -An -tx1 | tr -d ' \n')"; }

RSA_PRIVATE_B64=""
RSA_PUBLIC_B64=""
generate_rsa_pair() {
  command -v openssl >/dev/null 2>&1 || { echo "openssl is required to generate the service-token key pair" >&2; exit 1; }
  local pem
  # genpkey writes PKCS#8 ("BEGIN PRIVATE KEY"); `pkey -pubout` writes SPKI ("BEGIN PUBLIC KEY").
  # tr -d '\r': PEM with LF line endings everywhere (openssl on Windows writes CRLF).
  pem="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | tr -d '\r')"
  [[ "${pem}" == "-----BEGIN PRIVATE KEY-----"* ]] || { echo "openssl did not produce a PKCS#8 key" >&2; exit 1; }
  RSA_PRIVATE_B64="$(printf '%s\n' "${pem}" | base64 | tr -d '\r\n')"
  RSA_PUBLIC_B64="$(printf '%s\n' "${pem}" | openssl pkey -pubout 2>/dev/null | tr -d '\r' | base64 | tr -d '\r\n')"
  [[ -n "${RSA_PUBLIC_B64}" ]] || { echo "openssl could not derive the public key" >&2; exit 1; }
}

is_placeholder() { [[ "$1" =~ ^__GENERATE[A-Z0-9_]*__$ ]]; }

# Value for a placeholder. RSA values come from the pair generated beforehand (not in a subshell).
value_for() {
  case "$1" in
    __GENERATE_BASE64__) b64 ;;
    __GENERATE_PASSWORD__) password ;;
    __GENERATE_RSA_PRIVATE_PEM_B64__) printf '%s' "${RSA_PRIVATE_B64}" ;;
    __GENERATE_RSA_PUBLIC_PEM_B64__) printf '%s' "${RSA_PUBLIC_B64}" ;;
    *) hex ;;
  esac
}

KEY_RE='^([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
PRIV_VAR=SERVICE_TOKEN_PRIVATE_KEY_PEM_B64
PUB_VAR=SERVICE_TOKEN_PUBLIC_KEY_PEM_B64

tmp="$(mktemp "${OUTPUT}.tmp.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT
chmod 600 "${tmp}" 2>/dev/null || true

if [[ ${ADD_MISSING} -eq 0 ]]; then
  # ------------------------------------------------------------------ create
  generate_rsa_pair
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    if [[ "${line}" =~ ${KEY_RE} ]]; then
      k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"   # is_placeholder overwrites BASH_REMATCH
      if is_placeholder "${v}"; then line="${k}=$(value_for "${v}")"; fi
    fi
    printf '%s\n' "${line}" >> "${tmp}"
  done < "${TEMPLATE}"
  mv "${tmp}" "${OUTPUT}"
  trap - EXIT
  chmod 600 "${OUTPUT}" 2>/dev/null || true
  echo "Wrote ${OUTPUT}"
  echo "Admin login: $(grep '^SEED_ADMIN_EMAIL=' "${OUTPUT}" | cut -d= -f2-) / (see SEED_ADMIN_PASSWORD in .env)"
  echo "LLM mode: fake (set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic in .env for real Claude)"
  exit 0
fi

# -------------------------------------------------------------------- add missing
# (bash 3.2 compatible: no associative arrays / mapfile, for macOS' stock bash)
existing_keys="$(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "${OUTPUT}")"
has_key() { grep -qx -- "$1" <<< "${existing_keys}"; }
get_value() { sed -n "s/^$1=//p" "${OUTPUT}" | tr -d '\r' | head -n 1; }

# The key pair is replaced as a unit whenever either half is missing, empty or still a placeholder.
rotate_pair=0
for v in "${PRIV_VAR}" "${PUB_VAR}"; do
  val="$(get_value "${v}")"
  if ! has_key "${v}" || [[ -z "${val}" ]] || is_placeholder "${val}"; then rotate_pair=1; fi
done
if [[ ${rotate_pair} -eq 1 ]]; then generate_rsa_pair; fi

added=() filled=() removed=()
while IFS= read -r line || [[ -n "${line}" ]]; do
  line="${line%$'\r'}"
  skip=0
  for c in "${OBSOLETE_COMMENTS[@]}"; do [[ "${line}" == "${c}" ]] && skip=1; done
  if [[ "${line}" =~ ${KEY_RE} ]]; then
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    for o in "${OBSOLETE_VARS[@]}"; do
      if [[ "${k}" == "${o}" ]]; then skip=1; removed+=("${k}"); fi
    done
    if [[ ${skip} -eq 0 ]]; then
      if [[ ${rotate_pair} -eq 1 && "${k}" == "${PRIV_VAR}" ]]; then line="${k}=${RSA_PRIVATE_B64}"; filled+=("${k}")
      elif [[ ${rotate_pair} -eq 1 && "${k}" == "${PUB_VAR}" ]]; then line="${k}=${RSA_PUBLIC_B64}"; filled+=("${k}")
      elif is_placeholder "${v}"; then line="${k}=$(value_for "${v}")"; filled+=("${k}")
      fi
    fi
  fi
  if [[ ${skip} -eq 0 ]]; then printf '%s\n' "${line}" >> "${tmp}"; fi
done < "${OUTPUT}"

# Append template variables that are missing, each with the comment block that precedes it.
comments=()
header_written=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  line="${line%$'\r'}"
  if [[ "${line}" == \#* ]]; then comments+=("${line}"); continue; fi
  if [[ "${line}" =~ ${KEY_RE} ]]; then
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    if ! has_key "${k}"; then
      if [[ ${header_written} -eq 0 ]]; then
        printf '\n# ==== Added by scripts/generate-secrets --add-missing on %s ====\n' "$(date -u +%Y-%m-%d)" >> "${tmp}"
        header_written=1
      fi
      if [[ ${#comments[@]} -gt 0 ]]; then printf '%s\n' "${comments[@]}" >> "${tmp}"; fi
      if [[ "${k}" == "${PRIV_VAR}" ]]; then v="${RSA_PRIVATE_B64}"
      elif [[ "${k}" == "${PUB_VAR}" ]]; then v="${RSA_PUBLIC_B64}"
      elif is_placeholder "${v}"; then v="$(value_for "${v}")"
      fi
      printf '%s=%s\n' "${k}" "${v}" >> "${tmp}"
      added+=("${k}")
    fi
  fi
  comments=()
done < "${TEMPLATE}"

if [[ ${#added[@]} -eq 0 && ${#filled[@]} -eq 0 && ${#removed[@]} -eq 0 ]]; then
  echo "${OUTPUT} is up to date - nothing changed."
  exit 0
fi

backup="${OUTPUT}.bak-$(date +%Y%m%d%H%M%S)"
cp -p "${OUTPUT}" "${backup}"
chmod 600 "${backup}" 2>/dev/null || true
mv "${tmp}" "${OUTPUT}"
trap - EXIT
chmod 600 "${OUTPUT}" 2>/dev/null || true

echo "Updated ${OUTPUT} (backup: ${backup})"
if [[ ${#added[@]} -gt 0 ]]; then echo "  added:     ${added[*]}"; fi
if [[ ${#filled[@]} -gt 0 ]]; then echo "  generated: ${filled[*]}"; fi
if [[ ${#removed[@]} -gt 0 ]]; then echo "  removed:   ${removed[*]} (obsolete)"; fi
echo "Existing values (database passwords, MinIO root, salts) were kept."
echo "Apply with: docker compose up -d --build   (minio-init creates the storage users on start)"
