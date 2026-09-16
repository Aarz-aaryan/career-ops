#!/usr/bin/env node
/**
 * pipeline-health.mjs — one authoritative health check for the whole pipeline.
 *
 * ROUND-66 (2026-09-16). Checks were scattered across the cron prompt, the
 * watchdog and three audit scripts, each knowing part of what "healthy" means.
 * Several real faults slipped through for days because no single check looked at
 * the end result: rows existed, so the watchdog passed, while 41 of 45 resume
 * links silently 404'd.
 *
 * Exit codes: 0 = healthy, 1 = problems found, 2 = could not run the checks.
 * Usage: node pipeline-health.mjs [--json] [--quick]   (--quick skips link HTTP checks)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { execFileSync } from 'child_process';

const host = process.env.NC_HOST, user = process.env.NC_API_USER, pass = process.env.NC_API_PASS;
if (!host || !user || !pass) { console.error('ERROR: NC_HOST/NC_API_USER/NC_API_PASS not set'); process.exit(2); }
const BASE = `http://${host}:9080`;
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const JSON_OUT = process.argv.includes('--json');
const QUICK = process.argv.includes('--quick');
const today = new Date().toISOString().slice(0, 10);

const problems = [], notes = [];
const fail = (k, m) => problems.push(`${k}: ${m}`);
const note = (k, m) => notes.push(`${k}: ${m}`);

const api = async (p) => {
  const r = await fetch(`${BASE}/apps/tables/api/1${p}`, { headers: { Authorization: auth, 'OCS-APIRequest': 'true' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${p}`);
  return r.json();
};
const cellOf = (r, id) => { const c = (r.data || []).find(x => x.columnId === id); return c ? c.value : null; };
const urlOf = (v) => { if (!v || String(v) === 'None') return ''; try { return JSON.parse(v).value || ''; } catch { return String(v); } };

let rows;
try { rows = await api('/tables/8/rows'); } catch (e) { console.error('ERROR: cannot read table 8 —', e.message); process.exit(2); }
note('rows', `${rows.length} in table 8`);

// 1. required columns present on every row
const REQUIRED = { 144: 'Company', 145: 'Role', 146: 'JobLink', 148: 'Resume', 155: 'Score' };
const gaps = [];
for (const r of rows) {
  const missing = Object.entries(REQUIRED).filter(([id]) => { const v = cellOf(r, Number(id)); return !v || String(v) === 'None'; }).map(([, n]) => n);
  if (missing.length) gaps.push(`row ${r.id} missing ${missing.join(',')}`);
}
if (gaps.length) fail('columns', `${gaps.length} row(s) incomplete — ${gaps.slice(0, 3).join('; ')}`);

// 2. no duplicate (company, role)
const seen = new Map();
for (const r of rows) {
  const k = `${cellOf(r, 144)}|${cellOf(r, 145)}`;
  seen.set(k, (seen.get(k) || 0) + 1);
}
const dupes = [...seen.entries()].filter(([, n]) => n > 1);
if (dupes.length) fail('duplicates', `${dupes.length} duplicate company/role pair(s)`);

// 3. resume links actually resolve — the check whose absence hid a real fault
if (!QUICK) {
  let ok = 0; const broken = [];
  for (const r of rows) {
    const u = urlOf(cellOf(r, 148));
    if (!u || !u.endsWith('.pdf')) { broken.push(`row ${r.id} (not a pdf url)`); continue; }
    try {
      const res = await fetch(u, { method: 'GET', headers: { Authorization: auth } });
      res.ok ? ok++ : broken.push(`row ${r.id} -> HTTP ${res.status}`);
    } catch (e) { broken.push(`row ${r.id} -> ${e.message}`); }
  }
  note('resume links', `${ok}/${rows.length} resolve`);
  if (broken.length) fail('resume links', `${broken.length} broken — ${broken.slice(0, 3).join('; ')}`);
}

// 3b. job links must carry a real path, not just a bare host. The same Tables
// link-column truncation that destroyed resume URLs also silently shortened at
// least one posting URL to "https://www.amazon.job" -- the tracker's primary
// purpose is getting back to the posting, so a bare host is a dead entry.
const truncated = [];
for (const r of rows) {
  const u = urlOf(cellOf(r, 146));
  const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(u || '');
  const path = m && m[1] ? m[1] : '';
  if (!u || !path || path === '/') truncated.push(`row ${r.id} (${cellOf(r, 144)}) -> ${u || 'empty'}`);
}
note('job links', `${rows.length - truncated.length}/${rows.length} carry a real path`);
if (truncated.length) fail('job links', `${truncated.length} truncated/empty — ${truncated.slice(0, 3).join('; ')}`);

// 4. today's output actually happened
try {
  const pdfsToday = readdirSync('output').filter(f => f.endsWith('.pdf') &&
    new Date(statSync(`output/${f}`).mtime).toISOString().slice(0, 10) === today);
  const pending = readFileSync('data/pipeline.md', 'utf8').split('\n').filter(l => l.startsWith('- [ ] ')).length;
  note('queue', `${pending} pending`);
  note('today', `${pdfsToday.length} PDF(s) generated`);
  if (pdfsToday.length === 0 && pending > 0) fail('output', `no PDFs generated today while ${pending} entries are pending`);
  if (pending === 0) fail('queue', 'pending queue is EMPTY — the pipeline has nothing to process');
} catch (e) { fail('output', `could not inspect output/ or pipeline.md — ${e.message}`); }

// 5. every recent PDF is traceable to a report (pairing integrity)
try {
  const recent = readdirSync('output').filter(f => f.endsWith('.pdf') &&
    Date.now() - statSync(`output/${f}`).mtimeMs < 7 * 86400000);
  const reportBlob = readdirSync('reports').filter(f => f.endsWith('.md'))
    .map(f => readFileSync(`reports/${f}`, 'utf8')).join('\n');
  const untraceable = recent.filter(f => !reportBlob.includes(f));
  note('pairing', `${recent.length} PDF(s) in last 7d, ${untraceable.length} untraceable`);
  if (untraceable.length) fail('pairing', `${untraceable.length} recent PDF(s) no report names — they can never become rows: ${untraceable.slice(0, 2).join(', ')}`);
} catch (e) { note('pairing', `skipped (${e.message})`); }

// 5b. house-rule compliance (modes/_custom.md). These are policy invariants, and
// nothing previously enforced them -- a drifting pre-screen or a changed score
// threshold would silently start producing applications Aaryan does not want.
const SCORE_FLOOR = 4.0;
const lowScored = rows.filter(r => { const v = cellOf(r, 155); return v != null && Number(v) < SCORE_FLOOR; });
if (lowScored.length) {
  fail('score floor', `${lowScored.length} row(s) below ${SCORE_FLOOR} (Off-Limits #4: never apply below 4.0) — rows ${lowScored.slice(0, 4).map(r => r.id).join(', ')}`);
}
// Off-Limits #8: prop-trading firms and defense contractors are a hard block.
// The title filter cannot catch these because they are company names, not titles.
const BLOCKED = ['citadel', 'jane street', 'two sigma', 'hudson river', 'jump trading',
  'lockheed', 'raytheon', 'northrop', 'general dynamics', 'booz allen', 'leidos',
  'anduril', 'l3harris', 'bae systems'];
const blockedHits = [];
for (const r of rows) {
  const co = String(cellOf(r, 144) || '').toLowerCase();
  const hit = BLOCKED.find(b => co.includes(b));
  if (hit) blockedHits.push(`row ${r.id} (${cellOf(r, 144)})`);
}
if (blockedHits.length) {
  fail('dealbreakers', `${blockedHits.length} blocked employer(s) in the table (Off-Limits #8) — ${blockedHits.slice(0, 3).join('; ')}`);
}
note('house rules', `score floor ${SCORE_FLOOR}: ${rows.length - lowScored.length}/${rows.length} pass; dealbreakers: ${blockedHits.length}`);

// 6. table structural integrity (rows vs sleeves vs drift)
try {
  const audit = JSON.parse(execFileSync('bash', ['scripts/tables-audit.sh'], { encoding: 'utf8' }).trim().split('\n').pop());
  note('structure', `rows=${audit.rows} sleeves=${audit.sleeves} orphans=${audit.rows_without_cells} drift=${audit.api_db_drift}`);
  if (audit.rows_without_cells > 0) fail('structure', `${audit.rows_without_cells} orphan row(s)`);
  if (audit.orphan_sleeves > 0) fail('structure', `${audit.orphan_sleeves} orphan sleeve(s)`);
  if (audit.api_db_drift !== 0) fail('structure', `API/DB drift = ${audit.api_db_drift}`);
} catch (e) { fail('structure', `tables-audit.sh failed — ${e.message}`); }

if (JSON_OUT) {
  console.log(JSON.stringify({ healthy: problems.length === 0, problems, notes }, null, 2));
} else {
  for (const n of notes) console.log(`  ${n}`);
  console.log('');
  if (problems.length) { for (const p of problems) console.log(`  PROBLEM  ${p}`); }
  else console.log('  HEALTHY — all checks passed');
}
process.exit(problems.length ? 1 : 0);
