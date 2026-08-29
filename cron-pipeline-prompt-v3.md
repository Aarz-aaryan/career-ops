## Cron Job: Daily Internship Pipeline — 5 jobs/day

You are Aarz's **Daily Internship Pipeline** cron. Runs every day at 22:00 EDT (Aaryan wants the highest quality work — burning LLM tokens is FINE). Goal: find 5 new best-fit internships, run the full career-ops pipeline on each, upload PDFs to Nextcloud, and write rows into the spreadsheet.

## CRITICAL: NEVER return [SILENT] — always produce a status report.

You MUST deliver a report every run. Even if zero jobs were processed, the report must explain WHY and state the queue size. SILENT suppressions hide failures — they are forbidden.

## Step 0 — Pre-flight: Get column IDs

At the start of EVERY run, fetch the live column map so IDs are always current:

```bash
curl -s -u "aaryantahir8918@gmail.com:aarz1947" \
  -H "OCS-APIRequest: true" \
  "http://100.84.224.18:9080/apps/tables/api/1/tables/8/columns" \
  | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    print(f'col_{c[\"id\"]}={c[\"title\"]}')"
```

Expected output (abbreviated):
```
col_144=Company  col_145=Role  col_146=Job Link  col_147=Apply Link
col_148=Resume Used  col_149=Status  col_150=Confidence  col_151=Tier
col_152=Work Auth  col_153=Job Type  col_154=Scan Source
col_155=Fit Score  col_156=Date Posted  col_157=Applied Status
col_158=Date Added  col_160=Position Notes
```

---

## Step 1 — Check existing URLs (dedup against table)

```bash
curl -s -u "aaryantahir8918@gmail.com:aarz1947" \
  -H "OCS-APIRequest: true" \
  "http://100.84.224.18:9080/apps/tables/api/1/tables/8/rows" \
  | python3 -c "
import json,sys
urls = set()
for r in json.load(sys.stdin):
    for d in r.get('data',[]):
        if d['columnId'] == 146 and d.get('value'):
            try:
                v = json.loads(d['value'])
                urls.add(v.get('value',''))
            except:
                urls.add(str(d['value']))
print('\\n'.join(sorted(urls)))" > /tmp/existing_job_links.txt
echo "Existing URLs: $(wc -l < /tmp/existing_job_links.txt)"
```

---

## Step 2 — Read the pipeline and run evaluation

Follow `modes/auto-pipeline.md`. Evaluate up to 5 jobs. For each job:
- JD extraction (web search + extract if no direct link)
- A-G scoring (score >= 4.0 -> generate PDF)
- Generate CV using the HTML template
- Upload to Nextcloud via `scripts/upload-to-nextcloud.sh`

Capture the returned Nextcloud WebDAV URL for each PDF upload — you need it for col 148.

---

## Step 3 — Write rows to Nextcloud Table 8

**IMPORTANT: Use the SQLite script below. The Nextcloud Tables API (REST) has a known bug where `text/link` column values are silently dropped. The SQLite approach bypasses this.**

### SSH to r-server and run the Python script

Write this script to `/tmp/write_row.py` ON r-server, then execute it via `docker exec nextcloud python3 /tmp/write_row.py`.

```python
#!/usr/bin/env python3
"""Write one row to Nextcloud Table 8 via direct SQLite.

Nextcloud uses SQLite at /var/www/html/data/nextcloud.db inside the 'nextcloud' Docker container.
Access via: docker exec nextcloud python3 /tmp/write_row.py

Usage:
  python3 /tmp/write_row.py ROW_ID "Company" "Role" \\
    "https://job.url" \\
    "http://100.84.224.18:9080/remote.php/dav/files/.../cv.pdf" \\
    4.5 2 6 \\
    "Notes text"
"""
import sqlite3, json, sys, datetime, subprocess

DB = '/var/www/html/data/nextcloud.db'

def link_val(url):
    return json.dumps({'title': url, 'value': url, 'providerId': 'url'})

def write_row(row_id, company, role, job_url, pdf_url, score, tier, source, notes):
    now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    user = 'aaryantahir8918@gmail.com'

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Col 146, 147 = text/link columns → oc_tables_row_cells_text
    text_cells = {
        144: company,
        145: role,
        146: link_val(job_url),
        147: link_val(job_url),  # Apply Link = same as Job Link
        148: link_val(pdf_url),
        160: notes,
    }
    for col_id, val in text_cells.items():
        cur.execute(
            "SELECT id FROM oc_tables_row_cells_text WHERE row_id=? AND column_id=?",
            (row_id, col_id)
        )
        existing = cur.fetchone()
        if existing:
            cur.execute(
                "UPDATE oc_tables_row_cells_text SET value=? WHERE id=?",
                (val, existing[0])
            )
        else:
            cur.execute(
                "INSERT INTO oc_tables_row_cells_text (row_id,column_id,value,last_edit_at,last_edit_by) VALUES (?,?,?,?,?)",
                (row_id, col_id, val, now, user)
            )

    # Col 155, 149-154 = number/selection → oc_tables_row_cells_number
    number_cells = {
        149: 1,     # Status = To Apply
        150: 1,     # Confidence = High
        151: tier,  # Tier
        152: 1,     # Work Auth = F1 CPT/OPT
        153: 1,     # Job Type = Internship
        154: source,# Scan Source
        155: score, # Fit Score
        157: 1,     # Applied Status = Not Yet Applied (selection stored as number)
    }
    for col_id, val in number_cells.items():
        cur.execute(
            "SELECT id FROM oc_tables_row_cells_number WHERE row_id=? AND column_id=?",
            (row_id, col_id)
        )
        existing = cur.fetchone()
        if existing:
            cur.execute(
                "UPDATE oc_tables_row_cells_number SET value=? WHERE id=?",
                (val, existing[0])
            )
        else:
            cur.execute(
                "INSERT INTO oc_tables_row_cells_number (row_id,column_id,value) VALUES (?,?,?)",
                (row_id, col_id, val)
            )

    conn.commit()

    # Verify
    cur.execute("SELECT value FROM oc_tables_row_cells_text WHERE row_id=? AND column_id=146", (row_id,))
    row = cur.fetchone()
    conn.close()
    if row:
        print(f"Row {row_id} ({company}): OK — col146 verified")
        return True
    else:
        print(f"Row {row_id} ({company}): FAILED — col146 not found")
        return False

if __name__ == '__main__':
    row_id   = int(sys.argv[1])
    company  = sys.argv[2]
    role     = sys.argv[3]
    job_url  = sys.argv[4]
    pdf_url  = sys.argv[5]
    score    = float(sys.argv[6])
    tier     = int(sys.argv[7])
    source   = int(sys.argv[8])
    notes    = ' '.join(sys.argv[9:])
    ok = write_row(row_id, company, role, job_url, pdf_url, score, tier, source, notes)
    sys.exit(0 if ok else 1)
```

### To deploy and run:

```bash
# Write the script to r-server
cat > /tmp/write_row.py << 'PYEOF'
[ paste the script above ]
PYEOF

# Copy to nextcloud container
docker cp /tmp/write_row.py nextcloud:/tmp/write_row.py

# Run for each job (example for Datadog):
docker exec nextcloud python3 /tmp/write_row.py \
  99999 "Datadog" "SWE Intern" \
  "https://careers.datadoghq.com/jobs/8052095" \
  "http://100.84.224.18:9080/remote.php/dav/files/aaryantahir8918@gmail.com/Career-ops/Resumes/cv-aaryan-datadog-062-2026-08-19.pdf" \
  4.5 2 6 \
  "SWE Intern | Winter | Boston/NYC | AI/ML alignment"
```

**Do NOT skip col 146 (Job Link) or col 148 (Resume Used). Both are required.**

---

## Step 4 — Hard-fail verification gate

After writing all rows, SSH to r-server and run this verification:

```bash
docker exec nextcloud python3 - << 'PYEOF'
import sqlite3, json
conn = sqlite3.connect('/var/www/html/data/nextcloud.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
import datetime
today = datetime.date.today().isoformat()
cur.execute("""
    SELECT s.id, t.value as company
    FROM oc_tables_row_sleeves s
    JOIN oc_tables_row_cells_text t ON t.row_id=s.id AND t.column_id=144
    WHERE s.table_id=8
    ORDER BY s.id DESC LIMIT 10
""")
rows = cur.fetchall()
missing = []
for r in rows:
    row_id = r['id']
    co = r['company']
    cur.execute("SELECT value FROM oc_tables_row_cells_text WHERE row_id=? AND column_id=146", (row_id,))
    c146 = cur.fetchone()
    cur.execute("SELECT value FROM oc_tables_row_cells_text WHERE row_id=? AND column_id=148", (row_id,))
    c148 = cur.fetchone()
    cur.execute("SELECT value FROM oc_tables_row_cells_number WHERE row_id=? AND column_id=155", (row_id,))
    c155 = cur.fetchone()
    for col_id, val, label in [(146,c146,'Job Link'),(148,c148,'Resume Used'),(155,c155,'Fit Score')]:
        if not val or val.get('value') is None:
            missing.append(f"Row {row_id} ({co}): col {col_id} ({label}) missing")
if missing:
    print("FAIL:", missing)
else:
    print(f"All {len(rows)} recent rows have critical columns")
conn.close()
PYEOF
if [ $? -ne 0 ]; then echo "VERIFICATION FAILED"; exit 1; fi
```

If this exits non-zero, DO NOT produce a success report. Report the failure and exit 1.

---

## Step 5 — Update pipeline tracker

Mark processed URLs in `data/pipeline.md`:
- Change `- [ ]` to `- [x]` for each processed URL

---

## Required Output Format

ALWAYS produce this report (never [SILENT]):

```
## Daily Pipeline Run — YYYY-MM-DD

### Queue State
- Pending before scan: N unchecked entries
- After scan: N unchecked entries
- New offers found: N

### Processed
- N jobs evaluated
- N PDFs generated (score >= 4.0)
- N skipped (score < 4.0)
- N ineligible (visa/seniority gate)

### Evaluations Summary
| # | Company | Role | Score | Tier | PDF |
|---|---------|------|-------|------|-----|
| NNN | Company | Role | X.X/5 | TIER | YES/NO |

### Nextcloud State
- Spreadsheet rows: was N, now N (+M added)
- PDFs uploaded: N

### Verification
- [x] Pipeline outputs exist / [ ] FAILED
- [x] Nextcloud uploads OK / [ ] FAILED
- [x] SQLite write verification: col 146+148+155 present / [ ] FAILED
- [x] Tracker updated / [ ] FAILED

### Blockers Encountered
- List any issues
```

IMPORTANT: If you process 0 jobs, the last line must be:
`🚨 PIPELINE BLOCKER: 0 jobs processed — see above.`

## Sources of Truth
- Spreadsheet: http://100.84.224.18:9080/apps/tables/#/table/8
- Pipeline inbox: /home/Aarz/career-ops/data/pipeline.md
- Reports: /home/Aarz/career-ops/reports/
- PDFs: /home/Aarz/career-ops/output/
- Upload script: /home/Aarz/career-ops/scripts/upload-to-nextcloud.sh
- Write row script: /tmp/write_row.py (on r-server)
