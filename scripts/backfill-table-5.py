#!/usr/bin/env python3
"""
backfill-table-5.py — Round-41

Backfills Nextcloud Tables table 5 ("🎯 Internship Tracker — Summer 2027")
with rows 30-45 from data/applications.md.

Context:
- Table 4 was DELETED on 2026-08-14 (still broken in UI — Nextcloud Tables v2.2.1
  bug in getColumnsArray() + view columnSettings conflict). Auto-detect-by-title
  in CRON-REFERENCE.md points to whatever table has the canonical title.
- We reusable user-created **ToDo template table 5** as the new canonical tracker:
  renamed, columns 69-74 removed, new columns 75-103 added.
- Round-41 also did a one-shot PHP-side Row2Mapper backfill (16 rows). This
  Python script is a reference / re-runnable version that uses the v2 OCS API
  (POST /apps/tables/api/2/tables/{id}/rows with `{columnId: value, ...}` body).

This script reads applications.md and POSTs each as a row to:

    POST /apps/tables/api/2/tables/<resolved-id>/rows

Column ID map (verified live 2026-08-14, post-round-41):
| 75 Company
| 76 Role
| 77 Job URL
| 78 Apply URL
| 79 Resume Link
| 80 Resume Version
| 81 Selected
| 82 Selected Option
| 83 Applied
| 84 Application Deadline
| 85 tracker-pk
| 86 Location
| 87 Resume Status
| 88 Cover Letter Status
| 89 Cover Letter Uploaded
| 90 Form Filled
| 91 Form Submitted
| 92 Recruiter Outreach
| 93 Status Email
| 94 Final Status
| 95 Outcome
| 96 Interview Prep
| 97 Interview Date
| 98 Notes (DO NOT WRITE - longtext subtype triggers v2.2.1 bug)
| 99 Status
| 100 Status Update
| 101 Source
| 102 Fit Score (text — was Number pre-round-39)
| 103 Days Open

Idempotent: checks if a row with the same Job URL already exists, skips.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

APPS_MD = Path("/home/Aarz/career-ops/data/applications.md")
NC_HOST = "100.84.224.18"
NC_PORT = 9080
NC_USER = "aaryantahir8918@gmail.com"
NC_PASS = "aarz1947"
API_BASE = f"http://{NC_HOST}:{NC_PORT}/apps/tables/api"
API_V1 = f"{API_BASE}/1"
API_V2 = f"{API_BASE}/2"


def curl(method, path, data=None, base=API_V1):
    """Make a curl call, return (status_code, body_json_or_text)."""
    args = [
        "curl", "-s", "-u", f"{NC_USER}:{NC_PASS}",
        "-X", method,
        "-H", "OCS-APIRequest: true",
        "-H", "Accept: application/json",
    ]
    if data is not None:
        args += ["-H", "Content-Type: application/json", "-d", json.dumps(data)]
    args += [f"{base}/{path}", "-w", "\nHTTP_CODE:%{http_code}"]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    text = out.stdout
    if "HTTP_CODE:" in text:
        body, code = text.rsplit("HTTP_CODE:", 1)
        code = int(code.strip())
        body = body.strip()
    else:
        code = -1
        body = text.strip()
    try:
        return code, json.loads(body)
    except Exception:
        return code, body


def resolve_table_id():
    """Look up the Internship Tracker table id by title (canonical: "🎯 Internship Tracker — Summer 2027")."""
    code, body = curl("GET", "tables")
    if code != 200 or not isinstance(body, list):
        print(f"  ⚠️ could not list tables: HTTP {code}", file=sys.stderr)
        return None
    for t in body:
        title = t.get("title", "")
        if "Internship Tracker" in title:
            return t["id"]
    return None


def parse_applications_md():
    """Extract rows 30-45 from applications.md."""
    rows = []
    with APPS_MD.open() as f:
        for line in f:
            line = line.rstrip("\n")
            m = re.match(r"^\|\s*(\d+(?:-H)?)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|", line)
            if not m:
                continue
            num = m.group(1)
            if num in ("#", "Date", "---"):
                continue
            num_clean = num.lstrip("#")
            try:
                num_int = int(num_clean.split("-")[0])
            except ValueError:
                continue
            if num_int < 30 or num_int > 45:
                continue
            date_str = m.group(2).strip()
            company = m.group(3).strip()
            role = m.group(4).strip()
            score = m.group(5).strip()
            status = m.group(6).strip()
            pdf_cell = m.group(7).strip()
            report_cell = m.group(8).strip()
            notes = m.group(9).strip()
            report_path = None
            rm = re.search(r"\]\(([^)]+)\)", report_cell)
            if rm:
                report_path = rm.group(1)
            has_pdf = "✅" in pdf_cell
            rows.append({
                "num": num_clean,
                "date": date_str,
                "company": company,
                "role": role,
                "score": score,
                "status": status,
                "has_pdf": has_pdf,
                "report_link": report_path,
                "notes": notes,
            })
    return rows


def build_row_payload(r):
    """Build the v2 OCS API payload: {columnId: value, ...} dict."""
    score_num = re.search(r"([\d.]+)", r["score"])
    fit_score = score_num.group(1) if score_num else ""

    # locate PDF if it exists
    pdf_link = ""
    if r["has_pdf"]:
        slug = r["report_link"].split("/")[-1] if r["report_link"] else ""
        slug_base = slug.replace(".md", "") if slug else ""
        candidates = []
        if slug_base:
            candidates.append(f"cv-aaryan-{slug_base}.pdf")
        num = slug_base.split("-")[0] if slug_base else ""
        if num:
            pdfs = sorted(Path("/home/Aarz/career-ops/output").glob(f"cv-aaryan-*{num}-*.pdf")) if num else []
            if pdfs:
                v2 = [p for p in pdfs if "-v2.pdf" in p.name]
                chosen = v2[0] if v2 else pdfs[0]
                pdf_link = f"http://{NC_HOST}:{NC_PORT}/remote.php/dav/files/{NC_USER}/Career-ops/Resumes/{chosen.name}"

    job_url = ""
    if r["report_link"]:
        try:
            report_path = Path("/home/Aarz/career-ops") / r["report_link"]
            if report_path.exists():
                md = report_path.read_text()
                um = re.search(r"(https?://[^\s|)]+)", md)
                if um:
                    job_url = um.group(1)
        except Exception:
            pass

    resume_version = "v2 (Harvard template)" if pdf_link and "-v2" in pdf_link else "v1"
    selected = "1"  # To Apply
    status_val = "1"  # To Apply

    # v2 OCS format: {columnId_str: value, ...}
    return {
        "75": r["company"],
        "76": r["role"],
        "77": job_url or "",
        "78": job_url or "",
        "79": pdf_link,
        "80": resume_version,
        "81": selected,
        "84": r["date"],
        "85": r["num"],
        "99": status_val,
        "101": "Greenhouse" if "greenhouse" in (job_url or "").lower() else "Manual",
        "102": fit_score,
    }


def existing_urls(table_id):
    code, body = curl("GET", f"tables/{table_id}/rows")
    if code != 200 or not isinstance(body, list):
        return set()
    urls = set()
    for row in body:
        if not isinstance(row, dict):
            continue
        for cell in row.get("data", []):
            if isinstance(cell, dict) and cell.get("columnId") == 77 and cell.get("value"):
                urls.add(cell["value"])
    return urls


def main():
    table_id = resolve_table_id()
    if not table_id:
        print("❌ could not resolve Internship Tracker table id")
        sys.exit(1)
    print(f"Resolved Internship Tracker → table id {table_id}")

    rows = parse_applications_md()
    print(f"Parsed {len(rows)} rows from applications.md")

    existing = existing_urls(table_id)
    print(f"  Table {table_id} currently has {len(existing)} job URLs")

    written = 0
    skipped = 0
    failed = []
    for r in rows:
        payload = build_row_payload(r)
        job_url = payload.get("77", "")
        if job_url and job_url in existing:
            print(f"  ↪ SKIP row {r['num']:>3} {r['company'][:25]:25} — already in table")
            skipped += 1
            continue
        # v2 OCS endpoint: {table|view}/<id>/rows
        code, body = curl("POST", f"tables/{table_id}/rows", payload, base=API_V2)
        if code == 200 and isinstance(body, dict) and body.get("id"):
            print(f"  ✅ wrote row {r['num']:>3} {r['company'][:25]:25} id={body['id']}")
            written += 1
        else:
            print(f"  ❌ row {r['num']:>3} {r['company'][:25]:25} HTTP {code} body={str(body)[:200]}")
            failed.append((r["num"], r["company"], code, body))

    print(f"\nDone: {written} written, {skipped} skipped, {len(failed)} failed")
    if failed:
        print("Failures:")
        for num, comp, code, body in failed:
            print(f"  {num} {comp} HTTP {code} {str(body)[:200]}")
        sys.exit(1)


if __name__ == "__main__":
    main()