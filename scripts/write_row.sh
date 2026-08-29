#!/usr/bin/env bash
# write_row.sh — bash wrapper that invokes write_row.php via SSH into the nextcloud container.
# Real logic lives in scripts/write_row.php.
#
# Uses SSH key auth first (works without sshpass), falls back to sshpass if NC_PASS is set.
# Args: $1=company $2=role $3=jobUrl $4=pdfUrl $5=fitScore $6=tier $7=source $8=notes

set -euo pipefail

NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-22}"
NC_USER="${NC_SSH_USER:-r-server}"
NC_PASS="${NC_PASS:-}"

# Build SSH/SCP args based on whether we have a password or key
if [ -n "$NC_PASS" ] && command -v sshpass >/dev/null 2>&1; then
  SSH_CMD=(sshpass -p "$NC_PASS" ssh -p "$NC_PORT" -o StrictHostKeyChecking=no "${NC_USER}@${NC_HOST}")
  SCP_CMD=(sshpass -p "$NC_PASS" scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
else
  SSH_CMD=(ssh -p "$NC_PORT" -o StrictHostKeyChecking=no -o BatchMode=yes "${NC_USER}@${NC_HOST}")
  SCP_CMD=(scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
fi

SCRIPT_PATH_REMOTE="/tmp/write_row.php"

# Push PHP script (only if local is newer)
LOCAL_PHP="$(dirname "$0")/write_row.php"
NEED_PUSH=1
if "${SSH_CMD[@]}" "[ -f $SCRIPT_PATH_REMOTE ]" 2>/dev/null; then
  REMOTE_MTIME=$("${SSH_CMD[@]}" "stat -c %Y $SCRIPT_PATH_REMOTE 2>/dev/null" || echo 0)
  LOCAL_MTIME=$(stat -c %Y "$LOCAL_PHP" 2>/dev/null || echo 0)
  if [ "${REMOTE_MTIME:-0}" -ge "$LOCAL_MTIME" ]; then
    NEED_PUSH=0
  fi
fi
if [ "$NEED_PUSH" = "1" ]; then
  "${SCP_CMD[@]}" "$LOCAL_PHP" "${NC_USER}@${NC_HOST}:${SCRIPT_PATH_REMOTE}" >/dev/null 2>&1 || true
fi

# Build args JSON via python (avoids shell quoting issues)
ARGS_FILE=$(mktemp /tmp/write_row_args.XXXXXX.json)
COMPANY="${1:-}"
ROLE="${2:-}"
JOB_URL="${3:-}"
PDF_URL="${4:-}"
SCORE="${5:-4.0}"
TIER="${6:-2}"
SOURCE="${7:-6}"
NOTES="${8:-}"

python3 - "$ARGS_FILE" "$COMPANY" "$ROLE" "$JOB_URL" "$PDF_URL" "$SCORE" "$TIER" "$SOURCE" "$NOTES" <<'PYEOF'
import json, sys
path, company, role, job_url, pdf_url, score, tier, source, notes = sys.argv[1:]
data = {
  "company": company, "role": role,
  "jobUrl": job_url, "pdfUrl": pdf_url,
  "fitScore": float(score),
  "tier": int(tier), "source": int(source),
  "notes": notes,
}
with open(path, 'w') as f:
  json.dump(data, f)
PYEOF

# SCP the JSON
REMOTE_ARGS="/tmp/write_row_args.json"
"${SCP_CMD[@]}" "$ARGS_FILE" "${NC_USER}@${NC_HOST}:${REMOTE_ARGS}" >/dev/null 2>&1

# Execute inside the nextcloud container
"${SSH_CMD[@]}" "docker cp $REMOTE_ARGS nextcloud:/tmp/ && docker exec nextcloud php $SCRIPT_PATH_REMOTE --json /tmp/write_row_args.json"

RC=$?
rm -f "$ARGS_FILE"
exit $RC