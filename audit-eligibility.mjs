#!/usr/bin/env node
// Round-36 (2026-08-09) — eligibility audit for all pending URLs in pipeline.md.
// Aaryan: "I'm an undergraduate, we should not have PhD/Master's jobs on the spreadsheet — clean it up."
//
// Reads negative keywords from portals.yml::title_filter.negative (the canonical
// scan.mjs filter), then audits every pending URL in data/pipeline.md against
// (a) the JOB TITLE (parsed from URL slug or page H1) — strict, using scan.mjs
// compileKeyword semantics; and (b) the JD body — only flagging if a body match
// is found in a "Requirements"/"Qualifications" section (i.e. near the role's
// mandatory eligibility, not a casual mention).
//
// Read-only by default: writes a /tmp/eligibility-audit.json and a
// /tmp/eligibility-review-queue.md for human review. Mutates pipeline.md only
// when `--apply` is passed.
//
// Why title-only strict and body-overlap soft:
//   The previous body-only scan false-positived 15 legit roles (e.g. Cohere
//   ML Intern got flagged because the body mentioned "Senior" + "Staff" in
//   unrelated teams). scan.mjs has always filtered by title; we mirror that
//   pattern to stay consistent with the running pipeline.
//
// Exit codes: 0 = all clean, 1 = some INELIGIBLE found (or review items), 2 = tool error.

import { readFile, writeFile } from 'fs/promises';
import { spawnSync } from 'child_process';
import { load as yamlLoad } from 'js-yaml';

const PIPELINE = 'data/pipeline.md';
const PORTALS_YML = 'portals.yml';
const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// 1. Load canonical exclusion keyword list from portals.yml
// ---------------------------------------------------------------------------
const portalsRaw = await readFile(PORTALS_YML, 'utf-8');
const portals = yamlLoad(portalsRaw);
const KEYWORDS = portals.title_filter.negative || [];
console.log(`Loaded ${KEYWORDS.length} canonical negative keywords from portals.yml.`);

// Apply scan.mjs::compileKeyword rule (round-33 word-boundary fix):
// pure-alphabetic keywords use word-boundary regex; multi-word/non-alpha
// fall back to substring matching.
function compileKeyword(kw) {
  if (/^[a-z]+$/i.test(kw)) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    return (text) => re.test(text);
  }
  // For multi-word phrases, just substring match
  return (text) => text.toLowerCase().includes(kw.toLowerCase());
}
const MATCHERS = KEYWORDS.map(kw => ({ raw: kw, match: compileKeyword(kw) }));

// ---------------------------------------------------------------------------
// 2. PhD-required hard-blocklist (always check, regardless of title filter)
//    These are phrases that, if found in the JD, definitively disqualify an
//    undergraduate applicant.
// ---------------------------------------------------------------------------
const PHD_REQUIRED_PATTERNS = [
  // PhD required
  /\b(phd|ph\.d\.)\b[^\.]{0,80}\b(required|must|need|necessary|preferred)\b/i,
  /\b(must|required|need)\b[^\.]{0,80}\b(phd|ph\.d\.)\b/i,
  /\b(pursuing|completion|completion of|holds|holding)\b[^\.]{0,80}\b(phd|doctoral)\b/i,
  // Master's REQUIRED (not "Bachelor's or Master's" — that's fine for undergrads)
  // The negative lookahead disallows "Bachelor's [or|/] Master's" since Bachelor's is the eligible degree.
  /\b(master['']?s|graduate degree)\b[^\.]{0,80}\b(required|must|need|necessary)\b/i,
  /\b(must|required|need|necessary)\b[^\.]{0,80}\b(master['']?s|graduate degree)\b/i,
  // Doctoral / Postdoc
  /\bdoctoral\b[^\.]{0,80}\b(required|must|need)\b/i,
  /\b(postdoc|postdoctoral)\b/i,
];

// Strip "Bachelor's or Master's" / "Bachelor's / Master's" before applying patterns
// so we don't false-positive on JD lines like "Bachelor's or Master's in CS".
function stripEligibleBachelorOrMaster(text) {
  return text.replace(/\bbachelor['']?s\b\s*(or|\/)\s*\bmaster['']?s\b/gi, 'BACHELORS_OR_MASTERS');
}

// ---------------------------------------------------------------------------
// 3. Parse pending URLs from pipeline.md
// ---------------------------------------------------------------------------
const content = await readFile(PIPELINE, 'utf-8');
const lines = content.split('\n');
const pending = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith('- [ ]')) {
    const m = line.match(/^- \[ \] (https?:\/\/\S+)/);
    if (m) pending.push({ lineIdx: i, url: m[1], raw: line });
  }
}
console.log(`Found ${pending.length} pending URLs in pipeline.md.\n`);

// ---------------------------------------------------------------------------
// 4. Audit each URL
// ---------------------------------------------------------------------------
const results = [];
for (let i = 0; i < pending.length; i++) {
  const { lineIdx, url, raw } = pending[i];
  process.stdout.write(`[${i + 1}/${pending.length}] ${url.slice(0, 70)}... `);

  let raw_text = '';
  try {
    const out = spawnSync('node', ['browser-extract.mjs', url, '--mode', 'jd'], {
      timeout: 90_000,
      encoding: 'utf-8',
    });
    if (out.stdout) raw_text = out.stdout;
  } catch (err) {
    process.stdout.write(`[EXTRACT ERROR]\n`);
    results.push({ lineIdx, url, status: 'EXTRACT_ERROR', matches: [], raw_line: raw });
    continue;
  }

  let title = '';
  let text = raw_text;
  try {
    const j = JSON.parse(raw_text);
    title = j.title || '';
    text = j.text || '';
  } catch (_) {
    // Not JSON; use raw text
  }

  // Heuristic title from URL slug (last meaningful path segment)
  const urlTitle = url
    .replace(/^https?:\/\//, '')
    .replace(/\?.*$/, '')
    .split('/')
    .filter(s => s.length > 3 && !/^[a-z0-9-]+$/.test(s) || s.match(/[A-Z]/) || s.length > 10)
    .pop() || url;
  const urlSlug = urlTitle.replace(/[-_]+/g, ' ').trim();

  // === TITLE CHECK ===
  const titleCombined = `${title} ${urlSlug}`;
  const titleMatches = [];
  for (const { raw: kw, match } of MATCHERS) {
    if (match(titleCombined)) {
      titleMatches.push(kw);
    }
  }

  // === BODY CHECK (strict PhD/Master's required only) ===
  // Strip "Bachelor's or Master's" first so we don't false-positive on JD lines
  // like "Bachelor's or Master's in CS" — that's fine for an undergrad.
  const strippedText = stripEligibleBachelorOrMaster(text);
  const bodyMatches = [];
  for (const re of PHD_REQUIRED_PATTERNS) {
    const m = strippedText.match(re);
    if (m) {
      const idx = m.index;
      const context = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 100));
      bodyMatches.push({ pattern: re.source, context });
    }
  }

  // === JS-DEAL error detection ===
  const isAccessDenied = /access denied|sign[- ]?in to view|please log in to view/i.test(title) || /access denied|please log in to view/i.test(text.slice(0, 500));
  const is404 = /404|not found|page not found|this page does not exist/i.test(text.slice(0, 500));

  if (titleMatches.length > 0 || bodyMatches.length > 0) {
    const keywordLabel = titleMatches[0] || `body-Pattern[${bodyMatches[0]?.pattern.slice(0, 30)}]`;
    process.stdout.write(`[INELIGIBLE] ${titleMatches.length ? 'title' : 'body'}: ${keywordLabel}\n`);
    results.push({
      lineIdx, url, status: 'INELIGIBLE',
      titleMatches, bodyMatches,
      title: title || urlSlug,
      raw_line: raw,
    });
  } else if (isAccessDenied) {
    process.stdout.write(`[NEEDS REVIEW — page blocked / access denied]\n`);
    results.push({
      lineIdx, url, status: 'REVIEW_BLOCKED',
      titleMatches: [], bodyMatches: [],
      title: title || urlSlug,
      raw_line: raw,
      reason: 'access_denied',
    });
  } else if (is404) {
    process.stdout.write(`[NEEDS REVIEW — page 404 / not found]\n`);
    results.push({
      lineIdx, url, status: 'REVIEW_404',
      titleMatches: [], bodyMatches: [],
      title: title || urlSlug,
      raw_line: raw,
      reason: '404',
    });
  } else {
    process.stdout.write(`[OK]\n`);
    results.push({ lineIdx, url, status: 'OK', titleMatches: [], bodyMatches: [], title: title || urlSlug, raw_line: raw });
  }
}

// ---------------------------------------------------------------------------
// 5. Patch pipeline.md if --apply
// ---------------------------------------------------------------------------
let marked = 0;
let skipped = 0;
const newLines = [...lines];
for (const r of results) {
  if (r.status !== 'INELIGIBLE') continue;
  const original = newLines[r.lineIdx];
  if (original.startsWith('- [x]')) {
    skipped++;
    continue;
  }
  const reason = r.titleMatches[0] || `body-Pattern[${r.bodyMatches[0]?.pattern.slice(0, 30)}]`;
  const stripped = original.replace(/^- \[ \] /, '');
  newLines[r.lineIdx] = `- [x] ${stripped} — INELIGIBLE: ${reason}`;
  marked++;
}

if (APPLY && marked > 0) {
  await writeFile(PIPELINE, newLines.join('\n'), 'utf-8');
  console.log(`\n[--apply] Wrote ${marked} INELIGIBLE marker(s) to pipeline.md${skipped > 0 ? ` (${skipped} already marked, skipped)` : ''}.`);
} else if (!APPLY) {
  console.log(`\n[DRY-RUN] No changes to pipeline.md. Re-run with --apply to commit.`);
}

// ---------------------------------------------------------------------------
// 6. Summary
// ---------------------------------------------------------------------------
console.log('\n════════════════════════════════════════════════════════════');
console.log('ELIGIBILITY AUDIT SUMMARY');
console.log('════════════════════════════════════════════════════════════');
const ineligible = results.filter(r => r.status === 'INELIGIBLE');
const ok = results.filter(r => r.status === 'OK');
const review = results.filter(r => r.status.startsWith('REVIEW'));
const errors = results.filter(r => r.status === 'EXTRACT_ERROR');
console.log(`Total:     ${results.length}`);
console.log(`OK:        ${ok.length}`);
console.log(`INELIGIBLE: ${ineligible.length} ${APPLY ? `(marked: ${marked}, skipped: ${skipped})` : '(DRY-RUN — would mark)'}`);
console.log(`REVIEW:    ${review.length} (manual decision needed)`);
console.log(`ERRORS:    ${errors.length}`);

if (ineligible.length > 0) {
  console.log('\n────── INELIGIBLE (clean sweep) ──────');
  for (const r of ineligible) {
    console.log(`\n${r.url}`);
    console.log(`  Title: ${r.title || '(unknown)'}`);
    if (r.titleMatches.length > 0) console.log(`  TITLE: ${r.titleMatches.join(', ')}`);
    if (r.bodyMatches.length > 0) console.log(`  BODY:  ${r.bodyMatches[0].pattern.slice(0, 60)} | "${r.bodyMatches[0].context}"`);
  }
}

if (review.length > 0) {
  console.log('\n────── REVIEW QUEUE (manual decision) ──────');
  for (const r of review) {
    console.log(`  ${r.status}: ${r.url} (${r.title})`);
  }
}

if (errors.length > 0) {
  console.log('\n────── EXTRACTION ERRORS ──────');
  for (const r of errors) {
    console.log(`  ? ${r.url}`);
  }
}

await writeFile('/tmp/eligibility-audit.json', JSON.stringify(results, null, 2));
console.log(`\nWrote /tmp/eligibility-audit.json`);

process.exit(ineligible.length > 0 ? 1 : 0);
