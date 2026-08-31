#!/usr/bin/env bash
# delete-rows.sh — Delete specific Nextcloud Tables rows.
# Usage: bash delete-rows.sh --pattern "REGEX"
#        bash delete-rows.sh "Company1" "Company2" ...

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

LOCAL_PHP="$(dirname "$0")/delete-rows.php"
REMOTE_PHP="/tmp/delete-rows.php"

"${SCP[@]}" "$LOCAL_PHP" "${NC_USER}@${NC_HOST}:${REMOTE_PHP}" >/dev/null
# Quote the args properly when shell-piping to remote
QUOTED_ARGS=""
for arg in "$@"; do
    QUOTED_ARGS+=" $(printf '%q' "$arg")"
done
"${SSH[@]}" "docker cp $REMOTE_PHP nextcloud:/tmp/ && docker exec nextcloud php /tmp/delete-rows.php$QUOTED_ARGS"
