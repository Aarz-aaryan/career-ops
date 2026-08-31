<?php
/**
 * delete-rows.php — Delete specific Nextcloud Tables rows by company name.
 *
 * Usage:
 *   php delete-rows.php "Company Name 1" "Company Name 2" ...
 *
 * Or to delete rows where the company matches a pattern:
 *   php delete-rows.php --pattern "BURST|WRAPPERTEST|KEYAUTHTEST"
 *
 * Be CAREFUL — this is a hard delete with no undo. The script asks
 * for confirmation if more than 5 rows would be deleted.
 *
 * Exit codes:
 *   0 = success
 *   1 = DB error
 *   2 = cancelled by user
 */

$dbPath = '/var/www/html/data/nextcloud.db';
$tableId = 8;

if ($argc < 2) {
    fwrite(STDERR, "Usage: php delete-rows.php \"Company1\" \"Company2\" ... [--pattern REGEX]\n");
    exit(1);
}

// Parse args
$names = [];
$pattern = null;
$force = false;
for ($i = 1; $i < $argc; $i++) {
    if ($argv[$i] === '--pattern') {
        $pattern = $argv[++$i] ?? null;
    } elseif ($argv[$i] === '--yes') {
        $force = true;
    } else {
        $names[] = $argv[$i];
    }
}

try {
    $db = new PDO("sqlite:$dbPath", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
} catch (Throwable $e) {
    fwrite(STDERR, "DB connect failed: " . $e->getMessage() . "\n");
    exit(1);
}

// Find matching rows
$matching = [];
if ($pattern) {
    // Convert shell-style pattern (e.g., "^(A|B|C)") to SQL LIKE-compatible.
    // We accept patterns like "^(BURST|R53)" and convert to LIKE prefix-matches.
    $innerPattern = preg_replace('/^\^/', '', $pattern);
    $innerPattern = preg_replace('/\$$/', '', $innerPattern);
    // Split on | for multiple alternatives
    $alternatives = explode('|', $innerPattern);
    $clauses = [];
    $params = [];
    foreach ($alternatives as $alt) {
        // Use LIKE with the alt as a prefix — wrap with % for "contains"
        // Anchors ^ and $ are stripped; % wildcards are added for substring match.
        $clauses[] = 't144.value LIKE ?';
        $params[] = '%' . $alt . '%';
    }
    $where = implode(' OR ', $clauses);
    $sql = "
        SELECT r.id, t144.value AS company
        FROM oc_tables_rows r
        LEFT JOIN oc_tables_row_cells_text t144 ON t144.row_id = r.id AND t144.column_id = 144
        WHERE r.table_id = :tid AND ($where)
    ";
    $stmt = $db->prepare($sql);
    $stmt->execute(array_merge(['tid' => $tableId], $params));
    $matching = $stmt->fetchAll(PDO::FETCH_ASSOC);
} elseif (!empty($names)) {
    $placeholders = implode(',', array_fill(0, count($names), '?'));
    $stmt = $db->prepare("
        SELECT r.id, t144.value AS company
        FROM oc_tables_rows r
        LEFT JOIN oc_tables_row_cells_text t144 ON t144.row_id = r.id AND t144.column_id = 144
        WHERE r.table_id = ? AND t144.value IN ($placeholders)
    ");
    $stmt->execute(array_merge([$tableId], $names));
    $matching = $stmt->fetchAll(PDO::FETCH_ASSOC);
}

if (empty($matching)) {
    echo "No matching rows found.\n";
    exit(0);
}

echo "Would delete " . count($matching) . " rows:\n";
foreach ($matching as $r) {
    printf("  row #%d  company=%s\n", $r['id'], $r['company']);
}

if (count($matching) > 5 && !$force) {
    fwrite(STDERR, "Refusing to delete >5 rows without explicit confirmation.\n");
    fwrite(STDERR, "Re-run with --yes to bypass.\n");
    exit(1);
}

$ids = array_column($matching, 'id');
$placeholders = implode(',', array_fill(0, count($ids), '?'));

$db->beginTransaction();
try {
    $sleeveStmt = $db->prepare("DELETE FROM oc_tables_row_sleeves WHERE id IN ($placeholders)");
    $sleeveStmt->execute($ids);
    $sleevesDeleted = $sleeveStmt->rowCount();

    $rowStmt = $db->prepare("DELETE FROM oc_tables_rows WHERE id IN ($placeholders)");
    $rowStmt->execute($ids);
    $rowsDeleted = $rowStmt->rowCount();

    // Cascade cell deletes — text/number/selection reference row_id which is now gone.
    // Foreign keys aren't enforced in SQLite by default, so we clean them up explicitly.
    foreach (['oc_tables_row_cells_text', 'oc_tables_row_cells_number', 'oc_tables_row_cells_selection'] as $cellTable) {
        $cellStmt = $db->prepare("DELETE FROM $cellTable WHERE row_id IN ($placeholders)");
        $cellStmt->execute($ids);
    }

    $db->commit();
    echo "Deleted $rowsDeleted rows and $sleevesDeleted sleeves.\n";
    exit(0);
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    fwrite(STDERR, "Delete failed: " . $e->getMessage() . "\n");
    exit(1);
}
