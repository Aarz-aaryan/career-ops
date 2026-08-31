#!/usr/bin/env bash
# cleanup-orphan-rows.sh — Run the orphan-row cleanup PHP inside the nextcloud container.
#
# Usage: bash cleanup-orphan-rows.sh [table_id] [--dry-run]
#   default table_id = 8
#   --dry-run: report what would be deleted without deleting

set -euo pipefail

NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-22}"
NC_USER="${NC_SSH_USER:-r-server}"

if [ -n "${NC_PASS:-}" ] && command -v sshpass >/dev/null 2>&1; then
  SSH=(sshpass -p "$NC_PASS" ssh -p "$NC_PORT" -o StrictHostKeyChecking=no "${NC_USER}@${NC_HOST}")
  SCP=(sshpass -p "$NC_PASS" scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
else
  SSH=(ssh -p "$NC_PORT" -o StrictHostKeyChecking=no -o BatchMode=yes "${NC_USER}@${NC_HOST}")
  SCP=(scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
fi

LOCAL_PHP="$(dirname "$0")/cleanup-orphan-rows.php"
REMOTE_PHP="/tmp/cleanup-orphan-rows.php"

# Push the PHP script
"${SCP[@]}" "$LOCAL_PHP" "${NC_USER}@${NC_HOST}:${REMOTE_PHP}" >/dev/null

# Run inside the nextcloud container, pass through all args
"${SSH[@]}" "docker cp $REMOTE_PHP nextcloud:/tmp/ && docker exec nextcloud php /tmp/cleanup-orphan-rows.php $*"
