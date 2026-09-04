// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Microsoft Careers provider — Round-55 (2026-09-04).
// Hits the undocumented PCSX/Eightfold JSON endpoint at apply.careers.microsoft.com.
// NO anti-bot (verified live 2026-09-04, HTTP 200, no Cloudflare/Akamai challenge).
// REST GET, paginated 10/page via `start` offset. Public careers page is a UI
// over this exact endpoint — no robots.txt block observed.
//
// Endpoint: https://apply.careers.microsoft.com/api/pcsx/search
//   Query params: domain=microsoft.com, query=keyword, location=string,
//                 start=offset, sort_by=timestamp (or relevance), filter=...
// Response: { data: { positions: [{ id, displayJobId, name, postingUrl, ...
//                                  properties: { jobDescription, primaryLocation, ...} }], total: N } }
//
// Cross-referenced against github.com/ever-jobs/ever-jobs source-company-microsoft
// (live-verified via curl from this host before shipping).

import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const ENDPOINT = 'https://apply.careers.microsoft.com/api/pcsx/search';
const PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 50; // 50 pages * 10 = 500 postings max per entry — caps WAF risk

const INTER_PAGE_DELAY_MS = 1500; // Microsoft's PCSX WAF soft-rate-limits at burst; observed 429s after ~5 quick requests. 1.5s/page keeps us under threshold.

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse `Retry-After` header (seconds OR HTTP-date) → ms, or null. */
function parseRetryAfterMs(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/**
 * Map a Microsoft position payload to canonical Job shape.
 * Live API shape (verified 2026-09-04):
 *   { id, displayJobId, name, locations: [string], standardizedLocations: [string],
 *     postedTs: <unix-seconds>, department, atsJobId, positionUrl: "/careers/job/<id>" }
 *
 * Location handling: Microsoft's API returns BOTH:
 *   - `locations`: ["United States, Washington, Redmond"]  (country + state + city)
 *   - `standardizedLocations`: ["Redmond, WA, US"]  (city + state + country code)
 * We prefer `locations` because it contains the literal "United States" string,
 * which matches downstream `portals.yml::location_filter.allow` patterns.
 * For multi-location jobs we join all entries with " | " separator.
 */
function toCanonicalJob(p, entry) {
  const title = String(p.name || '').trim();
  const relativeUrl = p.positionUrl || (p.id ? `/careers/job/${p.id}` : '');
  const url = relativeUrl.startsWith('http')
    ? relativeUrl
    : `https://apply.careers.microsoft.com${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
  // Prefer `locations` (has country name like "United States"), fall back to standardizedLocations.
  const richLocs = Array.isArray(p.locations) ? p.locations.filter(Boolean) : [];
  const stdLocs = Array.isArray(p.standardizedLocations) ? p.standardizedLocations.filter(Boolean) : [];
  const location = richLocs.length > 0 ? richLocs.join(' | ') : stdLocs.join(' | ');
  // postedTs is unix seconds; convert to ms.
  const postedAt = Number.isFinite(p.postedTs) ? p.postedTs * 1000 : undefined;
  return {
    title,
    url,
    company: 'Microsoft',
    location,
    postedAt,
  };
}

/** @type {Provider} */
export default {
  id: 'microsoft',

  detect(entry) {
    if (entry?.provider === 'microsoft') return { url: ENDPOINT };
    const u = entry?.careers_url || '';
    if (u.includes('apply.careers.microsoft.com') || u.includes('careers.microsoft.com')) {
      return { url: ENDPOINT };
    }
    return null;
  },

  /**
   * @param {{ name?: string, careers_url?: string, provider?: string,
   *           max_pages?: number, query?: string, location?: string,
   *           filter?: string }} entry
   * @param {{ fetchJson?: (url: string, opts?: object) => Promise<any>, sleep?: (ms: number) => Promise<void> }} ctx
   */
  async fetch(entry, ctx) {
    const fetchFn = typeof ctx?.fetchJson === 'function' ? ctx.fetchJson : null;
    const maxPages = Number.isInteger(entry?.max_pages) && entry.max_pages > 0 ? entry.max_pages : DEFAULT_MAX_PAGES;
    const query = String(entry?.query || '').trim();

    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const start = page * PAGE_SIZE;
      const params = new URLSearchParams({
        domain: 'microsoft.com',
        query,
        location: String(entry?.location || ''),
        filter: String(entry?.filter || ''),
        start: String(start),
        sort_by: 'timestamp',
      });
      const url = `${ENDPOINT}?${params.toString()}`;

      // 429 retry loop (max 3 attempts with Retry-After honoring).
      let raw = null;
      for (let attempt = 0; attempt < 3 && !raw; attempt++) {
        try {
          if (fetchFn) {
            raw = await fetchFn(url, { headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'application/json, text/plain, */*' }, timeoutMs: 30_000 });
          } else {
            const resp = await fetch(url, { headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'application/json, text/plain, */*' } });
            if (resp.status === 429) {
              const wait = parseRetryAfterMs(resp.headers.get('retry-after')) || (2000 * (attempt + 1));
              await sleep(wait, ctx);
              continue; // retry
            }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            raw = await resp.json();
          }
        } catch (err) {
          throw new Error(`microsoft: page ${page} fetch failed — ${err?.message || err}`);
        }
      }
      if (!raw) throw new Error(`microsoft: page ${page} gave up after 3 retries (429 burst)`);

      const positions = raw?.data?.positions || [];
      for (const p of positions) out.push(toCanonicalJob(p, entry));

      // Stop when this page came back short or when we hit the reported count.
      // Microsoft's API exposes the grand total as `data.count`.
      const total = raw?.data?.count ?? raw?.count ?? null;
      if (positions.length < PAGE_SIZE) break;
      if (total != null && start + positions.length >= total) break;
      if (page < maxPages - 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
    }

    return out;
  },
};
