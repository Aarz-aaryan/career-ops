#!/usr/bin/env bash
# write_row.sh — bash wrapper that invokes write_row.php via SSH into the nextcloud container
# This script is a wrapper to keep the auto-pipeline mode's `bash scripts/write_row.sh ...` working.
# Real logic lives in scripts/write_row.php (which runs inside the nextcloud container on r-server).

set -euo pipefail

# Load creds from hermes env if present
if [ -f "$HOME/.hermes/profiles/aarz/.env" ]; then
  set +e
  source "$HOME/.hermes/profiles/aarz/.env" 2>/dev/null
  set -e
fi

NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-22}"
NC_USER="${NC_SSH_USER:-r-server}"
NC_PASS="${NC_PASS:-aarz1947}"

SCRIPT_PATH="/tmp/write_row.php"

# Push the PHP script to r-server (idempotent — only if newer or missing)
sshpass -p "$NC_PASS" ssh -p "$NC_PORT" -o StrictHostKeyChecking=no "${NC_USER}@${NC_HOST}" \
  "[ -f /tmp/write_row.php ] && [ /tmp/write_row.php -nt /dev/null ]" 2>/dev/null || \
  sshpass -p "$NC_PASS" scp -P "$NC_PORT" -o StrictHostKeyChecking=no \
    "$(dirname "$0")/write_row.php" "${NC_USER}@${NC_HOST}:/tmp/write_row.php"

# Build args JSON to avoid shell-quote headaches with empty/special chars
JSON_FILE=$(mktemp /tmp/write_row_args.XXXXXX.json)
COMPANY="${1:-}"
ROLE="${2:-}"
JOB_URL="${3:-}"
PDF_URL="${4:-}"
SCORE="${5:-4.0}"
TIER="${6:-2}"
SOURCE="${7:-6}"
NOTES="${8:-}"
cat > "$JSON_FILE" <<JSONEOF
{"company":$(printf '%s' "$COMPANY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),"role":$(printf '%s' "$ROLE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),"jobUrl":$(printf '%s' "$JOB_URL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),"pdfUrl":$(printf '%s' "$PDF_URL" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),"fitScore":$SCORE,"tier":$TIER,"source":$SOURCE,"notes":$(printf '%s' "$NOTES" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}
JSONEOF

# Copy JSON to r-server and run PHP inside the nextcloud container
sshpass -p "$NC_PASS" scp -P "$NC_PORT" -o StrictHostKeyChecking=no \
  "$JSON_FILE" "${NC_USER}@${NC_HOST}:/tmp/write_row_args.json" >/dev/null

sshpass -p "$NC_PASS" ssh -p "$NC_PORT" -o StrictHostKeyChecking=no "${NC_USER}@${NC_HOST}" \
  "docker cp /tmp/write_row_args.json nextcloud:/tmp/ && docker exec nextcloud php /tmp/write_row.php --json /tmp/write_row_args.json"

RC=$?
rm -f "$JSON_FILE"
exit $RC
