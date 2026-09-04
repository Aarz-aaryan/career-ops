// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Apple Jobs provider — Round-55 (2026-09-04).
// Hits the undocumented /api/v1/search endpoint at jobs.apple.com.
// NO anti-bot (verified live 2026-09-04, HTTP 200 with proper CSRF, no Cloudflare).
//
// Two-step flow:
//   1. GET /api/v1/CSRFToken → read x-apple-csrf-token header
//   2. POST /api/v1/search with that token + body { query, filters, page, locale, sort, format }
// Response: { res: { searchResults: [{ id, positionId, postingTitle, team, teamCode,
//                    postDate, refNumber, jobSummary, locations:[{name}] }],
//                    totalRecords: N } }
// Pagination: 20/page via `page` (1-based). Loop until totalRecords hit.
//
// Cross-referenced against github.com/ever-jobs/ever-jobs source-company-apple
// (live-verified via curl from this host before shipping).

import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const BASE = 'https://jobs.apple.com';
const API_BASE = `${BASE}/api/v1`;
const CSRF_ENDPOINT = `${API_BASE}/CSRFToken`;
const SEARCH_ENDPOINT = `${API_BASE}/search`;
const PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 100; // 100 pages * 20 = 2000 postings max per entry

const INTER_PAGE_DELAY_MS = 300; // Slightly higher than MS — Apple has more aggressive JS pre-fetch.

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((r) => setTimeout(r, ms));
}

async function getCsrfToken(ctx) {
  const fetchFn = typeof ctx?.fetchJson === 'function' ? ctx.fetchJson : null;
  const headers = {
    'user-agent': BROWSER_LIKE_USER_AGENT,
    accept: 'application/json, text/plain, */*',
    origin: BASE,
    referer: `${BASE}/en-us/search`,
  };
  let token;
  if (fetchFn) {
    // ctx.fetchJson may not give us headers — fall back to plain fetch.
    const resp = await fetch(CSRF_ENDPOINT, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching CSRF token`);
    token = resp.headers.get('x-apple-csrf-token');
  } else {
    const resp = await fetch(CSRF_ENDPOINT, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching CSRF token`);
    token = resp.headers.get('x-apple-csrf-token');
  }
  if (!token) throw new Error('apple: CSRF endpoint returned no x-apple-csrf-token header');
  return token;
}

/**
 * Map an Apple searchResults item to canonical Job shape.
 * URL: postingUrl (relative like "/en-us/details/200681918/...") → prepend host.
 *
 * Location handling: Apple's API returns locations[] with city/state/country.
 * The downstream `portals.yml::location_filter.allow` list (e.g. ["United States",
 * "USA", "Cambridge", "Boston"]) needs to be able to match by city OR country
 * name, so we concatenate city + country. For US jobs the string will be
 * "Cupertino, United States of America" which matches both "United States" and
 * any specific US city in the allow list.
 */
function toCanonicalJob(item) {
  const title = item.postingTitle || item.title || '';
  const relativeUrl = item.postingUrl || item.url || (item.id ? `/en-us/details/${item.id}` : '');
  const url = relativeUrl.startsWith('http')
    ? relativeUrl
    : `${BASE}${relativeUrl.startsWith('/') ? '' : '/'}${relativeUrl}`;
  const locations = Array.isArray(item.locations) ? item.locations.filter(Boolean) : [];
  const locStrings = locations.map((l) => {
    const parts = [l.name, l.countryName].filter(Boolean);
    return parts.join(', ');
  }).filter(Boolean);
  const location = locStrings.join(' | ') || item.location || '';
  const postedAt = item.postDate ? Date.parse(item.postDate) : undefined;
  return {
    title: String(title).trim(),
    url,
    company: 'Apple',
    location,
    postedAt: Number.isFinite(postedAt) ? postedAt : undefined,
  };
}

/** @type {Provider} */
export default {
  id: 'apple',

  detect(entry) {
    if (entry?.provider === 'apple') return { url: SEARCH_ENDPOINT };
    const u = entry?.careers_url || '';
    if (u.includes('jobs.apple.com')) return { url: SEARCH_ENDPOINT };
    return null;
  },

  /**
   * @param {{ name?: string, careers_url?: string, provider?: string,
   *           max_pages?: number, query?: string, sort?: string,
   *           filters?: object }} entry
   * @param {{ fetchJson?: (url: string, opts?: object) => Promise<any>, sleep?: (ms: number) => Promise<void> }} ctx
   */
  async fetch(entry, ctx) {
    const maxPages = Number.isInteger(entry?.max_pages) && entry.max_pages > 0 ? entry.max_pages : DEFAULT_MAX_PAGES;
    const query = String(entry?.query || '').trim();
    const sort = String(entry?.sort || 'RELEVANCE');
    const filters = entry?.filters && typeof entry.filters === 'object' ? entry.filters : { range: { filterField: 'startDate', from: null, to: null } };

    const token = await getCsrfToken(ctx);

    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = {
        query,
        filters,
        page,
        locale: 'en-us',
        sort,
        format: 'json',
      };
      const headers = {
        'user-agent': BROWSER_LIKE_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        origin: BASE,
        referer: `${BASE}/en-us/search`,
        browserlocale: 'en-us',
        locale: 'EN_US',
        'x-apple-csrf-token': token,
      };

      let raw;
      try {
        const resp = await fetch(SEARCH_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) {
          // If the CSRF token rotated, refresh and retry once.
          if (resp.status === 401 || resp.status === 403) {
            const fresh = await getCsrfToken(ctx);
            headers['x-apple-csrf-token'] = fresh;
            const retry = await fetch(SEARCH_ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!retry.ok) throw new Error(`HTTP ${retry.status} after CSRF retry`);
            raw = await retry.json();
          } else {
            throw new Error(`HTTP ${resp.status}`);
          }
        } else {
          raw = await resp.json();
        }
      } catch (err) {
        throw new Error(`apple: page ${page} fetch failed — ${err?.message || err}`);
      }

      const results = raw?.res?.searchResults || [];
      for (const item of results) out.push(toCanonicalJob(item));

      const total = raw?.res?.totalRecords ?? null;
      if (results.length < PAGE_SIZE) break;
      if (total != null && page * PAGE_SIZE >= total) break;
      if (page < maxPages) await sleep(INTER_PAGE_DELAY_MS, ctx);
    }

    return out;
  },
};
