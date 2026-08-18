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
const strayLocations = [];  // 2026-07-25: Aaryan doesn't want cities anywhere in CV
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

// Graduation year (2026-07-28 round-10 fix): Aaryan graduates June 2028.
// Every PDF MUST show "Expected June 2028" — not "Expected 2027", not blank.
// This is a non-negotiable per the canonical "Summer 2028" framing in MISSION.md.
mustAppear.push({ token: 'Expected June 2028', source: 'graduation_year' });

// Location: lines containing "Philadelphia" / city names
// NOTE (2026-07-25): Aaryan explicitly asked for NO city/state anywhere in the CV
// (Education, contact row, job headers). The verifier should NOT require any
// location string to appear. We still scan for stray locations as a soft
// diagnostic (so we can warn if a future template change accidentally re-introduces
// a city) but we don't include them in the mustAppear set.
for (const line of cvLines) {
  const m = line.match(/\b(Philadelphia,?\s*PA|San Francisco|New York|Seattle|Austin|Boston|Mountain View)\b/);
  if (m) strayLocations.push(m[1]);
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

// ── 5b. Stray-location check (2026-07-25) ───────────────────────────────
// Aaryan does NOT want any city/state in the CV. We scan the PDF text and
// warn (but don't fail) if a stray location slips through. This catches
// accidental re-introductions like AGY adding "Philadelphia, PA" again.
const strayInPdf = strayLocations.filter(loc =>
  new RegExp(`\\b${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(pdfText)
);

// ── 5c. Core Competencies count check (round-28) ────────────────────────
// Schema spec: 6-8 keyword phrases (modes/pdf.md + auto-pipeline Step 12).
// Aaryan flagged 2026-08-05: r27 batch used the 3-item default from pdf.md
// instead of generating 6-8. Enforce min 6 here as a hard gate.
const compSection = pdfText.match(/CORE COMPETENCIES\s*\n([^\n]+(?:\n[^\n]+)?)/i);
let compCount = 0;
if (compSection) {
  // Count • separators in the competencies line(s) and add 1.
  compCount = (compSection[1].match(/•/g) || []).length + 1;
  // Also count the line itself if it has at least one non-empty tag.
  if (compSection[1].trim().length === 0) compCount = 0;
}
const compOk = compCount >= 6;

// ── 5d. Leadership count check (round-29) ───────────────────────────────
// Canonical structure: 4 leadership entries (Senior Design, Club Sports,
// Step School, NUST) with org-name on far right. The r27 batch regressed
// this by mis-categorizing all 4 leadership entries as jobs (silent schema
// drop because AGY omitted the `leadership` payload key). Enforce:
//   - At least 4 leadership-entry divs in the rendered PDF
//   - All 4 canonical org names appear in the PDF text
const LEADERSHIP_CANONICAL_ORGS = [
  'Drexel College of Engineering',
  'Drexel University Recreation',
  'The Step School System',
  'National University of Sciences',  // NUST abbreviated in cv.md but full name should appear
];
// Count actual leadership entries via the .leadership-org class on a span.
// We can't use pdftotext's bbox mode for this (slow); use simple text match
// against the org names.
const pdfTextLc = pdfText.toLowerCase();
const missingOrgs = LEADERSHIP_CANONICAL_ORGS.filter(org =>
  !pdfTextLc.includes(org.toLowerCase())
);
const leadershipOk = missingOrgs.length === 0;

// ── 5e. Skills section count check (round-29) ───────────────────────────
// Canonical: 5+ skill categories (Languages, Tools & Frameworks,
// GenAI/LLMOps, Cloud, CAD & Modeling, Design). The r27 batch silently
// dropped the skills section by omitting the `skills` payload key.
const SKILL_CATEGORIES = [
  'Languages',
  'Tools & Frameworks',
  'GenAI',
  'Cloud',
  'CAD',
  'Design',
];
const presentCategories = SKILL_CATEGORIES.filter(cat =>
  pdfText.includes(cat)
);
const skillsOk = presentCategories.length >= 4;

// ── 6. Report ───────────────────────────────────────────────────────────
// Note: stray locations are a soft warning, not a failure. Add to the
// `ok` predicate if you want them to fail the gate.
const ok = dropped.length === 0 && mdLeaks.length === 0 && missingNums.length === 0 && compOk && leadershipOk && skillsOk;
const result = {
  pdf: PDF_PATH,
  ok,
  dropped_fields: dropped,
  raw_markdown_leaks: mdLeaks,
  missing_numbers_from_cv: missingNums,
  stray_locations_in_pdf: strayInPdf,
  competencies_count: compCount,
  competencies_min: 6,
  competencies_ok: compOk,
  missing_leadership_orgs: missingOrgs,
  leadership_ok: leadershipOk,
  present_skill_categories: presentCategories,
  skill_categories_min: 4,
  skills_ok: skillsOk,
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
  if (strayInPdf.length) {
    console.log('Stray locations in PDF (Aaryan does not want cities anywhere in CV):');
    for (const s of strayInPdf) console.log(`  - "${s}"`);
  }
  if (!compOk) {
    console.log(`Core Competencies count: ${compCount} (minimum 6 required per schema spec in modes/pdf.md)`);
  }
  if (!leadershipOk) {
    console.log(`Missing canonical leadership org names (all 4 MUST appear per round-15+ spec):`);
    for (const o of missingOrgs) console.log(`  - "${o}"`);
  }
  if (!skillsOk) {
    console.log(`Skill categories present: ${presentCategories.length} (minimum 4 required)`);
    console.log(`  Present: ${presentCategories.join(', ') || '(none)'}`);
  }
  if (ok) console.log('No regressions detected.');
}

process.exit(ok ? 0 : 1);
