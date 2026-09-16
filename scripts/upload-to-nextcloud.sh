#!/usr/bin/env bash
# upload-to-nextcloud.sh — Upload a PDF to Aaryan's Nextcloud via WebDAV
#
# Usage: upload-to-nextcloud.sh <path-to-pdf> [custom-remote-name]
#
# Reads NC_USER + NC_PASS from ~/.hermes/profiles/aarz/.env (matches NC_USER / NC_PASS
# already exported by the Hermes shell). No credential fallback lives in this repo.
#
# Why this exists: round-12 was the first time Aaryan had to upload a fresh-build
# PDF to Nextcloud. Prior rounds (1-11) uploaded PDFs manually via the Nextcloud web
# UI. This script automates the upload via WebDAV so future rounds can deliver PDFs
# end-to-end without manual steps.
#
# Verified 2026-07-31: WebDAV endpoint at http://100.84.224.18:9080/remote.php/dav/
# (port 9080 = nextcloud container's exposed port). NC_USER + NC_PASS from
# ~/.hermes/profiles/aarz/.env. Returns HTTP 201 on success.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_nc-creds.sh"

# Load creds from hermes env if present
if [ -f "$HOME/.hermes/profiles/aarz/.env" ]; then
  set +e
  source "$HOME/.hermes/profiles/aarz/.env" 2>/dev/null
  set -e
fi

NC_USER="${NC_USER:?NC_USER not set -- add it to ~/.hermes/profiles/aarz/.env}"
NC_PASS="${NC_PASS:?NC_PASS not set -- add it to ~/.hermes/profiles/aarz/.env}"
NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-9080}"
NC_BASE="${NC_BASE:-/remote.php/dav/files/${NC_USER}}"

PDF_PATH="${1:?Usage: upload-to-nextcloud.sh <path-to-pdf> [custom-remote-name]}"
# ROUND-67 (2026-09-16): default to Career-ops/Resumes, NOT the account root.
# This defaulted to a bare basename, so any caller that did not pass an explicit
# destination dropped the PDF straight into the top level of Aaryan's Nextcloud
# -- 87 resumes ended up sitting next to College/, Photos/, Notes/ and Deck/.
NC_RESUME_DIR="${NC_RESUME_DIR:-Career-ops/Resumes}"
REMOTE_NAME="${2:-${NC_RESUME_DIR}/$(basename "$PDF_PATH")}"

if [ ! -f "$PDF_PATH" ]; then
  echo "ERROR: file not found: $PDF_PATH" >&2
  exit 1
fi

URL="http://${NC_HOST}:${NC_PORT}${NC_BASE}/${REMOTE_NAME}"

# Create the destination folder if it is missing. MKCOL is idempotent -- 201 when
# created, 405 when it already exists -- so this is safe to run on every upload.
REMOTE_DIR="$(dirname "$REMOTE_NAME")"
if [ "$REMOTE_DIR" != "." ] && [ -n "$REMOTE_DIR" ]; then
  _acc=""
  IFS='/' read -ra _parts <<< "$REMOTE_DIR"
  for _p in "${_parts[@]}"; do
    _acc="${_acc:+$_acc/}$_p"
    curl -s -o /dev/null -X MKCOL -u "${NC_USER}:${NC_PASS}" \
      "http://${NC_HOST}:${NC_PORT}${NC_BASE}/${_acc}" || true
  done
fi

echo "=== Uploading ==="
echo "Local:  $PDF_PATH"
echo "Remote: $URL"
echo ""

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "${NC_USER}:${NC_PASS}" \
  -X PUT \
  --data-binary "@${PDF_PATH}" \
  "$URL")

# WebDAV HTTP codes:
#   201 = created (new file)
#   204 = updated (overwrote existing)
#   403 = forbidden
#   404 = parent dir missing
# We treat both 201 and 204 as success.
if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "204" ]; then
  if [ "$HTTP_CODE" = "201" ]; then
    echo "✅ Upload successful (new file)"
  else
    echo "✅ Upload successful (overwrite of existing)"
  fi

  # Verify by downloading and comparing MD5
  TMP_FILE=$(mktemp)
  curl -s -u "${NC_USER}:${NC_PASS}" \
    -o "$TMP_FILE" \
    "${URL}"

  LOCAL_MD5=$(md5sum "$PDF_PATH" | cut -d' ' -f1)
  REMOTE_MD5=$(md5sum "$TMP_FILE" | cut -d' ' -f1)

  echo "Local MD5:  $LOCAL_MD5"
  echo "Remote MD5: $REMOTE_MD5"

  if [ "$LOCAL_MD5" = "$REMOTE_MD5" ]; then
    echo "✅ Integrity verified"
  else
    echo "❌ Integrity MISMATCH" >&2
    rm -f "$TMP_FILE"
    exit 2
  fi
  rm -f "$TMP_FILE"
  echo ""
  echo "📁 Nextcloud URL: https://${NC_HOST}/apps/files/files?dir=//"
else
  echo "❌ Upload failed (HTTP $HTTP_CODE)" >&2
  exit 1
fi
