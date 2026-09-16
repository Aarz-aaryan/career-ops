#!/usr/bin/env node
/**
 * repair-links.mjs — repair Resume Used (col 148) on existing table rows.
 *
 * ROUND-65 (2026-09-16): resolves a row to its PDF AUTHORITATIVELY, via the
 * evaluation report. Every report carries:
 *     # Evaluation: <Company> — <Role>
 *     **URL:** <job url>
 *     **PDF:** [<filename>](../output/<filename>)
 * Matching on the job URL is exact, so there is no filename guessing and no
 * risk of attaching the wrong resume. The previous slug-based heuristic could
 * not separate e.g. four different Merck PDFs.
 *
 * Usage: node repair-links.mjs [--dry-run]
 */
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';

const host = process.env.NC_HOST, user = process.env.NC_API_USER, pass = process.env.NC_API_PASS;
const BASE = `http://${host}:9080/apps/tables/api/1`;
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const PUBLIC = process.env.NC_PUBLIC_BASE || 'http://resource-server.tail6da67c.ts.net';
// ROUND-67: resumes live in Career-ops/Resumes, not the account root.
const RESUME_DIR = process.env.NC_RESUME_DIR || 'Career-ops/Resumes';
const DRY = process.argv.includes('--dry-run');

const api = async (m, p, b) => {
  const r = await fetch(BASE + p, { method: m,
    headers: { Authorization: auth, 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${m} ${p}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
};
const cell = (r, id) => { const c = (r.data || []).find(x => x.columnId === id); return c ? c.value : null; };
const urlOf = (v) => { if (!v || String(v) === 'None') return ''; try { return JSON.parse(v).value || ''; } catch { return String(v); } };
const norm = (u) => String(u || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

// --- index every report by its job URL and by company|role ---
const byUrl = new Map(), byPair = new Map();
for (const f of readdirSync('reports').filter(f => f.endsWith('.md'))) {
  let txt; try { txt = readFileSync(`reports/${f}`, 'utf8'); } catch { continue; }
  const pdf = (txt.match(/\*\*PDF:\*\*\s*\[([^\]]+\.pdf)\]/) || [])[1];
  if (!pdf) continue;
  const jobUrl = (txt.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1];
  const head = (txt.match(/^#\s*Evaluation:\s*(.+?)\s*[—-]\s*(.+)$/m) || []);
  if (jobUrl) byUrl.set(norm(jobUrl), pdf);
  if (head[1] && head[2]) byPair.set(`${head[1].trim().toLowerCase()}|${head[2].trim().toLowerCase()}`, pdf);
}
console.log(`  indexed ${byUrl.size} reports by job URL, ${byPair.size} by company|role`);

const rows = await api('GET', '/tables/8/rows');
let fixed = 0, already = 0, unresolved = 0;
for (const r of rows) {
  const cur = urlOf(cell(r, 148));
  if (cur.startsWith(`${PUBLIC}/remote.php/dav/files/${user}/${RESUME_DIR}/`) && cur.endsWith('.pdf')) { already++; continue; }

  const company = String(cell(r, 144) || '').trim();
  const role = String(cell(r, 145) || '').trim();
  const jobUrl = urlOf(cell(r, 146));

  let pdf = byUrl.get(norm(jobUrl)) || byPair.get(`${company.toLowerCase()}|${role.toLowerCase()}`) || null;
  if (!pdf) { unresolved++; console.log(`  UNRESOLVED row ${r.id}: ${company} / ${role.slice(0, 40)}`); continue; }
  if (!existsSync(`output/${pdf}`)) { unresolved++; console.log(`  PDF MISSING row ${r.id}: ${pdf}`); continue; }

  if (DRY) { console.log(`  would fix row ${r.id} (${company}) -> ${pdf}`); fixed++; continue; }
  try { execFileSync('bash', ['scripts/upload-to-nextcloud.sh', `output/${pdf}`], { stdio: 'ignore' }); }
  catch { console.log(`  upload failed: ${pdf}`); }
  await api('PUT', `/rows/${r.id}`, { data: { 148: `${PUBLIC}/remote.php/dav/files/${user}/${RESUME_DIR}/${pdf}` } });
  fixed++;
}
console.log(`  repaired: ${fixed}   already OK: ${already}   unresolved: ${unresolved}`);
