#!/usr/bin/env node
// Round-34 (2026-08-08) — websearch-based job scanner.
//
// Aaryan: "we need a lot more... i want more so go ahead and start working on it
// so that we have more"
//
// The career-ops scan.mjs only handles ATS providers (Greenhouse, Ashby, Workday,
// Amazon, etc.). 12 of Aaryan's target big-tech companies use custom ATS that
// have no public API (Google, Microsoft, Meta, Apple, Netflix, Tesla, etc.).
//
// This script bridges that gap by:
//   1. Reading websearch-typed entries from portals.yml (scan_method: websearch)
//   2. For each, calling the web_search tool via `websearch-helper.mjs` (or
//      writing the queries to data/websearch-queue.json for Aarz/AGY to drain)
//   3. Parsing results into normalized job records
//   4. Appending to data/scan-history.tsv (deduped by URL)
//
// Usage:
//   node websearch-scan.mjs                # run all websearch-typed entries
//   node websearch-scan.mjs --queue        # just write queries to queue, don't execute
//   node websearch-scan.mjs --company=Foo  # run only entries matching "Foo"
//
// Round-34 (2026-08-08): Initial implementation.

import { readFile, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTALS = resolve(__dirname, 'portals.yml');
const HISTORY = resolve(__dirname, 'data/scan-history.tsv');
const QUEUE = resolve(__dirname, 'data/websearch-queue.json');

const args = process.argv.slice(2);
const queueOnly = args.includes('--queue');
const companyFilter = (args.find(a => a.startsWith('--company=')) || '').split('=')[1] || null;

// Load portals.yml
const cfg = yaml.load(await readFile(PORTALS, 'utf8'));
const companies = cfg.tracked_companies || [];

// Find websearch entries
const targets = companies.filter(c => {
  if (c.enabled === false) return false;
  if (c.scan_method !== 'websearch') return false;
  if (companyFilter && !c.name.toLowerCase().includes(companyFilter.toLowerCase())) return false;
  return true;
});

console.log(`[websearch-scan] Found ${targets.length} websearch-typed entries`);
for (const t of targets) {
  console.log(`  - ${t.name} | query: ${(t.scan_query || '').slice(0, 80)}...`);
}

// === Mode 1: --queue ===
// Just dump queries for Aarz/AGY to drain later
if (queueOnly) {
  const queueData = {
    generated_at: new Date().toISOString(),
    targets: targets.map(t => ({
      name: t.name,
      careers_url: t.careers_url,
      query: t.scan_query,
      notes: t.notes,
    })),
  };
  await writeFile(QUEUE, JSON.stringify(queueData, null, 2));
  console.log(`\n[websearch-scan] Wrote queue to ${QUEUE}`);
  process.exit(0);
}

// === Mode 2: drain via `websearch-helper.mjs` ===
// The helper script calls `web_search` via Hermes runtime and returns JSON.
// We exec it synchronously per company.

const HERMES_HELPER = resolve(__dirname, 'websearch-helper.mjs');

async function callHermesWebSearch(query, limit = 10) {
  // The helper is invoked as a Node subprocess that uses Hermes' tool runtime.
  // For now, the helper implements a fallback using `web_search`-equivalent
  // behavior via shell-out to curl/duckduckgo.
  // (This is a stub — the real helper will be wired in via the orchestrator.)
  try {
    const out = execSync(`node "${HERMES_HELPER}" ${JSON.stringify(query)} --limit=${limit}`, {
      timeout: 60000,
      encoding: 'utf-8',
    });
    return JSON.parse(out);
  } catch (err) {
    console.error(`[websearch-scan] web_search failed for "${query}": ${err.message}`);
    return { results: [] };
  }
}

// === Mode 3: load existing scan-history, dedup, append ===
let historyContent = '';
if (existsSync(HISTORY)) {
  historyContent = await readFile(HISTORY, 'utf-8');
}
const existingUrls = new Set();
for (const line of historyContent.split('\n').slice(1)) {
  const parts = line.split('\t');
  if (parts[0]) existingUrls.add(parts[0]);
}

let totalFound = 0;
let totalAdded = 0;
const newLines = [];

for (const t of targets) {
  console.log(`\n[websearch-scan] Searching: ${t.name}...`);
  const result = await callHermesWebSearch(t.scan_query, 10);
  const results = result.results || [];
  console.log(`  → ${results.length} results`);
  totalFound += results.length;

  for (const r of results) {
    // Normalize to scan-history row
    const url = r.url || '';
    if (!url || existingUrls.has(url)) continue;
    if (!/jobs|career|intern|position|apply/i.test(url)) continue;

    const company = t.name;
    const title = r.title || '';
    const date = new Date().toISOString().slice(0, 10);
    newLines.push([url, date, 'websearch', title, company, 'added', r.location || ''].join('\t'));
    existingUrls.add(url);
    totalAdded++;
  }
}

// Append new lines to scan-history
if (newLines.length > 0) {
  const trailing = historyContent.endsWith('\n') ? '' : '\n';
  await appendFile(HISTORY, trailing + newLines.join('\n') + '\n');
  console.log(`\n[websearch-scan] Appended ${totalAdded} new rows to ${HISTORY}`);
}

console.log(`\n[websearch-scan] Done. Found=${totalFound} Added=${totalAdded}`);
