#!/usr/bin/env bash
# write_row.sh — Local wrapper that calls scripts/write_row.php on r-server via docker exec.
#
# ROOT-CAUSE FIX (2026-08-28 round-49): The previous cron prompt had the cron agent
# write a /tmp PHP file each run and SSH it to r-server — fragile, with empty-string
# arg escaping issues. This wrapper:
#   1. Builds a JSON args file locally
#   2. Pushes the canonical write_row.php into the nextcloud container (MD5-cached)
#   3. Pushes the JSON args file into the container
#   4. Calls docker exec -i nextcloud php write_row.php --json <file>
#      The `-i` (interactive TTY) is REQUIRED — without it docker exec drops stdout
#      when invoked via SSH without a TTY. With `-i` stdout flows through cleanly.
#
# Usage:
#   write_row.sh "Company" "Role" "JobUrl" "PdfUrl" "Score" "Tier" "Source" ["Notes"]
#
# Exit codes: 0 = success, 1 = SSH/PHP failure, 2 = critical column missing.
#
# Creds: read from ~/.hermes/profiles/aarz/.env (NC_HOST/NC_PORT).
# SSH: uses sshpass with r-server creds (NC_SSHPASS or hardcoded fallback).

set -euo pipefail

if [ "$#" -lt 7 ]; then
    echo "Usage: write_row.sh COMPANY ROLE JOB_URL PDF_URL FIT_SCORE TIER SOURCE [NOTES]" >&2
    exit 1
fi

# Load creds
if [ -f "$HOME/.hermes/profiles/aarz/.env" ]; then
    set +e
    source "$HOME/.hermes/profiles/aarz/.env" 2>/dev/null
    set -e
fi

RHOST="${NC_SSH_HOST:-r-server@100.84.224.18}"
RSSH="${NC_SSHPASS:-aarz1947}"
PHP_LOCAL="/home/Aarz/career-ops/scripts/write_row.php"

# --- Build JSON args file locally ---
ARGS_JSON=$(mktemp --suffix=.json)
trap "rm -f $ARGS_JSON" EXIT

python3 - "$@" > "$ARGS_JSON" <<'PYEOF'
import json, sys
keys = ['company', 'role', 'jobUrl', 'pdfUrl', 'fitScore', 'tier', 'source', 'notes']
out = {}
for i, k in enumerate(keys):
    if i + 1 < len(sys.argv):
        v = sys.argv[i + 1]
        if k == 'fitScore':
            try:
                v = float(v)
            except (ValueError, TypeError):
                v = 0.0
        elif k in ('tier', 'source'):
            try:
                v = int(v)
            except (ValueError, TypeError):
                v = 1 if k == 'tier' else 6
        out[k] = v
print(json.dumps(out))
PYEOF

# --- Step 1: Push PHP script into nextcloud container (MD5-cached) ---
# Pattern: write to host /tmp/, scp to r-server /tmp/, then docker cp into container.
# The host /tmp/ and r-server /tmp/ are DIFFERENT filesystems (r-server is over SSH).
# The r-server /tmp/ and nextcloud container /tmp/ are also DIFFERENT filesystems.

LOCAL_MD5=$(md5sum "$PHP_LOCAL" 2>/dev/null | cut -d' ' -f1)
CONTAINER_PHP_MD5=$(sshpass -p "$RSSH" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
    "$RHOST" "docker exec nextcloud md5sum /tmp/write_row.php 2>/dev/null" 2>/dev/null | cut -d' ' -f1 || echo "")

if [ "$LOCAL_MD5" != "$CONTAINER_PHP_MD5" ]; then
    echo "[write_row.sh] pushing PHP script → nextcloud:/tmp/write_row.php"
    HOST_PHP_STAGING="/tmp/write_row_php_$$.php"
    cp "$PHP_LOCAL" "$HOST_PHP_STAGING"
    sshpass -p "$RSSH" scp -o StrictHostKeyChecking=no "$HOST_PHP_STAGING" "$RHOST:$HOST_PHP_STAGING"
    sshpass -p "$RSSH" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 "$RHOST" \
        "docker cp $HOST_PHP_STAGING nextcloud:/tmp/write_row.php && docker exec nextcloud chmod 644 /tmp/write_row.php && rm -f $HOST_PHP_STAGING"
fi

# --- Step 2: Push JSON args file into container ---
REMOTE_ARGS="/tmp/write_row_args_$$.json"
HOST_ARGS_STAGING="/tmp/write_row_args_$$.json"
cp "$ARGS_JSON" "$HOST_ARGS_STAGING"
sshpass -p "$RSSH" scp -o StrictHostKeyChecking=no "$HOST_ARGS_STAGING" "$RHOST:$HOST_ARGS_STAGING"
sshpass -p "$RSSH" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 "$RHOST" \
    "docker cp $HOST_ARGS_STAGING nextcloud:$REMOTE_ARGS && docker exec nextcloud chmod 644 $REMOTE_ARGS && rm -f $HOST_ARGS_STAGING"

# --- Step 3: Execute PHP inside nextcloud container ---
# MUST use `docker exec -i` (interactive TTY) — without -i, docker exec drops stdout
# when invoked via SSH without a TTY. This is the critical fix from the wrapper v6
# debugging cycle (round-49 root-cause audit 2026-08-28).
OUT=$(sshpass -p "$RSSH" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -tt "$RHOST" \
    "docker exec -i nextcloud php /tmp/write_row.php --json $REMOTE_ARGS" 2>&1)
RC=$?

# Cleanup args file inside container
sshpass -p "$RSSH" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$RHOST" \
    "docker exec nextcloud rm -f $REMOTE_ARGS" 2>/dev/null

echo "$OUT"

if [ "$RC" -ne 0 ]; then
    echo "[write_row.sh] remote PHP exit=$RC" >&2
    exit "$RC"
fi