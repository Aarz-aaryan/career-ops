#!/usr/bin/env bash
# tables-audit.sh — Round-53 follow-up audit query. Used by the follow-up cron
# and for one-off spot checks. Returns 0 if clean, non-zero with a count if dirty.
#
# Checks (in order, exits on first failure for cheap reads):
#   1. oc_tables_rows count for table 8
#   2. Orphan parent rows (no cells in any cell table)
#   3. Orphan sleeves (sleeves whose parent row was deleted)
#   4. Orphan cells (cells whose parent row was deleted)
#   5. Recent writes in last 2 hours (count)
#
# Usage:
#   bash scripts/tables-audit.sh                  # JSON output, exit 0 always
#   bash scripts/tables-audit.sh --strict         # exit 1 on any orphan > 0
#   bash scripts/tables-audit.sh --table <id>     # audit a different table
#
# Exit codes:
#   0 = audit ran (--strict: also clean)
#   1 = --strict mode and orphans > 0
#   2 = DB connection failed

set -euo pipefail

NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-22}"
NC_USER="${NC_SSH_USER:-r-server}"
NC_TABLE="${NC_TABLE:-8}"

STRICT=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --strict) STRICT=1; shift ;;
        --table) NC_TABLE="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 2 ;;
    esac
done

if [ -n "${NC_PASS:-}" ] && command -v sshpass >/dev/null 2>&1; then
  SSH=(sshpass -p "$NC_PASS" ssh -p "$NC_PORT" -o StrictHostKeyChecking=no "${NC_USER}@${NC_HOST}")
  SCP=(sshpass -p "$NC_PASS" scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
else
  SSH=(ssh -p "$NC_PORT" -o StrictHostKeyChecking=no -o BatchMode=yes "${NC_USER}@${NC_HOST}")
  SCP=(scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
fi

# Write the PHP script to a local temp file, then SCP it
LOCAL_TMP=$(mktemp /tmp/tables-audit-XXXXXX.php)
cat > "$LOCAL_TMP" << 'EOF'
<?php
$dbPath = '/var/www/html/data/nextcloud.db';
$tableId = (int)($argv[1] ?? 8);

try {
    $db = new PDO("sqlite:$dbPath");
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch (Throwable $e) {
    fwrite(STDERR, "DB connect failed: " . $e->getMessage() . "\n");
    exit(2);
}

// Counts
$counts = [
    'rows' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_rows WHERE table_id=$tableId")->fetchColumn(),
    'sleeves' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_sleeves WHERE table_id=$tableId")->fetchColumn(),
    'cells_text' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_text t JOIN oc_tables_rows r ON r.id=t.row_id WHERE r.table_id=$tableId")->fetchColumn(),
    'cells_number' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_number n JOIN oc_tables_rows r ON r.id=n.row_id WHERE r.table_id=$tableId")->fetchColumn(),
    'cells_selection' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_selection s JOIN oc_tables_rows r ON r.id=s.row_id WHERE r.table_id=$tableId")->fetchColumn(),
    'rows_with_cells' => (int) $db->query("SELECT COUNT(DISTINCT r.id) FROM oc_tables_rows r WHERE r.table_id=$tableId AND (EXISTS(SELECT 1 FROM oc_tables_row_cells_text WHERE row_id=r.id) OR EXISTS(SELECT 1 FROM oc_tables_row_cells_number WHERE row_id=r.id) OR EXISTS(SELECT 1 FROM oc_tables_row_cells_selection WHERE row_id=r.id))")->fetchColumn(),
    'rows_without_cells' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_rows r WHERE r.table_id=$tableId AND NOT EXISTS(SELECT 1 FROM oc_tables_row_cells_text WHERE row_id=r.id) AND NOT EXISTS(SELECT 1 FROM oc_tables_row_cells_number WHERE row_id=r.id) AND NOT EXISTS(SELECT 1 FROM oc_tables_row_cells_selection WHERE row_id=r.id)")->fetchColumn(),
    'orphan_sleeves' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_sleeves s WHERE s.table_id=$tableId AND NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id=s.id)")->fetchColumn(),
    'orphan_cells_text' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_text t WHERE NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id=t.row_id)")->fetchColumn(),
    'orphan_cells_number' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_number n WHERE NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id=n.row_id)")->fetchColumn(),
    'orphan_cells_selection' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_selection s WHERE NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id=s.row_id)")->fetchColumn(),
    'rows_added_last_2h' => (int) $db->query("SELECT COUNT(*) FROM oc_tables_rows WHERE table_id=$tableId AND created_at >= datetime('now', '-2 hours')")->fetchColumn(),
];

// Compare API row count to DB rows_with_cells (the ghost-row check)
$apiUrl = "http://100.84.224.18:9080/apps/tables/api/1/tables/$tableId/rows";
$apiRows = @file_get_contents($apiUrl, false, stream_context_create([
    'http' => ['method' => 'GET', 'header' => "Authorization: Basic " . base64_encode('aaryantahir8918@gmail.com:aarz1947')]
]));
$apiCount = is_string($apiRows) ? count(json_decode($apiRows, true) ?? []) : -1;
$counts['api_rows'] = $apiCount;
$counts['api_db_drift'] = ($apiCount !== $counts['rows_with_cells']) ? ($apiCount - $counts['rows_with_cells']) : 0;

// Output JSON
echo json_encode($counts) . "\n";

// Exit code: 1 if --strict and any orphan > 0 or api_db_drift != 0
$dirty = ($counts['rows_without_cells'] > 0 ||
          $counts['orphan_sleeves'] > 0 ||
          $counts['orphan_cells_text'] > 0 ||
          $counts['orphan_cells_number'] > 0 ||
          $counts['orphan_cells_selection'] > 0 ||
          $counts['api_db_drift'] != 0);

if ($dirty) {
    exit(1);
}
exit(0);
EOF

# SCP the PHP over
"${SCP[@]}" "$LOCAL_TMP" "${NC_USER}@${NC_HOST}:/tmp/tables-audit.php" >/dev/null
rm -f "$LOCAL_TMP"

# Run via SSH -> docker
"${SSH[@]}" "docker cp /tmp/tables-audit.php nextcloud:/tmp/tables-audit.php && docker exec nextcloud php /tmp/tables-audit.php $NC_TABLE"
RC=$?

if [[ $STRICT -eq 1 ]]; then
    exit $RC
fi
exit 0
