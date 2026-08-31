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
// Also clean up cells/sleeves that are orphaned (their parent row was deleted
// by an earlier round — without this, the Nextcloud Tables API shows ghost rows).
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

// Also collect orphan sleeves/cells (parent row missing) for cleanup
$orphanSleevesStmt = $db->prepare("
    SELECT s.id FROM oc_tables_row_sleeves s
    WHERE s.table_id = :tid
      AND NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id = s.id)
");
$orphanSleevesStmt->execute(['tid' => $tableId]);
$orphanSleeves = $orphanSleevesStmt->fetchAll(PDO::FETCH_COLUMN);

$orphanCellsText = $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_text t WHERE NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id = t.row_id)")->fetchColumn();
$orphanCellsNumber = $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_number n WHERE NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id = n.row_id)")->fetchColumn();
$orphanCellsSelection = $db->query("SELECT COUNT(*) FROM oc_tables_row_cells_selection s WHERE NOT EXISTS (SELECT 1 FROM oc_tables_rows r WHERE r.id = s.row_id)")->fetchColumn();

if (empty($orphans) && empty($orphanSleeves) && $orphanCellsText == 0 && $orphanCellsNumber == 0 && $orphanCellsSelection == 0) {
    echo "Table $tableId: no orphan rows or cells found. Clean.\n";
    exit(2);
}

echo "Table $tableId: cleanup summary:\n";
echo "  Orphan parent rows (no cells):     " . count($orphans) . "\n";
echo "  Orphan sleeves (parent deleted):  " . count($orphanSleeves) . "\n";
echo "  Orphan text cells:                $orphanCellsText\n";
echo "  Orphan number cells:              $orphanCellsNumber\n";
echo "  Orphan selection cells:           $orphanCellsSelection\n";

if ($dryRun) {
    echo "(dry-run mode — not deleting)\n";
    foreach ($orphans as $r) {
        printf("  row #%d  created=%s\n", $r['id'], $r['created_at']);
    }
    exit(0);
}

$db->beginTransaction();
try {
    // 1. Delete orphan parent rows (rows with no cells)
    if (!empty($orphans)) {
        $ids = array_column($orphans, 'id');
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $rowStmt = $db->prepare("DELETE FROM oc_tables_rows WHERE id IN ($placeholders)");
        $rowStmt->execute($ids);
        $rowsDeleted = $rowStmt->rowCount();
        $sleeveStmt = $db->prepare("DELETE FROM oc_tables_row_sleeves WHERE id IN ($placeholders)");
        $sleeveStmt->execute($ids);
        $sleevesDeleted = $sleeveStmt->rowCount();
    } else {
        $rowsDeleted = 0;
        $sleevesDeleted = 0;
    }

    // 2. Cascade-clean ALL orphan cells (where parent row was deleted by any prior cleanup)
    $db->exec("DELETE FROM oc_tables_row_sleeves WHERE id NOT IN (SELECT id FROM oc_tables_rows)");
    $db->exec("DELETE FROM oc_tables_row_cells_text      WHERE row_id NOT IN (SELECT id FROM oc_tables_rows)");
    $db->exec("DELETE FROM oc_tables_row_cells_number    WHERE row_id NOT IN (SELECT id FROM oc_tables_rows)");
    $db->exec("DELETE FROM oc_tables_row_cells_selection WHERE row_id NOT IN (SELECT id FROM oc_tables_rows)");

    $db->commit();
    echo "Deleted $rowsDeleted empty rows + their sleeves.\n";
    echo "Cascade-cleaned all orphan cells/sleeves.\n";
    echo "Table $tableId is now clean.\n";
    exit(0);
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    fwrite(STDERR, "Cleanup failed: " . $e->getMessage() . "\n");
    exit(1);
}
