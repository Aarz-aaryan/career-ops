#!/usr/bin/env node
/**
 * repair-links.mjs — repair Resume Used (col 148) on existing rows.
 *
 * ROUND-64: rows written since ~round 53 carry a truncated or null resume link,
 * because (a) nothing uploaded the PDF and (b) a Tables link column discards the
 * path of any URL with an explicit port. Re-uploads each row's PDF and rewrites
 * the link port-less. Only touches existing rows -- creates nothing.
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';

const host = process.env.NC_HOST, user = process.env.NC_API_USER, pass = process.env.NC_API_PASS;
const BASE = `http://${host}:9080/apps/tables/api/1`;
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const PUBLIC = 'http://resource-server.tail6da67c.ts.net';
const DRY = process.argv.includes('--dry-run');

const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m,
    headers: { Authorization: auth, 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${m} ${p}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
};
const cell = (r, id) => { const c = (r.data || []).find(x => x.columnId === id); return c ? c.value : null; };
const urlOf = (v) => { if (!v) return ''; try { return JSON.parse(v).value || ''; } catch { return String(v); } };

const pdfs = readdirSync('output').filter(f => f.endsWith('.pdf'));
const rows = await api('GET', '/tables/8/rows');
let fixed = 0, already = 0, nofile = 0;

for (const r of rows) {
  const cur = urlOf(cell(r, 148));
  if (cur.startsWith(PUBLIC) && cur.endsWith('.pdf')) { already++; continue; }

  // locate the PDF: prefer the report number recorded in Notes, else the filename in the old URL
  const notes = String(cell(r, 160) || '');
  const num = (notes.match(/report #(\d+)/) || [])[1];
  let file = null;
  if (cur.endsWith('.pdf')) { const b = cur.split('/').pop(); if (pdfs.includes(b)) file = b; }
  if (!file && num) file = pdfs.find(f => f.startsWith(`cv-aaryan-${num}-`)) || null;

  // Older PDFs are named cv-aaryan-<slug>-<date>.pdf with no report number, so
  // fall back to matching on the company slug. Only an UNAMBIGUOUS match is
  // accepted -- attaching the wrong resume to an application is worse than
  // leaving the link broken, so ambiguous cases are reported for a human.
  if (!file) {
    const slug = String(cell(r, 144) || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug) {
      let cands = pdfs.filter(f => f.includes(`-${slug}-`));
      if (cands.length > 1) {
        const roleWords = String(cell(r, 145) || '').toLowerCase().match(/[a-z]{4,}/g) || [];
        const scored = cands
          .map(f => ({ f, n: roleWords.filter(w => f.includes(w)).length }))
          .sort((a, b) => b.n - a.n);
        if (scored.length && scored[0].n > 0 && (scored.length === 1 || scored[0].n > scored[1].n)) {
          cands = [scored[0].f];
        }
      }
      if (cands.length === 1) file = cands[0];
      else if (cands.length > 1) {
        console.log(`  AMBIGUOUS row ${r.id} (${cell(r,144)} / ${String(cell(r,145)).slice(0,34)}): ${cands.length} candidates`);
      }
    }
  }
  if (!file) { nofile++; console.log(`  no PDF for row ${r.id} (${cell(r,144)})`); continue; }

  if (DRY) { console.log(`  would fix row ${r.id} (${cell(r,144)}) -> ${file}`); fixed++; continue; }
  try { execFileSync('bash', ['scripts/upload-to-nextcloud.sh', `output/${file}`], { stdio: 'ignore' }); }
  catch { console.log(`  upload failed for ${file}`); }
  await api('PUT', `/rows/${r.id}`, { data: { 148: `${PUBLIC}/remote.php/dav/files/${user}/${file}` } });
  fixed++;
}
console.log(`  repaired: ${fixed}   already OK: ${already}   no PDF found: ${nofile}`);
