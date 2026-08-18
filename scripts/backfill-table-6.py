#!/usr/bin/env python3
"""
backfill-table-6.py — Round 42 schema backfill.

The canonical Internship Tracker moved to table 6 after rounds 40/41 view-hang bugs.
This script seeds the 16 prior applications from the table 4/5 backfill into the
new table 6 schema (column IDs 111-139) using the working RowService::create pattern.

Run inside the Nextcloud container:
  docker exec nextcloud php /tmp/backfill-table-6.php

Or via direct API after copying table-6-curl.sh.

This is a one-shot script — not part of the daily pipeline.
"""
import subprocess
import json

NC_URL = "http://100.84.224.18:9080"
NC_USER = "aaryantahir8918@gmail.com"
NC_PASS = "aarz1947"

# Canonical table 6 column IDs (post-round-42):
# 111=Company 112=Role 113=Job Link 114=Source Link 115=Apply Link
# 116=Version 117=Selected 118=Generated? 119=Scan 120=Date Applied
# 121=Days Since 122=Action 123=Resume Used 124=Outcome 125=Email
# 126=Recruiter 127=Status 128=Confidence 129=At NYC? 130=US Citizen?
# 131=Salary Min 132=Salary Max 133=Equity 134=Skills 135=Tech Stack
# 136=Apply Reason 137=Fit Score 138=Notes 139=Last Update

# 16 applications from the 2026-08-11 backfill (Figma..Notion)
APPS = [
    {"company": "Figma",                     "role": "Software Engineer Intern (Winter 2027)",             "date": "2026-08-11", "days": 40, "score": 4.5},
    {"company": "LPL Financial Holdings",    "role": "Summer Intern 2027 - Software Engineer",            "date": "2026-08-11", "days": 41, "score": 3.6},
    {"company": "LPL Financial Holdings",    "role": "Summer Intern 2027 - Software Engineer",            "date": "2026-08-11", "days": 41, "score": 3.5},
    {"company": "Valstad Venture",           "role": "Software Engineer Intern",                          "date": "2026-08-11", "days": 42, "score": 3.0},
    {"company": "Eko Health",                "role": "Software Engineer Intern, Summer 2027",             "date": "2026-08-11", "days": 43, "score": 4.0},
    {"company": "CALSTART",                  "role": "Mobility Data Intern",                               "date": "2026-08-11", "days": 44, "score": 3.2},
    {"company": "Cohere",                    "role": "Software Engineer Intern (Toronto / Remote)",       "date": "2026-08-09", "days": 1,  "score": 4.2},
    {"company": "DataRobot",                 "role": "Software Engineer Intern, Platform",                "date": "2026-08-09", "days": 2,  "score": 4.2},
    {"company": "Deepgram",                  "role": "Software Engineer Intern, Speech AI",               "date": "2026-08-09", "days": 3,  "score": 4.2},
    {"company": "ProNexus",                  "role": "Software Engineer Intern",                          "date": "2026-08-09", "days": 4,  "score": 4.2},
    {"company": "Samsara",                   "role": "Software Engineer Intern",                          "date": "2026-08-09", "days": 5,  "score": 4.2},
    {"company": "Saronic",                   "role": "Software Engineer Intern",                          "date": "2026-08-10", "days": 6,  "score": 4.4},
    {"company": "Cloudflare",                "role": "Software Engineer Intern (Winter 2027)",            "date": "2026-08-10", "days": 7,  "score": 4.6},
    {"company": "Fab2",                      "role": "Software Engineer Intern",                          "date": "2026-08-10", "days": 8,  "score": 4.0},
    {"company": "k-ID",                      "role": "Software Engineer Intern",                          "date": "2026-08-10", "days": 9,  "score": 3.8},
    {"company": "Notion",                    "role": "Software Engineer Intern (Summer 2027)",             "date": "2026-08-10", "days": 10, "score": 3.9},
]

def backfill_via_api():
    """API path (works for non-notes columns; longtext/long subtype is fine post-round-42)."""
    created = 0
    failed = []
    for app in APPS:
        payload = {
            "data": {
                "111": app["company"],
                "112": app["role"],
                "116": "v1",
                "117": "1",
                "118": "1",
                "120": app["date"],
                "122": "Sent",
                "127": "Applied",
                "128": "High",
                "129": "No",
                "130": "Yes",
                "121": app["days"],
                "137": app["score"],
                "139": "2026-08-14",
            }
        }
        r = subprocess.run(
            ["curl", "-s", "-w", "\n%{http_code}",
             "-X", "POST",
             "-u", f"{NC_USER}:{NC_PASS}",
             "-H", "OCS-APIRequest: true",
             "-H", "Content-Type: application/json",
             "-d", json.dumps(payload),
             f"{NC_URL}/apps/tables/api/1/tables/6/rows"],
            capture_output=True, text=True, timeout=15
        )
        out = r.stdout
        last_line = out.rstrip().rsplit("\n", 1)[-1]
        body = out.rstrip().rsplit("\n", 1)[0]
        if "200" in last_line or "201" in last_line:
            created += 1
        else:
            failed.append({"company": app["company"], "http": last_line, "body": body[:200]})
    return created, failed


def print_php_helper():
    """Print the PHP-direct fallback path (works when v1 API fails)."""
    print("""
# --- FALLBACK: run inside the Nextcloud container (works for ALL rows, including Notes) ---
# File: /tmp/backfill-table-6.php (use the same content as in /home/Aarz/backfill-table-6.php on the host)
<?php
require_once '/var/www/html/lib/base.php';
use OCA\\Tables\\Db\\ColumnMapper;
use OCA\\Tables\\Model\\RowDataInput;
use OCA\\Tables\\Service\\RowService;

$columnMapper = \\OC::$server->get(ColumnMapper::class);
$rowService   = \\OC::$server->get(RowService::class);

$colMap = [];
foreach (range(111, 139) as $cid) {
    $colMap[$columnMapper->find($cid)->getTitle()] = $cid;
}

$apps = /* same as APPS above, in PHP */;
foreach ($apps as [$company, $role, $date, $days, $score]) {
    $data = new RowDataInput();
    $data->add($colMap['Company'], $company);
    $data->add($colMap['Role'], $role);
    // ... etc
    $rowService->create(6, null, $data, 'aaryantahir8918@gmail.com');
}
""")
    print("# Run:")
    print("#   sshpass -p '$RSERVER_PASS' scp /tmp/backfill-table-6.php r-server@100.84.224.18:/tmp/")
    print("#   sshpass -p '$RSERVER_PASS' ssh r-server@100.84.224.18 'docker cp /tmp/backfill-table-6.php nextcloud:/tmp/ && docker exec nextcloud php /tmp/backfill-table-6.php'")


if __name__ == "__main__":
    print("Round 42 backfill → table 6 (canonical Internship Tracker)")
    print(f"Apps to backfill: {len(APPS)}")
    print()
    created, failed = backfill_via_api()
    print(f"Created: {created}")
    if failed:
        print(f"Failed: {len(failed)}")
        for f in failed[:5]:
            print(f"  - {f}")
        print()
        print("PHP helper (fallback):")
        print_php_helper()
