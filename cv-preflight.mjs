#!/usr/bin/env node
// Round-33 (2026-08-08) — grad-targeting pre-flight guard rail.
//
// Aaryan: "we dont want any phd or gradate stuff, as the internship that we want
// to come up in the search should be the ones which are looking for college student,
// as I am doind my Bachelors and I am a junior in college so I think I wont qualify
// for PhD GenAI Research Scientist Intern role"
//
// This script reads a CV JSON payload (and optionally its source filename) and
// rejects it if the role/company metadata or summary text contains grad-targeting
// keywords. Run BEFORE build-cv-html.mjs / generate-pdf.mjs.
//
// Usage:
//   node cv-preflight.mjs <input.json> [--source-name <name>]
//
// Exit codes:
//   0 = OK, proceed to PDF generation
//   2 = BLOCKED — grad-targeting keyword found, message printed to stderr
//   1 = Usage / read error
//
// What it scans:
//   - Summary text (the role description typically appears there)
//   - Source filename (if --source-name passed)
//
// What it does NOT scan:
//   - Internal section names like "experience" / "projects"
//   - Bullet content (an internship might mention "PhD-level work" in a bullet
//     even if the role is undergrad-targeted — we want to allow that)

import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { buildTitleFilter } from './scan.mjs';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.error('Usage: node cv-preflight.mjs <input.json> [--source-name <name>]');
  console.error('Exit codes: 0 = OK, 2 = BLOCKED (grad-targeting), 1 = error');
  process.exit(args.includes('--help') ? 0 : 1);
}

const inputPath = resolve(args[0]);
let sourceName = '';
const nameIdx = args.indexOf('--source-name');
if (nameIdx >= 0 && args[nameIdx + 1]) {
  sourceName = args[nameIdx + 1];
}

// Load portals.yml for the title filter
let cfg;
try {
  const fs = await import('fs');
  cfg = yaml.load(fs.readFileSync(resolve('portals.yml'), 'utf-8'));
} catch (err) {
  console.error(`preflight: failed to load portals.yml: ${err.message}`);
  process.exit(1);
}
const filter = buildTitleFilter(cfg.title_filter);

// Load JSON payload
let payload;
try {
  payload = JSON.parse(await readFile(inputPath, 'utf-8'));
} catch (err) {
  console.error(`preflight: failed to read ${inputPath}: ${err.message}`);
  process.exit(1);
}

// Extract role/title candidates from the payload
const candidates = [];

// 1. Summary text — usually contains role description
if (typeof payload.summary === 'string') {
  // Take the first sentence or up to first newline
  const firstChunk = payload.summary.split(/[.\n]/)[0].trim();
  if (firstChunk) candidates.push({ source: 'summary', text: firstChunk });
  candidates.push({ source: 'summary', text: payload.summary });
}

// 2. Source filename (if provided)
if (sourceName) {
  candidates.push({ source: 'filename', text: sourceName });
}

// Run filter against each candidate title. The filter returns true if the
// candidate would be PASSED (kept). We want REJECT (filter returns false).
const blocked = [];
for (const c of candidates) {
  if (c.source === 'filename') {
    // Filenames are concise role markers like "databricks-phd-genai".
    // The filter requires positive keywords ("Intern", "Co-op", etc.) to
    // pass — a filename without those is ambiguous. Instead, scan the
    // filename against the negative list only (presence of "phd", "graduate",
    // etc. in filename is enough to BLOCK).
    const t = c.text.toLowerCase();
    const negativeKw = (cfg.title_filter?.negative || []).map(k => String(k).toLowerCase());
    for (const kw of negativeKw) {
      // Use same matching logic as buildTitleFilter (alpha keywords = word
      // boundary, others = substring)
      const isWord = /^[a-z]+$/.test(kw);
      const matched = isWord ? new RegExp(`\\b${kw}\\b`).test(t) : t.includes(kw);
      if (matched) {
        blocked.push({ source: 'filename', text: `${c.text} (matched keyword "${kw}")` });
        break;
      }
    }
    continue;
  }

  // For summary text: only extract fragments that LOOK like a job title —
  // they must contain a role-type keyword (Intern, Engineer, etc.).
  // Otherwise we'd feed entire summary sentences to the filter, producing
  // false positives (a sentence about applying expertise fails the positive
  // check).
  const ROLE_KEYWORDS = /(?:Intern|Engineer|Developer|Scientist|Researcher|Manager|Analyst|Architect|Designer|Programmer|Consultant|Associate|Specialist)/i;
  const roleGuess = c.text
    .replace(/\n+/g, ' ')
    .split(/[.;]/)
    .map(s => s.trim())
    .filter(s => s.length >= 5 && s.length <= 200)
    .filter(s => ROLE_KEYWORDS.test(s));

  for (const guess of roleGuess) {
    // Try the filter — if it returns FALSE, the role was BLOCKED.
    if (!filter(guess)) {
      blocked.push({ source: c.source, text: guess });
    }
  }
}

if (blocked.length > 0) {
  console.error(`preflight BLOCKED: grad-targeting role detected in ${inputPath}`);
  for (const b of blocked) {
    console.error(`  [${b.source}] "${b.text}"`);
  }
  console.error('');
  console.error('Aaryan is a Bachelor\'s junior. PhD/Graduate/MBA/Postdoc/MS internships are out of scope.');
  console.error('Edit portals.yml title_filter.negative if this role should be allowed.');
  process.exit(2);
}

console.log('preflight OK');
process.exit(0);
