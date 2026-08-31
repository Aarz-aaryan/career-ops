#!/usr/bin/env bash
# backfill-tables.sh — Re-derive Nextcloud Tables rows for entries in
# data/applications.md that aren't yet represented in the table.
#
# ROOT-CAUSE CONTEXT (round-53, 2026-08-31):
# Before this round, write_row.php wrote the parent row first and each cell
# as a separate auto-commit. If anything interrupted execution between row
# creation and cell writes (cell write error, SSH drop, PDO timeout), the
# row remained in the DB with 0 cells. Result: 64+ orphan rows in table 8
# since 2026-08-24.
#
# This script is a one-shot backfill: for every PDF in output/ that has a
# matching report in reports/, derive company / role / score / job URL from
# the report header and call write_row.sh. Idempotent — write_row.sh does
# find-or-create on (company, role), so re-running is safe.
#
# Usage:
#   bash scripts/backfill-tables.sh [--dry-run]
#
# Pre-flight checks:
#   - write_row.sh exists
#   - ssh key auth or sshpass configured
#   - output/ has at least one PDF

set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

CO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CO_DIR"

if [[ ! -d output ]]; then
    echo "ERROR: output/ not found in $CO_DIR"
    exit 1
fi
if [[ ! -d reports ]]; then
    echo "ERROR: reports/ not found in $CO_DIR"
    exit 1
fi

PDF_COUNT=$(find output -maxdepth 1 -name "*.pdf" | wc -l)
echo "Found $PDF_COUNT PDFs in output/"
[[ $PDF_COUNT -eq 0 ]] && { echo "Nothing to backfill"; exit 0; }

NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-9080}"
NC_USER="${NC_USER:-aaryantahir8918@gmail.com}"

PROSESSED=0
SKIPPED=0
FAILED=0
ALREADY_EXISTS=0

for PDF_PATH in $(ls -1t output/*.pdf 2>/dev/null); do
    BASENAME_NO_EXT=$(basename "$PDF_PATH" .pdf)
    # Filename pattern A: cv-aaryan-{NNN}-{slug}-{YYYY-MM-DD}.pdf  (newer)
    REPORT_NUM=$(echo "$BASENAME_NO_EXT" | sed -nE 's/^cv-aaryan-([0-9]+)-.*/\1/p')
    if [[ -z "$REPORT_NUM" ]]; then
        # Filename pattern B: cv-aaryan-{slug}-{YYYY-MM-DD}.pdf  (older, no report number)
        # Match by company slug in filename
        SLUG=$(echo "$BASENAME_NO_EXT" | sed -E 's/^cv-aaryan-//' | sed -E 's/-[0-9]{4}-[0-9]{2}-[0-9]{2}$//')
        if [[ -z "$SLUG" ]]; then
            echo "SKIP: $BASENAME_NO_EXT (no slug)"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi
        REPORT_FILE=$(ls reports/*-${SLUG}-*.md 2>/dev/null | head -1)
        if [[ -z "$REPORT_FILE" ]]; then
            echo "SKIP: $BASENAME_NO_EXT (no report for slug '$SLUG')"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi
        REPORT_NUM=$(basename "$REPORT_FILE" | sed -nE 's/^([0-9]+)-.*/\1/p')
        if [[ -z "$REPORT_NUM" ]]; then
            echo "SKIP: $BASENAME_NO_EXT (matched report has no number)"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi
    else
        REPORT_FILE=$(ls reports/${REPORT_NUM}-*.md 2>/dev/null | head -1)
        if [[ -z "$REPORT_FILE" ]]; then
            echo "SKIP: $BASENAME_NO_EXT (no report file for #$REPORT_NUM)"
            SKIPPED=$((SKIPPED + 1))
            continue
        fi
    fi

    # Report header format:
    #   # Evaluation: Company — Role
    #   **URL:** https://...
    #   **Score:** 4.5/5
    H1_LINE=$(head -1 "$REPORT_FILE")
    # Strip "# Evaluation: " prefix
    EVAL_LINE=${H1_LINE#\# Evaluation: }
    # Split on the FIRST " — " (em dash with spaces)
    COMPANY=${EVAL_LINE%% — *}
    ROLE=${EVAL_LINE#* — }
    # Trim trailing whitespace
    COMPANY=$(echo "$COMPANY" | sed 's/[[:space:]]*$//')
    ROLE=$(echo "$ROLE" | sed 's/[[:space:]]*$//')

    SCORE_RAW=$(grep -oE '\*\*Score:\*\*[[:space:]]*[0-9.]+/5' "$REPORT_FILE" | head -1 | sed -E 's/.*\*\*Score:\*\*[[:space:]]*([0-9.]+)\/5.*/\1/')
    JOB_URL=$(grep -oE '\*\*URL:\*\*[[:space:]]*https?://[^[:space:]]+' "$REPORT_FILE" | head -1 | sed -E 's/\*\*URL:\*\*[[:space:]]*//')

    if [[ -z "$COMPANY" || -z "$ROLE" || -z "$SCORE_RAW" ]]; then
        echo "SKIP: report #$REPORT_NUM (couldn't parse — company='$COMPANY' role='$ROLE' score='$SCORE_RAW')"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    PDF_URL="http://${NC_HOST}:${NC_PORT}/remote.php/dav/files/${NC_USER}/$(basename "$PDF_PATH")"
    TIER=2
    SOURCE=6
    NOTES="Backfilled from report #$REPORT_NUM on $(date -u +%Y-%m-%d)"

    echo "→ #$REPORT_NUM  $COMPANY  /  $ROLE  (score $SCORE_RAW)"

    if [[ $DRY_RUN -eq 1 ]]; then
        echo "   (dry-run: would call write_row.sh)"
        PROSESSED=$((PROSESSED + 1))
        continue
    fi

    # write_row.sh is idempotent — find-or-create on (company, role). Re-running
    # is safe; existing rows get their cells refreshed.
    if OUT=$(bash scripts/write_row.sh "$COMPANY" "$ROLE" "$JOB_URL" "$PDF_URL" "$SCORE_RAW" "$TIER" "$SOURCE" "$NOTES" 2>&1); then
        if echo "$OUT" | grep -q "Existing row"; then
            ALREADY_EXISTS=$((ALREADY_EXISTS + 1))
        else
            PROSESSED=$((PROSESSED + 1))
        fi
    else
        echo "   FAILED: $OUT"
        FAILED=$((FAILED + 1))
    fi
done

echo ""
echo "=== Backfill summary ==="
echo "Created:        $PROSESSED"
echo "Already exists: $ALREADY_EXISTS"
echo "Skipped:        $SKIPPED"
echo "Failed:         $FAILED"
