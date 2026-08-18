// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Simplify Jobs provider — fetches the curated Summer-Internships listing
// JSON from github.com/SimplifyJobs/Summer{2026,2027}-Internships.
//
// The JSON is a flat array of listings with metadata:
//   {company_name, title, url, locations, terms, category, is_visible,
//    active, degrees, sponsorship, ...}
//
// ROUND-34 (2026-08-08): Big-company search expansion. The repo's
// listings.json is 10.9MB and contains ~14.5k internships curated by
// Simplify + Pitt CSC, updated hourly. Without this provider, we couldn't
// reach 500+ internship matches — most are not on Greenhouse/Ashby/Lever.
//
// fetchText from entry can override which file to fetch (default: 2027).
// Default URL points at the dev branch where the auto-bot keeps listings
// fresh.
const SIMPLIFY_LISTING_URL = 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json';
const SIMPLIFY_LISTING_FALLBACK_URL = 'https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/README.md';

// Browser-like UA — GitHub raw returns 200 to UA-less clients but some
// intermediaries block empty UA.
const SIMPLIFY_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 30_000;

/** Normalize a location string to US-friendly detection (substring, lowercased). */
function locationIsUS(loc) {
  const l = String(loc || '').toLowerCase();
  if (!l) return false;
  if (l.includes('us') || l.includes('united states') || l.includes('remote')) return true;
  // Check ALL words in the location string for a state abbreviation.
  // Handles "Milpitas, CA" (city, ST), "San Jose, CA 95134" (city, ST zip), etc.
  const states = new Set(['ca', 'ny', 'tx', 'wa', 'ma', 'il', 'pa', 'fl', 'co', 'ga', 'nc', 'va', 'mi', 'oh', 'az', 'md', 'nj', 'or', 'ut', 'mn']);
  const words = l.split(/[,\s]+/);
  if (words.some(w => states.has(w))) return true;
  return false;
}

/** True if degree list says PhD-only is required (rare; only some research roles). */
function degreesPreferPhD(degrees) {
  if (!Array.isArray(degrees) || degrees.length === 0) return false;
  return degrees.some((d) => {
    const dl = String(d || '').toLowerCase();
    return dl.includes('phd') && !dl.includes('not');
  });
}

/** Map a SimplifyJobs listing to the canonical job shape. */
function listingToJob(l, entry) {
  // Simplify URLs are direct ATS URLs (Greenhouse, Ashby, Lever, workday, etc.).
  // They go through is_visible to avoid old/closed postings.
  return {
    title: l.title || '',
    url: l.url || '',
    company: l.company_name || entry.name || 'Unknown',
    location: Array.isArray(l.locations) ? l.locations.join(' | ') : '',
    postedAt: typeof l.date_posted === 'number' ? l.date_posted * 1000 : undefined,
    category: l.category || '',
    terms: Array.isArray(l.terms) ? l.terms : [],
  };
}

/** @type {Provider} */
export default {
  id: 'simplify-jobs',

  detect(entry) {
    // Auto-detect via careers_url pattern or `provider: simplify-jobs`
    if (entry?.provider === 'simplify-jobs') return { url: SIMPLIFY_LISTING_URL };
    if (typeof entry?.careers_url === 'string' &&
        entry.careers_url.includes('SimplifyJobs/Summer')) {
      return { url: entry.careers_url };
    }
    return null;
  },

  /**
   * @param {{ name?: string, careers_url?: string, provider?: string,
   *           max_results?: number, filter_terms?: string[],
   *           filter_categories?: string[], filter_us_only?: boolean,
   *           filter_active_only?: boolean, filter_visible_only?: boolean,
   *           skip_phd_only?: boolean }} entry
   * @param {{ fetchJson?: (url: string, opts?: object) => Promise<any> }} ctx
   */
  async fetch(entry, ctx) {
    const url = SIMPLIFY_LISTING_URL;
    const fetchFn = typeof ctx?.fetchJson === 'function' ? ctx.fetchJson : null;

    let raw;
    try {
      if (fetchFn) {
        raw = await fetchFn(url, { timeoutMs: FETCH_TIMEOUT_MS, headers: { 'user-agent': SIMPLIFY_USER_AGENT } });
      } else {
        // Fallback: use global fetch if available (Node 18+).
        const resp = await fetch(url, { headers: { 'user-agent': SIMPLIFY_USER_AGENT } });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
        raw = await resp.json();
      }
    } catch (err) {
      throw new Error(`simplify-jobs: failed to fetch listing — ${err?.message || err}`);
    }

    if (!Array.isArray(raw)) {
      throw new Error(`simplify-jobs: expected array, got ${typeof raw}`);
    }

    // Apply entry-level filters (defaults: visible+tech+US+bachelor's).
    const visibleOnly = entry?.filter_visible_only !== false;
    const activeOnly = entry?.filter_active_only === true; // off by default — active flag is sparse
    const usOnly = entry?.filter_us_only !== false;
    const skipPhD = entry?.skip_phd_only !== false;
    const allowedCats = Array.isArray(entry?.filter_categories) && entry.filter_categories.length > 0
      ? new Set(entry.filter_categories)
      : null;
    const allowedTerms = Array.isArray(entry?.filter_terms) && entry.filter_terms.length > 0
      ? new Set(entry.filter_terms)
      : null;

    const out = [];
    for (const l of raw) {
      if (visibleOnly && !l.is_visible) continue;
      if (activeOnly && !l.active) continue;
      if (allowedCats && !allowedCats.has(l.category)) continue;
      if (allowedTerms && !Array.isArray(l.terms) || (allowedTerms && !(l.terms || []).some((t) => allowedTerms.has(t)))) continue;
      if (usOnly) {
        const locs = Array.isArray(l.locations) ? l.locations : [];
        if (!locs.some(locationIsUS)) continue;
      }
      if (skipPhD && degreesPreferPhD(l.degrees)) continue;
      out.push(listingToJob(l, entry));
      if (entry?.max_results && out.length >= entry.max_results) break;
    }
    return out;
  },
};