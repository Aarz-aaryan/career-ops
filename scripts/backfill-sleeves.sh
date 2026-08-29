#!/usr/bin/env bash
# backfill-sleeves.sh — restore Nextcloud Tables row_sleeves that were
# deleted via the UI (sleeve deletion in the UI hides rows but leaves the
# parent row + cells intact). Re-creates matching sleeves from oc_tables_rows
# so rows reappear in /apps/tables/.
#
# Usage:  bash scripts/backfill-sleeves.sh [table_id]   (default table_id=8)

set -euo pipefail
TABLE_ID="${1:-8}"
NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-22}"
NC_USER="${NC_SSH_USER:-r-server}"

# Auth: prefer SSH key, fall back to sshpass if NC_PASS set
if [ -n "${NC_PASS:-}" ] && command -v sshpass >/dev/null 2>&1; then
  SSH=(sshpass -p "$NC_PASS" ssh -p "$NC_PORT" -o StrictHostKeyChecking=no "${NC_USER}@${NC_HOST}")
  SCP=(sshpass -p "$NC_PASS" scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
else
  SSH=(ssh -p "$NC_PORT" -o StrictHostKeyChecking=no -o BatchMode=yes "${NC_USER}@${NC_HOST}")
  SCP=(scp -P "$NC_PORT" -o StrictHostKeyChecking=no)
fi

# Inline PHP script — runs inside the nextcloud container
read -r -d '' PHP_SCRIPT <<'PHP' || true
<?php
$db = new PDO("sqlite:/var/www/html/data/nextcloud.db");
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$tid = (int)($argv[1] ?? 8);
$missing = $db->query("
    SELECT r.id, r.created_by, r.created_at, r.last_edit_by, r.last_edit_at
    FROM oc_tables_rows r
    LEFT JOIN oc_tables_row_sleeves s ON s.id = r.id
    WHERE r.table_id = $tid AND s.id IS NULL
    ORDER BY r.id
")->fetchAll(PDO::FETCH_ASSOC);
echo "Missing sleeves for table $tid: " . count($missing) . "\n";
$inserted = 0;
foreach ($missing as $row) {
    $stmt = $db->prepare(
        "INSERT OR IGNORE INTO oc_tables_row_sleeves
         (id, table_id, created_by, created_at, last_edit_by, last_edit_at)
         VALUES (?, ?, ?, ?, ?, ?)"
    );
    $stmt->execute([
        $row['id'], $tid,
        $row['created_by'], $row['created_at'],
        $row['last_edit_by'], $row['last_edit_at']
    ]);
    $inserted += $stmt->rowCount();
}
echo "Sleeves inserted: $inserted\n";
PHP

TMP=$(mktemp /tmp/backfill-sleeves-XXXXXX.php)
printf '%s' "$PHP_SCRIPT" > "$TMP"
"${SCP[@]}" "$TMP" "${NC_USER}@${NC_HOST}:/tmp/backfill-sleeves.php" >/dev/null
rm -f "$TMP"
"${SSH[@]}" "docker cp /tmp/backfill-sleeves.php nextcloud:/tmp/ && docker exec nextcloud php /tmp/backfill-sleeves.php $TABLE_ID"
