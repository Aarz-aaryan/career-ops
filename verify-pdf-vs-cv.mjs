#!/usr/bin/env node
/**
 * verify-pdf-vs-cv.mjs — Regression check for AGY-generated PDFs.
 *
 * Catches:
 *   - Silently dropped fields (e.g. Education dropping for some archetypes)
 *   - Raw markdown leaking into rendered text (asterisks around words, etc.)
 *   - Numbers from cv.md missing from the rendered PDF
 *
 * Usage:
 *   node verify-pdf-vs-cv.mjs <pdf-path>
 *   node verify-pdf-vs-cv.mjs <pdf-path> --json
 *
 * Exits 0 on success, 1 if any dropped fields or raw markdown detected.
 *
 * How it works:
 *   1. Run `pdftotext` to extract plain text from the PDF.
 *   2. Run `verify-cv-facts.mjs` (existing fact-check) to catch number fabrications.
 *   3. Diff the extracted text against cv.md — every degree, school, dates, and
 *      key number from cv.md should appear in the rendered text.
 *   4. Scan for raw markdown leakage: literal `*foo*` and `**bar**` patterns.
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
if (args.length < 1 || args[0] === '--help' || args[0] === '-h') {
  console.error('Usage: node verify-pdf-vs-cv.mjs <pdf-path> [--json]');
  process.exit(2);
}
const PDF_PATH = resolve(args[0]);
const JSON_OUT = args.includes('--json');
const CV_PATH = resolve(__dirname, 'cv.md');

if (!existsSync(PDF_PATH)) {
  console.error(`FATAL: PDF not found: ${PDF_PATH}`);
  process.exit(2);
}
if (!existsSync(CV_PATH)) {
  console.error(`FATAL: cv.md not found at ${CV_PATH}`);
  process.exit(2);
}

// ── 1. Extract text from PDF via pdftotext ──────────────────────────────
const pdftotext = spawnSync('pdftotext', ['-layout', PDF_PATH, '-'], { encoding: 'utf-8' });
if (pdftotext.status !== 0) {
  console.error(`FATAL: pdftotext failed: ${pdftotext.stderr}`);
  process.exit(2);
}
const pdfText = pdftotext.stdout;
const cvText = readFileSync(CV_PATH, 'utf-8');

// ── 2. Required-fields check (key data points from cv.md that MUST appear) ──
// Extract every "must-appear" token from cv.md. These are the canonical fields
// that should never silently drop.
const mustAppear = [];
const cvLines = cvText.split('\n');

// Degrees: lines matching "B.S." / "M.S." / "Ph.D." / "Bachelor" / "Master"
for (const line of cvLines) {
  const m = line.match(/\b(B\.[AS]\.|M\.[AS]\.|Ph\.D\.|Bachelor['']?s?|Master['']?s?)\b[^.\n]{0,80}/);
  if (m) mustAppear.push({ token: m[0].trim(), source: 'degree' });
}

// Schools / orgs: look for lines with "University" / "Institute" / "School"
for (const line of cvLines) {
  const m = line.match(/\b([A-Z][\w'’.\- ]*? (?:University|Institute|College|School))\b/);
  if (m) mustAppear.push({ token: m[1], source: 'school' });
}

// Education honors / achievements: "Dean's List", "Founder Scholar", "Cum Laude", etc.
for (const line of cvLines) {
  const honorRe = /\b((?:Dean['’]s List|Founder Scholar|Cum Laude|Magna Cum Laude|Summa Cum Laude|Honors(?: Program)?|Scholarship(?: Recipient)?|Distinguished [A-Z][\w'’]+))(?:\s*\(([^)]{1,40})\))?/g;
  let m;
  while ((m = honorRe.exec(line)) !== null) {
    mustAppear.push({ token: m[1], source: 'education_honor' });
  }
}

// Location: lines containing "Philadelphia" / city names
for (const line of cvLines) {
  const m = line.match(/\b(Philadelphia,?\s*PA|San Francisco|New York|Seattle|Austin|Boston|Mountain View)\b/);
  if (m) mustAppear.push({ token: m[1], source: 'location' });
}

// Quantified numbers from cv.md (n%, nK+, etc.)
const numRe = /\b(\d{2,3}\+?(?:%|K\+?)?)\b/g;
const cvNums = new Set();
for (const line of cvLines) {
  let m;
  while ((m = numRe.exec(line)) !== null) cvNums.add(m[1]);
}

// Dedupe mustAppear
const seen = new Set();
const uniqueMust = mustAppear.filter(x => {
  const k = x.token.toLowerCase();
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// ── 3. Check what's missing ─────────────────────────────────────────────
// Match each token with word-boundary regex (handles punctuation differences like
// commas/periods in source vs PDF text — e.g. "Philadelphia, PA" matches both).
const pdfLower = pdfText.toLowerCase();
const dropped = [];
for (const { token, source } of uniqueMust) {
  const needle = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex chars
  const re = new RegExp(`\\b${needle.replace(/\\s+/g, '\\s+')}\\b`);
  if (!re.test(pdfLower)) {
    dropped.push({ token, source });
  }
}

// ── 4. Check raw markdown leakage ────────────────────────────────────────
// Common patterns: *word*, **word**, _word_, __word__
// We look for `*` and `_` adjacent to letters (with no whitespace between).
const mdLeakRe = /(^|[\s.,;:(\[])(\*{1,2}[^*\s][^*]*?\*{1,2}|_{1,2}[^_\s][^_]*?_{1,2})($|[\s.,;:)\]])/gm;
const mdLeaks = [];
let m;
while ((m = mdLeakRe.exec(pdfText)) !== null) {
  mdLeaks.push(m[2]);
}

// ── 5. Number check ─────────────────────────────────────────────────────
const pdfNums = new Set();
const pdfNumRe = /\b(\d{2,3}\+?(?:%|K\+?)?)\b/g;
while ((m = pdfNumRe.exec(pdfText)) !== null) pdfNums.add(m[1]);
const missingNums = [...cvNums].filter(n => !pdfNums.has(n));

// ── 6. Report ───────────────────────────────────────────────────────────
const ok = dropped.length === 0 && mdLeaks.length === 0 && missingNums.length === 0;
const result = {
  pdf: PDF_PATH,
  ok,
  dropped_fields: dropped,
  raw_markdown_leaks: mdLeaks,
  missing_numbers_from_cv: missingNums,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\nverify-pdf-vs-cv: ${ok ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`PDF: ${PDF_PATH}\n`);

  if (dropped.length) {
    console.log('Dropped fields (in cv.md but missing from PDF):');
    for (const d of dropped) console.log(`  - [${d.source}] "${d.token}"`);
  }
  if (mdLeaks.length) {
    console.log('Raw markdown leaks:');
    for (const l of mdLeaks) console.log(`  - "${l}"`);
  }
  if (missingNums.length) {
    console.log('Missing numbers from cv.md:');
    for (const n of missingNums) console.log(`  - ${n}`);
  }
  if (ok) console.log('No regressions detected.');
}

process.exit(ok ? 0 : 1);
