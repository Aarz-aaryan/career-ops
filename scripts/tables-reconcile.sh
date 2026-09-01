#!/usr/bin/env bash
# tables-reconcile.sh — Round-54 follow-up. Compares the most recent cron output
# (which claims "Wrote N rows") against what's actually in Nextcloud Tables.
#
# Workflow:
#   1. Find the latest cron output file for job 607c910ef279
#   2. Extract the "Rows written: N" claim from the agent's response
#   3. Extract the per-row entries (company / role) from the cron output
#   4. Compare to the current Nextcloud Tables state
#   5. Report any rows the cron claims to have written but that aren't in the DB
#
# Usage:
#   bash scripts/tables-reconcile.sh              # JSON output, exit 0 always
#   bash scripts/tables-reconcile.sh --strict     # exit 1 if there are missing rows
#
# Exit codes:
#   0 = reconciliation ran (--strict: also no missing rows)
#   1 = --strict mode and rows are missing
#   2 = DB connection / cron output parse failed

set -euo pipefail

STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

CRON_OUTPUT_DIR="$HOME/.hermes/profiles/aarz/cron/output/607c910ef279"
NC_HOST="${NC_HOST:-100.84.224.18}"
NC_PORT="${NC_PORT:-22}"
NC_USER="${NC_SSH_USER:-r-server}"

# 1. Find the latest cron output file
LATEST_OUTPUT=$(ls -1t "$CRON_OUTPUT_DIR"/*.md 2>/dev/null | head -1)
if [[ -z "$LATEST_OUTPUT" ]]; then
    echo '{"error":"no cron output found","path":"'"$CRON_OUTPUT_DIR"'"}'
    exit 2
fi

# 2. Extract row entries claimed by the cron
# The cron output (after round-53) uses tables like:
#   | # | Company | Role | Score | Rec |
#   | 208 | TestCo | Pipeline Write Test | 4.6/5 | Apply |
# Or for backfill output (the new STEP 4):
#   → #208  TestCo  /  Pipeline Write Test  (score 4.6)
#
# Extract both formats.
CLAIMED_ROWS=$(python3 << EOF
import re, json, sys
text = open("$LATEST_OUTPUT").read()
rows = []

# Format A: markdown table with header "| # | Company | Role | Score | Rec |"
# Lines look like "| 208 | TestCo | Pipeline Write Test | 4.6/5 | Apply |"
table_pattern = re.compile(r'^\|\s*(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*(\d+\.?\d*)\s*/\s*5\s*\|', re.MULTILINE)
for m in table_pattern.finditer(text):
    rows.append({
        "report_num": int(m.group(1)),
        "company": m.group(2).strip(),
        "role": m.group(3).strip(),
        "score": float(m.group(4)),
    })

# Format B: backfill arrow lines "→ #NNN  Company  /  Role  (score N.N)"
arrow_pattern = re.compile(r'→\s*#(\d+)\s+([^/]+?)\s+/\s+([^(]+?)\s+\(score\s+(\d+\.?\d*)\)', re.MULTILINE)
for m in arrow_pattern.finditer(text):
    company = m.group(2).strip()
    role = m.group(3).strip()
    score = float(m.group(4))
    # Skip test entries
    if company in ('BURST1','BURST2','BURST3','BURST4','BURST5','WRAPPERTEST',
                   'KEYAUTHTEST','AUTOPIPELINETEST','SPECIAL','TESTCRON',
                   'PARTIALWRITE','ROUND53_TEST1','TestCo'):
        continue
    rows.append({
        "report_num": int(m.group(1)),
        "company": company,
        "role": role,
        "score": score,
    })

print(json.dumps({"cron_output": "$LATEST_OUTPUT", "claimed_rows": rows}))
EOF
)

# 3. Get the current DB rows
NC_USER_DOCKER='aaryantahir8918@gmail.com'
DB_ROWS=$(ssh -p "$NC_PORT" -o StrictHostKeyChecking=no -o BatchMode=yes "${NC_USER}@${NC_HOST}" \
  "docker exec nextcloud php -r '
\$db = new PDO(\"sqlite:/var/www/html/data/nextcloud.db\");
\$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
\$rows = [];
foreach (\$db->query(\"SELECT t144.value AS company, t145.value AS role, n155.value AS score, t158.value AS date_added FROM oc_tables_rows r LEFT JOIN oc_tables_row_cells_text t144 ON t144.row_id=r.id AND t144.column_id=144 LEFT JOIN oc_tables_row_cells_text t145 ON t145.row_id=r.id AND t145.column_id=145 LEFT JOIN oc_tables_row_cells_number n155 ON n155.row_id=r.id AND n155.column_id=155 LEFT JOIN oc_tables_row_cells_text t158 ON t158.row_id=r.id AND t158.column_id=158 WHERE r.table_id=8 AND EXISTS(SELECT 1 FROM oc_tables_row_cells_text WHERE row_id=r.id)\") as \$r) {
    \$rows[] = [
        \"company\" => \$r[\"company\"] ?? \"\",
        \"role\" => \$r[\"role\"] ?? \"\",
        \"score\" => (float)(\$r[\"score\"] ?? 0),
        \"date_added\" => \$r[\"date_added\"] ?? \"\",
    ];
}
echo json_encode(\$rows);
'" 2>&1)

# 4. Compare: find rows in CLAIMED but NOT in DB (case-insensitive company match)
python3 << EOF
import json
claimed = json.loads('''$CLAIMED_ROWS''')["claimed_rows"]
db_rows = json.loads('''$DB_ROWS''')

# Build lookup: (company_lower, role_lower) -> row
db_lookup = {}
for r in db_rows:
    key = (r["company"].strip().lower(), r["role"].strip().lower())
    db_lookup[key] = r

# Find missing
missing = []
matched = []
for c in claimed:
    key = (c["company"].strip().lower(), c["role"].strip().lower())
    if key in db_lookup:
        matched.append({"claimed": c, "actual": db_lookup[key]})
    else:
        missing.append(c)

result = {
    "cron_output": "$LATEST_OUTPUT",
    "claimed_count": len(claimed),
    "matched_count": len(matched),
    "missing_count": len(missing),
    "missing_rows": missing,
}

# Add a flag for "claimed but not found"
if claimed:
    result["reconcile_status"] = "OK" if not missing else "STALE_CLAIMS"
else:
    result["reconcile_status"] = "OK_NO_CLAIMS"

print(json.dumps(result, indent=2))

# Exit code
if missing and $STRICT:
    sys.exit(1)
EOF
RC=$?

if [[ $STRICT -eq 1 ]]; then
    exit $RC
fi
exit 0
