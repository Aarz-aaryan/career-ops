#!/usr/bin/env node
/**
 * prune-stale-pending.mjs — retire pending pipeline.md entries whose posting is
 * older than portals.yml `max_posting_age_days`.
 *
 * ROUND-64 (2026-09-16). The pending queue grows ~90/day and the pipeline
 * consumes ~5/day, so it had reached 2,082 entries, 57% of them older than the
 * 90-day cutoff the scanner itself enforces. agy's liveness sweep walks that
 * list every run; on 2026-09-15 it consumed the entire 30-minute budget and the
 * run produced ZERO applications while still reporting "ok".
 *
 * Entries are marked done with a reason, never deleted, so the audit trail and
 * scan-history dedupe both stay intact.
 *
 * Usage:
 *   node prune-stale-pending.mjs [--dry-run] [--max-age-days N] [--file PATH]
 */
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { load } from 'js-yaml';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const fileArg = args.indexOf('--file');
const FILE = fileArg >= 0 ? args[fileArg + 1] : 'data/pipeline.md';
const ageArg = args.indexOf('--max-age-days');

let maxAge = ageArg >= 0 ? Number(args[ageArg + 1]) : null;
if (maxAge === null) {
  try { maxAge = Number(load(readFileSync('portals.yml', 'utf8')).max_posting_age_days) || 90; }
  catch { maxAge = 90; }
}
if (!Number.isFinite(maxAge) || maxAge <= 0) {
  console.error(`ERROR: invalid max age: ${maxAge}`); process.exit(2);
}

const cutoffMs = Date.now() - maxAge * 86400000;
const cutoffStr = new Date(cutoffMs).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

const src = readFileSync(FILE, 'utf8');
const lines = src.split('\n');
let pruned = 0, kept = 0, undated = 0;

const out = lines.map((line) => {
  if (!line.startsWith('- [ ] ')) return line;
  const m = line.match(/posted:\s*(\d{4}-\d{2}-\d{2})/);
  if (!m) { undated++; return line; }
  if (Date.parse(m[1]) >= cutoffMs) { kept++; return line; }
  pruned++;
  // Match the existing convention: - [x] ~~<url>~~ — <reason>
  const url = (line.match(/- \[ \]\s+(\S+)/) || [])[1] || '';
  const rest = line.slice(line.indexOf(url) + url.length);
  return `- [x] ~~${url}~~${rest} — expired: posted ${m[1]}, older than max_posting_age_days=${maxAge} (auto-prune ${today})`;
});

console.log(`  file:            ${FILE}`);
console.log(`  max age:         ${maxAge} days (cutoff ${cutoffStr})`);
console.log(`  pending kept:    ${kept}`);
console.log(`  pending pruned:  ${pruned}`);
console.log(`  undated (kept):  ${undated}`);

if (DRY) { console.log('  (dry run — no changes written)'); process.exit(0); }
if (pruned === 0) { console.log('  nothing to prune'); process.exit(0); }

copyFileSync(FILE, `${FILE}.bak-${today}`);
writeFileSync(FILE, out.join('\n'));
console.log(`  backup:          ${FILE}.bak-${today}`);
console.log(`  written.`);
