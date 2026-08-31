<?php
/**
 * write_row.php — Write one row to Nextcloud Tables (table_id=8) via direct SQLite.
 *
 * ROOT-CAUSE FIX (2026-08-28 round-49): Previous version wrote cells without
 * creating the parent row in oc_tables_rows. Nextcloud's REST API reads
 * oc_tables_rows JOINed with cell tables — without a parent row, the row is
 * invisible to /apps/tables/api/1/tables/8/rows and the cron thinks the write
 * failed.
 *
 * Usage A (positional args):
 *   php write_row.php COMPANY ROLE JOB_URL PDF_URL FIT_SCORE TIER SOURCE NOTES
 *
 * Usage B (JSON file — safer for empty/special-char args):
 *   php write_row.php --json /path/to/args.json
 *
 * JSON schema: {"company":"...","role":"...","jobUrl":"...","pdfUrl":"...",
 *               "fitScore":4.5,"tier":2,"source":6,"notes":"..."}
 *
 * Column map (table 8 — round-47 schema):
 *   144=Company (text)    145=Role (text)
 *   146=Job Link (link)   148=Resume Used (link)
 *   149=Status (sel)      150=Confidence (sel)
 *   151=Tier (sel)        152=Work Auth (sel)
 *   153=Job Type (sel)    154=Scan Source (sel)
 *   155=Fit Score (num)   158=Date Added (text)
 *   160=Position Notes (text)
 *
 * Selection columns (149-154, 157) use INTEGER option IDs.
 * Link columns (146, 148) use json_encode(["resourceUrl" => URL]).
 *
 * Runs inside the nextcloud container on r-server:
 *   docker exec nextcloud php /tmp/write_row.php --json /tmp/args.json
 *
 * Exit codes: 0 = success, 1 = error, 2 = critical column missing.
 */

// --- DB connection ---
$dbPath = '/var/www/html/data/nextcloud.db';
$userId = 'aaryantahir8918@gmail.com';
$now    = (new DateTime())->format('Y-m-d H:i:s');
$today  = (new DateTime())->format('Y-m-d');

// --- Parse args (two modes) ---
$company = $role = $jobUrl = $pdfUrl = $notes = '';
$fitScore = 0.0;
$tier = 1;
$source = 6;

if ($argc >= 2 && $argv[1] === '--json') {
    if ($argc < 3) {
        fwrite(STDERR, "Usage: php write_row.php --json <path>\n");
        exit(1);
    }
    $jsonPath = $argv[2];
    if (!file_exists($jsonPath)) {
        fwrite(STDERR, "JSON file not found: $jsonPath\n");
        exit(1);
    }
    $data = json_decode(file_get_contents($jsonPath), true);
    if (!is_array($data)) {
        fwrite(STDERR, "Invalid JSON in $jsonPath\n");
        exit(1);
    }
    $company  = $data['company']  ?? '';
    $role     = $data['role']     ?? '';
    $jobUrl   = $data['jobUrl']   ?? '';
    $pdfUrl   = $data['pdfUrl']   ?? '';
    $fitScore = $data['fitScore'] ?? 0;
    $tier     = $data['tier']     ?? 1;
    $source   = $data['source']   ?? 6;
    $notes    = $data['notes']    ?? '';
} else {
    if ($argc < 8) {
        fwrite(STDERR, "Usage: php write_row.php COMPANY ROLE JOB_URL PDF_URL FIT_SCORE TIER SOURCE [NOTES]\n");
        fwrite(STDERR, "   or: php write_row.php --json <path>\n");
        exit(1);
    }
    $company  = $argv[1];
    $role     = $argv[2];
    $jobUrl   = $argv[3];
    $pdfUrl   = $argv[4];
    $fitScore = $argv[5];
    $tier     = $argv[6];
    $source   = $argv[7];
    $notes    = $argv[8] ?? '';
}

if (empty($company) || empty($role)) {
    fwrite(STDERR, "ERROR: company and role are required\n");
    exit(1);
}

try {
    $db = new PDO("sqlite:$dbPath", null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        // ROOT-CAUSE FIX (2026-08-31 round-53): enable WAL mode so writes
        // from this PHP CLI don't block on long-running Nextcloud web/UI
        // transactions (Nextcloud serves HTTP via PHP-FPM, which takes
        // exclusive SQLite locks during table operations — without WAL,
        // a cron write could queue behind a UI read and time out, leaving
        // the parent row created without its cells).
        PDO::ATTR_TIMEOUT => 30,  // 30s busy-timeout instead of default 0
    ]);
    // Enable WAL — better concurrency, lets readers proceed during writes.
    $db->exec("PRAGMA journal_mode = WAL");
    $db->exec("PRAGMA busy_timeout = 30000");  // 30s busy_timeout at the SQLite layer
} catch (Throwable $e) {
    fwrite(STDERR, "DB connect failed: " . $e->getMessage() . "\n");
    exit(1);
}

// --- All-or-nothing transactional write (round-53 fix) ---
// BUG PRIOR: the script created the parent row, then wrote each cell as a
// separate auto-commit. If anything between (cell write, network drop, OOM,
// PDO timeout) interrupted execution, the parent row remained in the DB
// with 0 cells — visible as an "empty row" in the Nextcloud Tables UI and
// API. Result: 64+ orphan rows from cron runs since 2026-08-24.
//
// FIX: open a transaction at the top, write everything inside it, then
// commit at the bottom. On ANY exception, the transaction rolls back and
// the parent row is rolled back too — no orphans possible.
$rowId = null;
try {
    $db->beginTransaction();

    // Find-or-create parent row
    $stmt = $db->prepare(
        "SELECT r.id FROM oc_tables_rows r
         JOIN oc_tables_row_cells_text t144 ON t144.row_id = r.id AND t144.column_id = 144
         JOIN oc_tables_row_cells_text t145 ON t145.row_id = r.id AND t145.column_id = 145
         WHERE t144.value = :company AND t145.value = :role AND r.table_id = 8
         LIMIT 1"
    );
    $stmt->execute(['company' => $company, 'role' => $role]);
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($existing) {
        $rowId = (int)$existing['id'];
        echo "Existing row $rowId found for $company / $role — updating.\n";
    } else {
        $db->prepare(
            "INSERT INTO oc_tables_rows (table_id, created_by, created_at, last_edit_by, last_edit_at)
             VALUES (8, :uid, :now, :uid, :now)"
        )->execute(['uid' => $userId, 'now' => $now]);
        $rowId = (int)$db->lastInsertId();
        // ROOT-CAUSE FIX (2026-08-29 round-52): Nextcloud Tables queries
        // oc_tables_row_sleeves (a wrapper table) — without a matching sleeve,
        // the row exists in the DB but is INVISIBLE in the Tables UI/API.
        // The sleeve.id MUST equal the row.id (they share the autoincrement).
        $db->prepare(
            "INSERT OR IGNORE INTO oc_tables_row_sleeves (id, table_id, created_by, created_at, last_edit_by, last_edit_at)
             VALUES (:rid, 8, :uid, :now, :uid, :now)"
        )->execute(['rid' => $rowId, 'uid' => $userId, 'now' => $now]);
        echo "Created parent row $rowId for $company / $role.\n";
    }
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    fwrite(STDERR, "Parent row upsert failed: " . $e->getMessage() . "\n");
    exit(1);
}

function upsertText($db, $rowId, $colId, $value, $now, $uid) {
    $sel = $db->prepare("SELECT id FROM oc_tables_row_cells_text WHERE row_id = ? AND column_id = ?");
    $sel->execute([$rowId, $colId]);
    $existing = $sel->fetchColumn();
    if ($existing) {
        $upd = $db->prepare("UPDATE oc_tables_row_cells_text SET value = ?, last_edit_at = ?, last_edit_by = ? WHERE id = ?");
        $upd->execute([$value, $now, $uid, $existing]);
    } else {
        $ins = $db->prepare("INSERT INTO oc_tables_row_cells_text (row_id, column_id, value, last_edit_at, last_edit_by) VALUES (?, ?, ?, ?, ?)");
        $ins->execute([$rowId, $colId, $value, $now, $uid]);
    }
}

function upsertLink($db, $rowId, $colId, $url, $now, $uid) {
    if (empty($url)) return;
    $json = json_encode(
        ['resourceUrl' => $url, 'title' => $url, 'value' => $url],
        JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
    );
    upsertText($db, $rowId, $colId, $json, $now, $uid);
}

function upsertNumber($db, $rowId, $colId, $value, $now, $uid) {
    $sel = $db->prepare("SELECT id FROM oc_tables_row_cells_number WHERE row_id = ? AND column_id = ?");
    $sel->execute([$rowId, $colId]);
    $existing = $sel->fetchColumn();
    if ($existing) {
        $upd = $db->prepare("UPDATE oc_tables_row_cells_number SET value = ?, last_edit_at = ?, last_edit_by = ? WHERE id = ?");
        $upd->execute([(float)$value, $now, $uid, $existing]);
    } else {
        $ins = $db->prepare("INSERT INTO oc_tables_row_cells_number (row_id, column_id, value, last_edit_at, last_edit_by) VALUES (?, ?, ?, ?, ?)");
        $ins->execute([$rowId, $colId, (float)$value, $now, $uid]);
    }
}

function upsertSelection($db, $rowId, $colId, $optionId, $now, $uid) {
    $sel = $db->prepare("SELECT id FROM oc_tables_row_cells_selection WHERE row_id = ? AND column_id = ?");
    $sel->execute([$rowId, $colId]);
    $existing = $sel->fetchColumn();
    if ($existing) {
        $upd = $db->prepare("UPDATE oc_tables_row_cells_selection SET value = ?, last_edit_at = ?, last_edit_by = ? WHERE id = ?");
        $upd->execute([(int)$optionId, $now, $uid, $existing]);
    } else {
        $ins = $db->prepare("INSERT INTO oc_tables_row_cells_selection (row_id, column_id, value, last_edit_at, last_edit_by) VALUES (?, ?, ?, ?, ?)");
        $ins->execute([$rowId, $colId, (int)$optionId, $now, $uid]);
    }
}

// --- Write all cells (inside the open transaction) ---
try {
    upsertText($db, $rowId, 144, $company,          $now, $userId);
    upsertText($db, $rowId, 145, $role,             $now, $userId);
    upsertLink($db, $rowId, 146, $jobUrl,           $now, $userId);
    upsertLink($db, $rowId, 148, $pdfUrl,           $now, $userId);
    upsertSelection($db, $rowId, 149, 1,             $now, $userId);
    upsertSelection($db, $rowId, 150, 1,             $now, $userId);
    upsertSelection($db, $rowId, 151, (int)$tier,    $now, $userId);
    upsertSelection($db, $rowId, 152, 1,             $now, $userId);
    upsertSelection($db, $rowId, 153, 1,             $now, $userId);
    upsertSelection($db, $rowId, 154, (int)$source,  $now, $userId);
    upsertNumber($db, $rowId, 155, $fitScore,        $now, $userId);
    upsertText($db, $rowId, 158, $today,             $now, $userId);
    upsertText($db, $rowId, 160, $notes,             $now, $userId);
} catch (Throwable $e) {
    // Cell write failed → roll back the whole transaction so the parent
    // row never exists without its cells.
    if ($db->inTransaction()) $db->rollBack();
    fwrite(STDERR, "Cell write failed for $company / $role (rolled back): " . $e->getMessage() . "\n");
    exit(1);
}

// --- Hard-fail gate (round-53: also checks company, role, score) ---
$verify = $db->prepare(
    "SELECT t144.value AS company, t145.value AS role, t146.value AS link, t148.value AS pdf,
            n155.value AS score
     FROM oc_tables_rows r
     LEFT JOIN oc_tables_row_cells_text t144 ON t144.row_id = r.id AND t144.column_id = 144
     LEFT JOIN oc_tables_row_cells_text t145 ON t145.row_id = r.id AND t145.column_id = 145
     LEFT JOIN oc_tables_row_cells_text t146 ON t146.row_id = r.id AND t146.column_id = 146
     LEFT JOIN oc_tables_row_cells_text t148 ON t148.row_id = r.id AND t148.column_id = 148
     LEFT JOIN oc_tables_row_cells_number n155 ON n155.row_id = r.id AND n155.column_id = 155
     WHERE r.id = ?"
);
$verify->execute([$rowId]);
$row = $verify->fetch(PDO::FETCH_ASSOC);

$missing = [];
if (empty($row['company'])) $missing[] = "col 144 (Company)";
if (empty($row['role']))    $missing[] = "col 145 (Role)";
if (empty($row['link']))    $missing[] = "col 146 (Job Link)";
if (empty($row['score']))   $missing[] = "col 155 (Fit Score)";
if (empty($row['pdf']) && !empty($pdfUrl)) $missing[] = "col 148 (Resume Used)";

if (!empty($missing)) {
    // Verify failed → roll back the parent row + cells together.
    if ($db->inTransaction()) $db->rollBack();
    fwrite(STDERR, "CRITICAL: " . implode(", ", $missing) . " empty for row $rowId — HARD FAIL (rolled back)\n");
    exit(2);
}

// All checks passed → commit the transaction (persists row + sleeve + cells atomically).
$db->commit();
echo "Row $rowId verified: $company / $role OK\n";
exit(0);
