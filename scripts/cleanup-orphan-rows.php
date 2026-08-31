<?php
/**
 * cleanup-orphan-rows.php — Delete orphan rows from Nextcloud Tables (table 8).
 *
 * ROOT-CAUSE CONTEXT (round-53, 2026-08-31):
 * Before this round, write_row.php wrote the parent row FIRST and then each
 * cell as a separate auto-commit. If anything interrupted execution between
 * row creation and cell writes (cell write error, SSH drop, PDO timeout), the
 * row remained in the DB with 0 cells. Result: 64+ orphan rows in table 8
 * since 2026-08-24, visible as "empty rows" in the Tables UI/API.
 *
 * Round-53 makes the row write transactional — new orphans can no longer be
 * created. This script cleans up the existing orphans:
 *   - SELECT rows WHERE no cells exist in any of the 3 cell tables
 *   - DELETE those rows from oc_tables_rows
 *   - DELETE the matching sleeves from oc_tables_row_sleeves
 *   - Report what was deleted
 *
 * Usage:
 *   php cleanup-orphan-rows.php [table_id] [--dry-run]
 *
 *   default table_id = 8
 *   --dry-run: print what would be deleted, but don't actually delete
 *
 * Exit codes:
 *   0 = success
 *   1 = DB error
 *   2 = no orphans found (already clean)
 */

$dbPath = '/var/www/html/data/nextcloud.db';
$tableId = 8;
$dryRun = false;

// Parse args
foreach (array_slice($argv, 1) as $arg) {
    if ($arg === '--dry-run') {
        $dryRun = true;
    } elseif (is_numeric($arg)) {
        $tableId = (int)$arg;
    }
}

try {
    $db = new PDO("sqlite:$dbPath", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
} catch (Throwable $e) {
    fwrite(STDERR, "DB connect failed: " . $e->getMessage() . "\n");
    exit(1);
}

// Find orphan rows: rows with NO cells in any cell table.
$stmt = $db->prepare("
    SELECT r.id, r.created_at
    FROM oc_tables_rows r
    WHERE r.table_id = :tid
      AND NOT EXISTS (SELECT 1 FROM oc_tables_row_cells_text      WHERE row_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM oc_tables_row_cells_number    WHERE row_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM oc_tables_row_cells_selection WHERE row_id = r.id)
    ORDER BY r.id
");
$stmt->execute(['tid' => $tableId]);
$orphans = $stmt->fetchAll(PDO::FETCH_ASSOC);

if (empty($orphans)) {
    echo "Table $tableId: no orphan rows found. Clean.\n";
    exit(2);
}

echo "Table $tableId: found " . count($orphans) . " orphan rows.\n";
if ($dryRun) {
    echo "(dry-run mode — not deleting)\n";
    foreach ($orphans as $r) {
        printf("  row #%d  created=%s\n", $r['id'], $r['created_at']);
    }
    exit(0);
}

$db->beginTransaction();
try {
    $ids = array_column($orphans, 'id');
    $placeholders = implode(',', array_fill(0, count($ids), '?'));

    // Delete sleeves first (they reference row IDs)
    $sleeveStmt = $db->prepare("DELETE FROM oc_tables_row_sleeves WHERE id IN ($placeholders)");
    $sleeveStmt->execute($ids);
    $sleevesDeleted = $sleeveStmt->rowCount();

    // Delete parent rows
    $rowStmt = $db->prepare("DELETE FROM oc_tables_rows WHERE id IN ($placeholders)");
    $rowStmt->execute($ids);
    $rowsDeleted = $rowStmt->rowCount();

    $db->commit();
    echo "Deleted $rowsDeleted orphan rows and $sleevesDeleted sleeves.\n";
    echo "Table $tableId is now clean.\n";
    exit(0);
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    fwrite(STDERR, "Cleanup failed: " . $e->getMessage() . "\n");
    exit(1);
}
