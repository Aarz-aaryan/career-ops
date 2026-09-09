#!/usr/bin/env bash
# write_row.sh — write one job row into Nextcloud Tables.
#
# ROUND-63 (2026-09-09): this now delegates to scripts/write_row_api.mjs, which
# uses the public Tables REST API. It previously shelled into the nextcloud
# container and wrote the database directly, which caused a long tail of
# problems:
#
#   * it inserted into oc_tables_rows as well as oc_tables_row_sleeves, leaving
#     an orphan husk behind every time a row was deleted (round 61)
#   * it required write_row.php to live inside the container, which the 34.0.3
#     upgrade wiped along with /var/www/html (round 59)
#   * it hardcoded a sqlite DSN and had to be rewritten for the MariaDB move
#   * it bypassed Nextcloud's own validation, so it happily stored values the
#     UI and API consider invalid (bare-IP link URLs, round 62)
#
# The API path has none of those couplings: no files in the container, no bind
# mount, no DB credentials, and it survives Nextcloud upgrades.
#
# Usage (unchanged):
#   write_row.sh <company> <role> <job_url> <pdf_url> <score> [tier] [source] [notes]
#
# Output contract (unchanged, backfill-tables.sh greps for "Existing row"):
#   "Created row N for C / R."        - new row
#   "Existing row N updated: C / R"   - idempotent update
#   "Row N verified: C / R OK"        - verification passed
#
# Escape hatch: WRITE_ROW_LEGACY_SQL=1 restores the old direct-SQL path
# (scripts/write_row.php via ssh + docker exec). Kept for emergencies only --
# it reintroduces the orphan-row behaviour described above.

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${WRITE_ROW_LEGACY_SQL:-0}" = "1" ]; then
    exec bash "$DIR/write_row_legacy_sql.sh" "$@"
fi

# shellcheck source=/dev/null
source "$DIR/_nc-creds.sh"
: "${NC_API_USER:?NC_API_USER not set — check ~/.hermes/profiles/aarz/.env}"
: "${NC_API_PASS:?NC_API_PASS not set — check ~/.hermes/profiles/aarz/.env}"

exec node "$DIR/write_row_api.mjs" "$@"
