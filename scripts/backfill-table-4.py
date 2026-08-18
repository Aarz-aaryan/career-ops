#!/usr/bin/env python3
"""
backfill-table-4.py — Round-39 fix

Backfills Nextcloud Tables table 4 ("Internship Tracker — Summer 2027")
with rows 30-45 from data/applications.md.

Context:
- Old table 2 was DELETED (had 10 rows from Aug 9-11 runs, plus 5 more from Aug 12 sync-recovery)
- New table 4 was created 2026-08-13 02:38 UTC with 29 columns (IDs 38-66)
- Local data/applications.md is the canonical source of truth — all 15 rows present
- This script reads them and POSTs each as a row to /apps/tables/api/1/tables/4/rows

Column ID map (verified live 2026-08-13, after round-39 fix to convert number cols → text):
- 38 Company
- 39 Role
- 40 Job URL (text/link subtype)
- 41 Apply URL (text/link subtype)
- 42 Resume Link (text/link subtype)
- 43 Resume Version
- 44 Selected (selection column, option ID as string)
- 45 Selected Option (selection)
- 46 Applied
- 47 Application Deadline
- 48 tracker-pk
- 49 Location
- 50 Resume Status
- 51 Cover Letter Status
- 52 Cover Letter Uploaded
- 54 Form Filled
- 55 Form Submitted
- 56 Recruiter Outreach
- 57 Status Email
- 58 Final Status
- 59 Outcome
- 60 Interview Prep
- 61 Interview Date
- 62 Notes (longtext)
- 63 Status (selection)
- 64 Status Update
- 65 Source
- 67 Fit Score (was 53 — round-39 fix: changed from number to text because Tables app v2.2.1 has broken NumberNumberBusiness class)
- 68 Days Open (was 66 — same reason)

Idempotent: checks if a row with the same Job URL already exists, skips.
"""
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

APPS_MD = Path("/home/Aarz/career-ops/data/applications.md")
NC_HOST = "100.84.224.18"
NC_PORT = 9080
NC_USER = "aaryantahir8918@gmail.com"
NC_PASS = "aarz1947"
TABLE_ID = 4
API_BASE = f"http://{NC_HOST}:{NC_PORT}/apps/tables/api/1"


def curl(method, path, data=None):
    """Make a curl call, return (status_code, body_json_or_text)."""
    args = [
        "curl", "-s", "-u", f"{NC_USER}:{NC_PASS}",
        "-X", method,
        "-H", "OCS-APIRequest: true",
        "-H", "Accept: application/json",
    ]
    if data is not None:
        args += ["-H", "Content-Type: application/json", "-d", json.dumps(data)]
    args += [f"{API_BASE}/{path}", "-w", "\nHTTP_CODE:%{http_code}"]
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
            # strip leading # from num
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
            # pdf = "✅" means PDF was generated; "❌" means not
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
    """Build the Nextcloud Tables API payload for one row."""
    score_num = re.search(r"([\d.]+)", r["score"])
    fit_score = score_num.group(1) if score_num else ""

    # locate PDF if it exists
    pdf_link = ""
    if r["has_pdf"]:
        # try output/ dir
        slug = r["report_link"].split("/")[-1] if r["report_link"] else ""
        # slug is like "030-cohere-2026-08-09.md"
        slug_base = slug.replace(".md", "") if slug else ""
        # check both base and _v2 version
        candidates = []
        if slug_base:
            candidates.append(f"cv-aaryan-{slug_base}.pdf")
            candidates.append(f"cv-aaryan-{slug_base.replace('-{0}'.format(slug_base.split('-')[0]), '')}.pdf")
        # also try a direct match
        num = slug_base.split("-")[0] if slug_base else ""
        if num:
            candidates.append(f"cv-aaryan-{num}-*.pdf")
        # fallback - find any matching pdf
        pdfs = sorted(Path("/home/Aarz/career-ops/output").glob(f"cv-aaryan-*{num}-*.pdf")) if num else []
        if pdfs:
            # prefer _v2 if exists
            v2 = [p for p in pdfs if "-v2.pdf" in p.name]
            chosen = v2[0] if v2 else pdfs[0]
            pdf_link = f"http://{NC_HOST}:{NC_PORT}/remote.php/dav/files/{NC_USER}/Career-ops/Resumes/{chosen.name}"

    # resolve apply URL = same as job URL (we don't have separate apply URL tracked)
    job_url = ""
    if r["report_link"]:
        # try to extract from the markdown report itself
        try:
            report_path = Path("/home/Aarz/career-ops") / r["report_link"]
            if report_path.exists():
                md = report_path.read_text()
                um = re.search(r"(https?://[^\s|)]+)", md)
                if um:
                    job_url = um.group(1)
        except Exception:
            pass

    # resume version: v2 if exists else v1
    resume_version = "v2 (Harvard template)" if pdf_link and "-v2" in pdf_link else "v1"

    # status: all our rows are "Evaluated" → Selected=1 (To Apply)
    selected = "1"  # To Apply
    status_val = "1"  # To Apply

    payload = {
        "data": {
            "38": r["company"],
            "39": r["role"],
            "40": job_url or "",
            "41": job_url or "",
            "42": pdf_link,
            "43": resume_version,
            "44": selected,
            "47": r["date"],  # Application Deadline placeholder
            "48": r["num"],   # tracker-pk
            "67": fit_score,  # Fit Score (was 53 pre-round-39)
            "63": status_val,
            # NOTE: NOT including "62" (Notes, subtype=longtext) — Tables app v2.2.1 has a bug
            # where subtype=longtext → class TextLongtextBusiness lookup fails with
            # "Could not resolve OCA\Tables\Service\ColumnTypes\TextLongtextBusiness".
            # All other text subtypes (line, link) work fine.
        }
    }
    return payload


def existing_urls():
    code, body = curl("GET", f"tables/{TABLE_ID}/rows")
    if code != 200:
        print(f"  ⚠️ could not list rows: HTTP {code}", file=sys.stderr)
        return set()
    urls = set()
    if not isinstance(body, list):
        print(f"  ⚠️ unexpected body type: {type(body).__name__}: {str(body)[:200]}", file=sys.stderr)
        return set()
    for row in body:
        if not isinstance(row, dict):
            continue
        for cell in row.get("data", []):
            if not isinstance(cell, dict):
                continue
            if cell.get("columnId") == 40 and cell.get("value"):
                urls.add(cell["value"])
    return urls


def main():
    rows = parse_applications_md()
    print(f"Parsed {len(rows)} rows from applications.md")

    print("\nFetching existing rows from table 4 for dedup...")
    existing = existing_urls()
    print(f"  Table 4 currently has {len(existing)} job URLs")

    written = 0
    skipped = 0
    failed = []
    for r in rows:
        payload = build_row_payload(r)
        job_url = payload["data"].get("40", "")
        if job_url and job_url in existing:
            print(f"  ↪ SKIP row {r['num']:>3} {r['company'][:25]:25} — already in table")
            skipped += 1
            continue
        code, body = curl("POST", f"tables/{TABLE_ID}/rows", payload)
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
