#!/usr/bin/env bash
# upload-to-nextcloud.sh — Upload a PDF to Aaryan's Nextcloud via WebDAV
#
# Usage: upload-to-nextcloud.sh <path-to-pdf> [custom-remote-name]
#
# Reads NC_USER + NC_PASS from ~/.hermes/profiles/aarz/.env (matches NC_USER / NC_PASS
# already exported by the Hermes shell). Falls back to aaryantahir8918@gmail.com / aarz1947.
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

# Load creds from hermes env if present
if [ -f "$HOME/.hermes/profiles/aarz/.env" ]; then
  set +e
  source "$HOME/.hermes/profiles/aarz/.env" 2>/dev/null
  set -e
fi

NC_USER="${NC_USER:-aaryantahir8918@gmail.com}"
NC_PASS="${NC_PASS:-aarz1947}"
NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-9080}"
NC_BASE="${NC_BASE:-/remote.php/dav/files/${NC_USER}}"

PDF_PATH="${1:?Usage: upload-to-nextcloud.sh <path-to-pdf> [custom-remote-name]}"
REMOTE_NAME="${2:-$(basename "$PDF_PATH")}"

if [ ! -f "$PDF_PATH" ]; then
  echo "ERROR: file not found: $PDF_PATH" >&2
  exit 1
fi

URL="http://${NC_HOST}:${NC_PORT}${NC_BASE}/${REMOTE_NAME}"

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
