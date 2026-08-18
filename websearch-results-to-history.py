#!/usr/bin/env python3
"""
Round-34 (2026-08-08) — websearch-driven scan-history appender.

Aaryan: "we need a lot more... i want more so go ahead and start working on it
so that we have more"

Reads JSON results from stdin (or a file) and appends deduped rows to
~/career-ops/data/scan-history.tsv.

Usage:
  python3 websearch-results-to-history.py --input results.json --company Google
  echo '[{"url":"...","title":"...","location":"..."}]' | python3 websearch-results-to-history.py --company Microsoft

Input JSON format: list of {url, title, location?}
"""
import argparse
import json
import sys
from datetime import date
from pathlib import Path

HISTORY = Path("/home/Aarz/career-ops/data/scan-history.tsv")

# Round-33 word-boundary negative keywords (rejects grad-targeting titles)
NEGATIVE_KW = [
    "phd", "graduate", "grad student", "master's", "master", "mba",
    "postdoc", "postdoctoral", "doctoral",
    "returning professional", "experienced hire", "advanced degree",
]

# Round-33 word-boundary positive keywords (must have one of these)
POSITIVE_KW = [
    "intern", "internship", "co-op", "coop",
    "summer 2028", "summer 2027", "class of 2028", "class of 2027",
    "new grad", "university grad", "entry level", "early career",
]

# Substrings that mean "this is a real JD" (filter out homepages / generic pages)
JD_HINTS = [
    "/jobs/", "/job/", "/position", "/career/", "/intern",
    "/apply", "/opening", "viewjob", "currentopenings",
]


def is_word_boundary(text, kw):
    """Check if kw appears in text as a whole word (alpha keywords only)."""
    import re
    kw = kw.lower()
    text = text.lower()
    if re.match(r"^[a-z]+$", kw):
        return re.search(rf"\b{re.escape(kw)}\b", text) is not None
    return kw in text


def classify(title):
    """Classify a job title. Returns 'pass', 'reject_neg', or 'reject_pos'."""
    if not title:
        return "reject_pos"
    t = title.lower()
    has_pos = any(is_word_boundary(t, kw) for kw in POSITIVE_KW)
    if not has_pos:
        return "reject_pos"
    for kw in NEGATIVE_KW:
        if is_word_boundary(t, kw):
            return "reject_neg"
    return "pass"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", help="JSON file with results (else stdin)")
    parser.add_argument("--company", required=True, help="Company name")
    parser.add_argument("--portal", default="websearch", help="Portal method tag")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.input:
        with open(args.input) as f:
            results = json.load(f)
    else:
        results = json.load(sys.stdin)

    if not isinstance(results, list):
        print("ERROR: input must be a list of {url,title,location}", file=sys.stderr)
        sys.exit(1)

    # Load existing URLs
    existing = set()
    if HISTORY.exists():
        with open(HISTORY) as f:
            next(f)  # skip header
            for line in f:
                parts = line.split("\t")
                if parts[0]:
                    existing.add(parts[0])

    today = date.today().isoformat()
    added = 0
    rejected = {"reject_pos": 0, "reject_neg": 0}
    skipped_dup = 0
    skipped_no_url = 0
    skipped_no_jd = 0
    new_rows = []

    for r in results:
        url = r.get("url", "").strip()
        if not url:
            skipped_no_url += 1
            continue
        if url in existing:
            skipped_dup += 1
            continue
        # JD hint filter — skip homepages
        if not any(h in url.lower() for h in JD_HINTS):
            skipped_no_jd += 1
            continue

        title = r.get("title", "").strip()
        loc = r.get("location", "").strip()
        verdict = classify(title)
        if verdict != "pass":
            rejected[verdict] += 1
            continue

        row = [url, today, args.portal, title, args.company, "added", loc, "", "", ""]
        new_rows.append("\t".join(row))
        existing.add(url)
        added += 1

    print(f"Input: {len(results)} results")
    print(f"  Added: {added}")
    print(f"  Rejected (no intern keyword): {rejected['reject_pos']}")
    print(f"  Rejected (grad-targeting): {rejected['reject_neg']}")
    print(f"  Skipped (duplicate URL): {skipped_dup}")
    print(f"  Skipped (no URL): {skipped_no_url}")
    print(f"  Skipped (not a JD): {skipped_no_jd}")

    if not args.dry_run and new_rows:
        with open(HISTORY, "a") as f:
            for row in new_rows:
                f.write(row + "\n")
        print(f"\nWrote {added} rows to {HISTORY}")


if __name__ == "__main__":
    main()
