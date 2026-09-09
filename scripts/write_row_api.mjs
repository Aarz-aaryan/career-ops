#!/usr/bin/env node
/**
 * write_row_api.mjs — write a job row into Nextcloud Tables via the PUBLIC REST API.
 *
 * Added 2026-09-09 (round 60). Replaces write_row.sh + write_row.php, which
 * connected straight to Nextcloud's database from inside the container. That
 * approach required injecting PHP into the container and bind-mounting it, and
 * it broke on every Nextcloud upgrade (the 34.0.3 upgrade wiped /var/www/html).
 * It also had to be rewritten when the backend moved from SQLite to MariaDB.
 *
 * This version touches nothing inside Nextcloud: it is pure HTTP against the
 * documented API, so Nextcloud can stay completely stock and be upgraded freely.
 *
 * Idempotent: find-or-create on (Company, Role), same contract as before.
 *
 * Usage: node write_row_api.mjs <company> <role> <jobUrl> <pdfUrl> <score> [tier] [source] [notes]
 * Env:   NC_HOST, NC_API_USER, NC_API_PASS (loaded by scripts/_nc-creds.sh)
 */
const TABLE_ID = 8;
const COL = { company:144, role:145, jobLink:146, resume:148, status:149, confidence:150,
              tier:151, workAuth:152, jobType:153, source:154, score:155, dateAdded:158, notes:160 };

const host = process.env.NC_HOST || '100.84.224.18';
const port = process.env.NC_PORT_HTTP || '9080';
const user = process.env.NC_API_USER;
const pass = process.env.NC_API_PASS;
if (!user || !pass) { console.error('ERROR: NC_API_USER / NC_API_PASS not set'); process.exit(1); }
const BASE = `http://${host}:${port}/apps/tables/api/1`;
const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

const [company, role, jobUrl, pdfUrl, scoreRaw, tier = '2', source = '6', notes = ''] = process.argv.slice(2);
if (!company || !role) { console.error('ERROR: company and role are required'); process.exit(1); }
if (!jobUrl) { console.error(`SKIP ${company}: no job URL`); process.exit(3); }


// Nextcloud's link-column validator rejects bare-IP hosts (stores NULL on an
// HTTP 200). Swap the Tailscale IP for its MagicDNS name, which it accepts.
const NC_IP = process.env.NC_HOST || '100.84.224.18';
const NC_DNS = process.env.NC_MAGICDNS || 'resource-server.tail6da67c.ts.net';
const normalizeUrl = (u) => {
  if (typeof u !== 'string' || !u) return u;
  return u.replace(new RegExp('://' + NC_IP.replace(/\./g, '\\.') + '(?=[:/]|$)'), '://' + NC_DNS);
};

const api = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: auth, 'OCS-APIRequest': 'true', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${method} ${path}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const cellValue = (row, colId) => {
  const c = (row.data || []).find(x => Number(x.columnId) === colId);
  return c ? c.value : undefined;
};

// The link columns come back as a JSON blob; compare on the plain text inside.
const plain = v => {
  if (typeof v !== 'string') return v;
  try { const o = JSON.parse(v); return o.value ?? o.resourceUrl ?? v; } catch { return v; }
};

const rows = await api('GET', `/tables/${TABLE_ID}/rows`);
const existing = rows.find(r =>
  String(cellValue(r, COL.company) ?? '').trim() === company.trim() &&
  String(cellValue(r, COL.role) ?? '').trim() === role.trim());

const data = {
  [COL.company]: company,
  [COL.role]: role,
  [COL.jobLink]: normalizeUrl(jobUrl),
  [COL.score]: Number(scoreRaw) || 0,
  [COL.dateAdded]: new Date().toISOString().slice(0, 10),
};
// NOTE (2026-09-09): a text/link column silently stores NULL when the URL host
// is a bare IP address. Measured: http://example.com/a.pdf stores fine,
// http://100.84.224.18:9080/a.pdf and https://100.84.224.18:9080/a.pdf both
// come back null with an HTTP 200. Resume PDFs are served from the Tailscale
// IP, so every one of them was being dropped. normalizeUrl() below rewrites a
// bare-IP host to the MagicDNS name, which the validator accepts. The direct
// SQL writer never hit this because it bypasses validation entirely.
if (notes) data[COL.notes] = notes;
if (tier) data[COL.tier] = Number(tier);
if (source) data[COL.source] = Number(source);

let rowId;
if (existing) {
  rowId = existing.id;
  await api('PUT', `/rows/${rowId}`, { data });
  console.log(`Existing row ${rowId} updated: ${company} / ${role}`);
} else {
  const created = await api('POST', `/tables/${TABLE_ID}/rows`, { data });
  rowId = created.id;
  console.log(`Created row ${rowId} for ${company} / ${role}.`);
}

// Second link column, written separately (see note above). Verify from this
// response directly: a follow-up GET can be served stale from Nextcloud's
// Redis cache and report the cell as empty when it was in fact written.
let after;
if (pdfUrl) {
  after = await api('PUT', `/rows/${rowId}`, { data: { [COL.resume]: normalizeUrl(pdfUrl) } });
} else {
  after = (await api('GET', `/tables/${TABLE_ID}/rows`)).find(r => r.id === rowId);
}

// Verify the same fields the old PHP gate checked, so behaviour is unchanged.
const missing = [];
if (!cellValue(after, COL.company)) missing.push('Company (144)');
if (!cellValue(after, COL.role)) missing.push('Role (145)');
if (!plain(cellValue(after, COL.jobLink))) missing.push('Job Link (146)');
if (cellValue(after, COL.score) === undefined || cellValue(after, COL.score) === null) missing.push('Fit Score (155)');
if (pdfUrl && !plain(cellValue(after, COL.resume))) missing.push('Resume Used (148)');
if (missing.length) {
  console.error(`CRITICAL: ${missing.join(', ')} empty for row ${rowId} — verification FAILED`);
  process.exit(2);
}
console.log(`Row ${rowId} verified: ${company} / ${role} OK`);
