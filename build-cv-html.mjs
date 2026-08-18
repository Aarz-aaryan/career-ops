#!/usr/bin/env node

// Deterministic HTML CV renderer (#557 — the HTML twin of build-cv-latex.mjs).
//
// The agent reads cv.md + config/profile.yml, tailors the content, and writes a
// compact JSON payload. This script merges that payload into the resolved CV
// template (default templates/cv-template.html; pass a path resolved by
// cv-templates.mjs to honor config-selectable templates, #1691) — it owns every
// tag, class, and the HTML escaping,
// so the model never has to emit the full document. That moves the PDF step's
// output tokens from full HTML markup down to the structured JSON payload while
// producing byte-for-byte the same ATS-safe template the agent fills today.
//
// The script does NOT parse cv.md / YAML: the authoritative read of the source
// files stays in the agent (same contract as build-cv-latex.mjs / modes/latex.md).
// generate-pdf.mjs remains the single PDF renderer and is unchanged.

import { readFile, writeFile, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename, join, extname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { stripEmptySections } from './cv-sections-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, 'templates', 'cv-template.html');
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;
const CONTACT_ROW_RE = /<div class="contact-row">[\s\S]*?<\/div>/;

const PAGE_WIDTHS = { letter: '8.5in', a4: '210mm' };
const PHOTO_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const PHOTO_STYLES = new Set(['rounded', 'circle', 'square']);
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i;

const DEFAULT_SECTION_TITLES = {
  summary: 'Professional Summary',
  competencies: 'Core Competencies',
  experience: 'Work Experience',
  projects: 'Projects',
  education: 'Education',
  certifications: 'Certifications',
  skills: 'Skills',
};

// Escape user text for HTML text/attribute context. Covers the five characters
// that change meaning in markup so tailored bullets containing &, <, >, quotes
// (e.g. "R&D", "scaled 10x < budget", 'the "north star" metric') render as
// literal text instead of breaking the document or injecting tags.
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Bullet length normalizer (round-22, 2026-08-01; revised round-23) ─────
//
// Aaryan's round-16/20/23 empirical finding: at 9.25pt EB Garamond with 0.3" T/B
// and 0.4" L/R margins, single-line bullets wrap to 2 lines past ~130 chars.
// The pipeline (AGY pdf-mode) does not enforce this budget — it emits whatever
// bullets the model decided fit the JD, which routinely produces 150-225 char
// bullets that wrap visibly in the PDF and look like regressions.
//
// Round-22 first attempt was too aggressive: it stripped meaningful content
// from trailing clauses ("routing them to the correct on-call ambassador
// staff" got dropped because it followed a comma). Round-23 fixes the
// heuristics: keep-verb detection refuses to trim if the suffix starts with
// an action verb (routing, supporting, providing, etc.) that carries the
// meaning. Also raised threshold from 145 to 148, then lowered to 140 after
// re-rendering revealed 144-char bullets visibly wrapped on page. Then to
// 130 after bbox measurement: work-exp bullets at xMin=50.8, right edge at
// 566 → 515pt available. 134-char bullet with hyphenated compound
// ("retrieval-augmented") wrapped at the hyphen because only 23pt remained.
//
// Default budget: 130 chars (round-23 empirical safe upper bound for the
// Harvard template at 9.25pt EB Garamond with 0.4in L/R margins).
// Set payload.bulletMaxChars to override. Set to 0 to disable.
//
// Rules in priority order, each one is conservative — refuses to fire if the
// change would lose a meaningful result/action/role:
//
//   1. Verbose phrase compression (specific known verbose phrases → shorter
//      equivalents; preserves every metric). Safe; idempotent.
//   2. Drop safe parentheticals (no digit inside AND not a short tech-name
//      like MCP/API/RAG → safe to drop).
//   3. Trim trailing clause after `;` ONLY if the head carries a number and
//      is ≥ max-12 chars (not a stub).
//   4. Trim trailing clause after `,` ONLY if the prefix carries a number,
//      the dropped suffix doesn't start with a verb/role/result marker
//      ("routing", "supporting", "providing", "enabling", "coordinating",
//      etc.), and the prefix is ≥ max-12 chars.
//   5. Character-trim fallback at word boundary AND past hyphenated
//      compounds (only if truncated prefix carries a number AND is
//      ≥ max-12 chars).
//
// What we will NEVER do: drop a clause that contains a key noun-phrase
// describing what was actually done / who it was done for / where it ran.
//
// Set payload.bulletMaxChars at JSON top level to override the default (130).
// Set payload.bulletMaxChars = 0 to disable entirely (legacy behavior).
//
// Verbose phrase compression map — applied first, cheap, no metric risk,
// no role/action loss.
const VERBOSE_PHRASES = [
  [/\bsupporting\b/gi, 'for'],
  [/\bvia real-time, low-latency ML infrastructure\b/gi, 'via real-time ML'],
  [/\bautomated workflows\b/gi, 'workflows'],
  [/\bautonomous field deployment\b/gi, 'field deployment'],
  [/\bin real time\b/gi, 'in real-time'],
  [/\benabling autonomous\b/gi, 'enabling'],
  [/\bsupporting Drexel\b/gi, 'for Drexel'],
  [/\bsurfacing real-time operational data analysis\b/gi, 'surfacing real-time ops data'],
  [/\breal-time, low-latency\b/gi, 'real-time'],
  [/\bperforming data analysis on thousands of\b/gi, 'analyzing thousands of'],
  [/\bperforming data analysis\b/gi, 'analyzing data'],
  [/\bprocessing 100\+ CCI support tickets simultaneously\b/gi, 'processing 100+ CCI tickets'],
  [/\bcut manual support overhead\b/gi, 'cut overhead'],
  [/\bbased on a Jetson\b/gi, 'on Jetson'],
  [/\bcampus-edge network\b/gi, 'campus network'],
  [/\busing HTTP directly to the frontend\b/gi, 'over HTTP to the frontend'],
  [/\breducing student wait times by 30%\b/gi, 'cutting wait times by 30%'],
  [/\bproviding 24\/7 autonomous query resolution\b/gi, 'providing 24/7 query resolution'],
  [/\bvia the Drexel survey\b/gi, 'per Drexel survey'],
  [/\bon a self-hosted Linux server using\b/gi, 'on self-hosted Linux with'],
  [/\bfull-on-prem with zero cloud dependency\b/gi, 'fully self-hosted'],
];

// Action/role/result markers at the START of a comma-separated suffix that
// we must NOT trim off. These phrases carry the meaning of what was
// accomplished / who it was for — stripping them would gut the bullet.
const SUFFIX_KEEP_VERBS = [
  'routing', 'supporting', 'providing', 'enabling', 'coordinating',
  'monitoring', 'serving', 'handling', 'delivering', 'managing',
  'training', 'mentoring', 'leading', 'building', 'deploying',
  'producing', 'shipping', 'publishing', 'automating', 'auditing',
];

function startsWithKeepVerb(suffix) {
  const trimmed = suffix.trimStart().toLowerCase();
  return SUFFIX_KEEP_VERBS.some(v => trimmed.startsWith(v + ' ') || trimmed.startsWith(v + ','));
}

// Parenthetical trim: drop parenthetical clauses that do NOT contain any
// numeric/digit content. Parens with numbers (e.g. "(RAG chatbot)", "(60s)")
// must be kept because the verifier enforces them AND because they often
// identify the specific technique/system that matters for the bullet.
function dropSafeParentheticals(text) {
  return text.replace(/\s*\(([^)]*)\)/g, (match, inner) => {
    // Don't drop short parentheticals that look like proper nouns or short
    // system names (e.g. "(RAG chatbot)", "(Antigravity MCP)") — they're
    // identifying markers and dropping them makes the bullet vaguer.
    if (/\d/.test(inner)) return match; // keep — has a number
    if (inner.trim().length <= 30 && /\b(MCP|API|RAG|LLM|ML|GPU|Jetson)\b/i.test(inner)) return match;
    return '';                            // drop — safe
  });
}

// Trailing-clause-after-semicolon trim: only if the head carries a number
// AND the head is substantive (not just a stub like "Built X."). This is
// the safest trim path because semicolons clearly separate two thoughts.
function trimAfterSemicolon(text, max) {
  if (text.length <= max) return text;
  const idx = text.lastIndexOf(';');
  if (idx <= 0) return text;
  let head = text.slice(0, idx).trimEnd();
  if (head.length <= max && /\d/.test(head) && head.length >= max - 12) {
    if (!/[.!?]$/.test(head)) head += '.';
    return head;
  }
  return text;
}

// Trailing-clause-after-comma trim: more conservative than round-22 — only
// drops the suffix if (a) it doesn't start with an action verb (which would
// carry the meaning), (b) the prefix carries a number, (c) the prefix is
// substantive. We walk from the last comma to the first, preferring the
// longest prefix that fits AND keeps the suffix out of the action/role zone.
function trimTrailingClause(text, max) {
  if (text.length <= max) return text;
  const parts = text.split(',');
  // Track which candidate prefix we'd keep, walking from last comma back.
  while (parts.length > 1) {
    parts.pop();
    const prefix = parts.join(',').trimEnd();
    if (prefix.length > max) continue; // prefix still too long
    if (prefix.length < max - 12) return text; // stub — give up, refuse to gut bullet
    if (!/\d/.test(prefix)) return text;       // no metric in prefix — refuse
    // The dropped suffix starts after the trimmed prefix's last character.
    const suffix = text.slice(prefix.replace(/[.!?]$/, '').length).replace(/^\s*,?\s*/, '');
    if (startsWithKeepVerb(suffix)) return text; // suffix carries meaning — refuse
    if (!/[.!?]$/.test(prefix)) {
      // Refuse to leave a dangling fragment ending mid-word; add a period.
      return prefix + '.';
    }
    return prefix;
  }
  return text;
}

function applyVerbosePhrases(text) {
  let out = text;
  for (const [re, repl] of VERBOSE_PHRASES) {
    out = out.replace(re, repl);
  }
  return out;
}

function normalizeBullet(text, max) {
  if (typeof text !== 'string' || !text || max <= 0) return text;
  // Step 0: apply verbose-phrase compression FIRST (cheap, no metric risk,
  // applies regardless of length). Round-26 fix: previously this was
  // gated on `text.length > max`, which meant short bullets that still
  // wrapped in the renderer (e.g. "campus-edge network" → 144 chars
  // at 150 max but 144 chars still wraps because of wide-glyph kerning)
  // never got the chance to compress. Now compression always runs.
  let cur = applyVerbosePhrases(text);
  if (cur.length <= max) return cur;

  // 1. Verbose phrase compression (cheap, idempotent) — already done in step 0.
  // cur = applyVerbosePhrases(cur);
  cur = applyVerbosePhrases(cur);

  // 2. Drop safe parentheticals (no number, no short tech-name inside).
  cur = dropSafeParentheticals(cur);

  // 3. Trim trailing clauses after last `;`.
  cur = trimAfterSemicolon(cur, max);

  // 4. Trim trailing appositive clauses after last `,`.
  cur = trimTrailingClause(cur, max);

  // 5. Re-apply verbose phrases in case prior steps created new matches.
  cur = applyVerbosePhrases(cur);

  // 6. Final character-trim fallback at word boundary. Only if the
  // truncated prefix carries a number. Refuse to gut bullets — the
  // threshold here is "is the result still a meaningful sentence?" (~80+
  // chars). If walk-back produces a stub, fall back to a clean truncation
  // at max-1 with period (better than leaving the bullet wrap).
  //
  // Hyphenated-compound handling: if the last "word" of the walk-back
  // contains a hyphen, the suffix after the hyphen will likely NOT fit on
  // the same line (browsers only break at hyphens, not inside words). So
  // we additionally trim past the last hyphen if it appears in the last
  // 25 chars of the walk-back. Example: "custom-built retrieval-augmented
  // indexing." → walk back to "...custom-built" + "retrieval-" remains
  // → after hyphen-trim → "...custom-built." (the "retrieval-augmented
  // indexing." can fit on line 2 instead of being awkwardly cut).
  if (cur.length > max) {
    let head = cur.slice(0, max - 1);
    const lastSpace = head.lastIndexOf(' ');
    let walked = false;
    if (lastSpace > 0) { head = head.slice(0, lastSpace); walked = true; }
    head = head.replace(/[,.;:]\s*$/, '');
    // Hyphenated compound trim: if the last word of `head` contains a
    // hyphen in the last 25 chars, strip everything from the last hyphen
    // onward (the suffix would otherwise force a wrap at the hyphen).
    const lastHyphen = head.lastIndexOf('-');
    if (lastHyphen > 0 && lastHyphen > head.length - 25 && head.length - lastHyphen < 25) {
      head = head.slice(0, lastHyphen);
    }
    head = head.replace(/[,.;:]\s*$/, '');
    if (/\d/.test(head) && head.length >= 80) {
      if (!/[.!?]$/.test(head)) head += '.';
      cur = head;
    } else if (walked) {
      // Walk-back produced a stub; try without the walk. This avoids
      // leaving a dangling mid-word fragment like "retrieval-augme."
      let hard = cur.slice(0, max - 1).replace(/[,.;:]\s*$/, '');
      // Apply hyphen-trim to hard-trim too.
      const hardHyphen = hard.lastIndexOf('-');
      if (hardHyphen > 0 && hardHyphen > hard.length - 25) hard = hard.slice(0, hardHyphen);
      hard = hard.replace(/[,.;:]\s*$/, '');
      if (/\d/.test(hard)) {
        if (!/[.!?]$/.test(hard)) hard += '.';
        cur = hard;
      }
    }
  }

  return cur;
}

export function normalizeBullets(bullets, max = 145) {
  if (!Array.isArray(bullets)) return { out: bullets, log: [] };
  const log = [];
  const out = bullets.map((b, i) => {
    if (typeof b !== 'string') return b;
    const normalized = normalizeBullet(b, max);
    if (normalized !== b) {
      log.push({
        idx: i,
        before_chars: b.length,
        after_chars: normalized.length,
        before: b,
        after: normalized,
      });
    }
    return normalized;
  });
  return { out, log };
}

// stripMarkdown — convert the most common inline markdown patterns to HTML
// (or strip them) so that user-provided text never leaks raw `*foo*` / `**bar**`
// / `_baz_` into the rendered PDF. Used by sections whose text ends up in
// fields where we want italic emphasis (e.g. edu-desc) rather than literal
// asterisks. Always runs BEFORE escapeHtml so the resulting <em>/<strong>
// tags survive intact (escapeHtml only escapes &, <, >, ", ').
function stripMarkdown(text) {
  if (typeof text !== 'string') return text;
  return text
    // `**bold**` → <strong>bold</strong>
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // `*italic*` → <em>italic</em> (must come after the bold rule)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    // `__bold__` → <strong>bold</strong>
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    // `_italic_` → <em>italic</em>
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>')
    // `[text](url)` → <a href="url">text</a>
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

// Sanitize a URL for an href attribute: only allow the schemes the template's
// contact row uses, coerce bare emails/domains, drop javascript:/data: and other
// script-bearing schemes, then HTML-escape for the attribute context.
function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  url = url.trim();
  if (!url) return '';
  const allowedSchemes = ['mailto:', 'tel:', 'http:', 'https:'];
  const lower = url.toLowerCase();
  const hasScheme = allowedSchemes.some(s => lower.startsWith(s));
  if (!hasScheme) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      // An explicit but disallowed scheme (javascript:, data:, …) — reject it.
      return '';
    }
    if (url.includes('@') && !url.includes('/')) {
      url = 'mailto:' + url;
    } else {
      url = 'https://' + url;
    }
  }
  return escapeHtml(url);
}

function sanitizeImageSrc(src) {
  if (typeof src !== 'string') return '';
  const value = src.trim();
  if (IMAGE_DATA_URL_RE.test(value)) return escapeHtml(value);
  if (/^https?:\/\//i.test(value)) return sanitizeUrl(value);
  return '';
}

async function prepareCandidatePhoto(candidate) {
  const c = candidate && typeof candidate === 'object' ? { ...candidate } : {};
  const photo = typeof c.photo === 'string' ? c.photo.trim() : '';
  const style = c.photo_style || c.photoStyle || 'rounded';

  if (!PHOTO_STYLES.has(style)) {
    throw new Error(`Unsupported profile photo style: ${style} (expected rounded, circle, or square)`);
  }
  c.photo_style = style;
  if (!photo) {
    c.photo = '';
    return c;
  }

  if (photo.startsWith('data:')) {
    if (!IMAGE_DATA_URL_RE.test(photo)) {
      throw new Error('Unsupported profile photo data URL (expected base64 PNG, JPEG, WebP, or GIF)');
    }
    c.photo = photo;
    return c;
  }

  if (/^https?:\/\//i.test(photo)) {
    c.photo = photo;
    return c;
  }

  if (/^[a-z][a-z0-9+.-]+:/i.test(photo)) {
    throw new Error(`Unsupported profile photo URL scheme: ${photo.split(':', 1)[0]}`);
  }

  const photoPath = isAbsolute(photo) ? photo : resolve(__dirname, photo);
  const mime = PHOTO_MIME_BY_EXT.get(extname(photoPath).toLowerCase());
  if (!mime) {
    throw new Error(`Unsupported profile photo format: ${photo} (expected PNG, JPEG, WebP, or GIF)`);
  }

  let bytes;
  try {
    bytes = await readFile(photoPath);
  } catch (err) {
    throw new Error(`Profile photo not found or unreadable: ${photo} (${err.code || err.message})`);
  }
  if (bytes.length === 0) {
    throw new Error(`Profile photo is empty: ${photo}`);
  }
  c.photo = `data:${mime};base64,${bytes.toString('base64')}`;
  return c;
}

function joinItems(items) {
  if (Array.isArray(items)) return items.join(', ');
  return typeof items === 'string' ? items : '';
}

// --- Section builders: each returns the inner HTML for one {{PLACEHOLDER}}. ---

function buildCompetencies(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries
    .filter(Boolean)
    .map(tag => `<span class="competency-tag">${escapeHtml(String(tag))}</span>`)
    .join('\n      ');
}

function buildExperience(entries, max = 145) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(e => {
    const raw = Array.isArray(e.bullets) ? e.bullets.filter(Boolean) : [];
    const { out: bullets } = normalizeBullets(raw, max);
    const bulletsHtml = bullets.map(b => `        <li>${escapeHtml(b)}</li>`).join('\n');
    // Aaryan preference (2026-07-25): no location/city under any job header.
    // We strip e.location here even though AGY may include it. The .job-location
    // CSS block is intentionally left in the template for future re-enable.
    const location = '';
    return `<div class="job">
    <div class="job-header">
      <span class="job-company">${escapeHtml(e.company)}</span>
      <span class="job-period">${escapeHtml(e.dates || e.period || '')}</span>
    </div>
    <div class="job-role">${escapeHtml(e.role)}</div>${location}
    <ul>
${bulletsHtml}
    </ul>
  </div>`;
  }).join('\n  ');
}

function buildProjects(entries, max = 145) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(e => {
    // Aaryan preference (2026-07-25): the badge (e.g. "Full Stack Developer") goes
    // on the FAR RIGHT of the project header, like job-period does for experience.
    // Use the same .project-header flex layout as the experience row.
    const badge = e.badge
      ? `<span class="project-badge-right">${escapeHtml(e.badge)}</span>`
      : '';
    // Aaryan preference (2026-07-31 round-13): project bullets like Experience —
    // one line each, fill width. If bullets[] is provided, render as a <ul>;
    // otherwise split description into sentences and render as <ul> (round-38
    // canonical — fixes cron AGY that was emitting single-paragraph descriptions
    // instead of bullet arrays, breaking the project formatting in PDFs).
    let body = '';
    if (Array.isArray(e.bullets) && e.bullets.filter(Boolean).length > 0) {
      const raw = e.bullets.filter(Boolean);
      const { out: items } = normalizeBullets(raw, max);
      body = `\n    <ul>\n${items.map(b => `      <li>${escapeHtml(b)}</li>`).join('\n')}\n    </ul>`;
    } else if (e.description) {
      // Split single-paragraph description into bullet sentences. The AGY cron
      // was emitting one long description string per project instead of a bullets
      // array — splitting on sentence boundaries (period+space) recovers the
      // canonical 3-4 bullet layout for project sections.
      const sentences = e.description
        .split(/(?<=\.)\s+(?=[A-Z])/g)
        .map(s => s.trim())
        .filter(s => s.length > 0);
      if (sentences.length >= 2) {
        const { out: items } = normalizeBullets(sentences, max);
        body = `\n    <ul>\n${items.map(b => `      <li>${escapeHtml(b)}</li>`).join('\n')}\n    </ul>`;
      } else {
        body = `\n    <div class="project-desc">${escapeHtml(e.description)}</div>`;
      }
    }
    const tech = e.tech
      ? `\n    <div class="project-tech">${escapeHtml(e.tech)}</div>`
      : '';
    return `<div class="project">
    <div class="project-header">
      <span class="project-title">${escapeHtml(e.name)}</span>
      ${badge}
    </div>${body}${tech}
  </div>`;
  }).join('\n  ');
}

function buildEducation(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  // Aaryan preference (2026-07-25 round-8): strip city/state from the description
  // string itself, not just the standalone `location` field. AGY sometimes embeds
  // "Philadelphia, PA" or other city/state directly in the description (e.g.
  // "Dean's List | Drexel Founder Scholar (merit scholarship). Philadelphia, PA").
  // Catches: "City, ST", "City ST", and bare city names like "San Francisco Bay Area".
  const stripLocation = (text) => {
    if (typeof text !== 'string' || !text) return text;
    // Match "City, ST" or "City ST" only when preceded by a separator (·,.,;),
    // NOT just whitespace. This avoids "AP Scholar" being eaten as
    // "Scholar [City] [ST]" when "Scholar" is followed by a city.
    return text
      .replace(/[·.,;]\s*[A-Z][a-zA-Z\.\- ]+,\s*[A-Z]{2}\b\.?/g, '')
      .replace(/[·.,;]\s*[A-Z][a-zA-Z\.\- ]+\s+[A-Z]{2}\b\.?/g, '')
      .replace(/[·.,;]\s*(Philadelphia|San Francisco|New York|Seattle|Austin|Boston|Mountain View|Cupertino|Menlo Park|Sunnyvale|Palo Alto|Redmond|Los Angeles|Chicago|Berlin|London|Toronto)\b\.?/gi, '')
      .replace(/\s*[·.]\s*$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  return entries.filter(Boolean).map(raw => {
    // Schema normalizer: accept multiple input shapes (AGY produces 3 different
    // ones depending on archetype). Map to canonical internal form:
    //   { title, org, year, description, location }
    //
    // Canonical (pdf.md schema):
    //   { title, org, year, description, location? }
    // Variant A (institution-led, AGY FDE-style):
    //   { institution, degree, dates, location, details? | bullets? }
    // Variant B (institution-led with date+location, AGY FDE-style v2):
    //   { institution, location, degree, dates, bullets? }
    const e = {};
    e.title = raw.title ?? raw.degree ?? '';
    e.org = raw.org ?? raw.institution ?? '';
    e.year = raw.year ?? raw.dates ?? '';
    // AGY sometimes emits `details` or `bullets` as an array, sometimes as a string.
    // Handle both shapes and join multiple strings with the same separator we use elsewhere.
    const detailsArr = Array.isArray(raw.bullets) ? raw.bullets
                     : Array.isArray(raw.details) ? raw.details
                     : null;
    const detailsStr = (typeof raw.details === 'string' && raw.details)
                     || (typeof raw.bullets === 'string' && raw.bullets)
                     || '';
    const descBits = [];
    if (raw.description) descBits.push(stripMarkdown(stripLocation(raw.description)));
    if (detailsArr && detailsArr.length) descBits.push(detailsArr.map(d => stripMarkdown(stripLocation(d))).join(' · '));
    if (detailsStr) descBits.push(stripMarkdown(stripLocation(detailsStr)));
    e.description = descBits.join(' · ');
    e.location = raw.location ?? '';
    if (e.title || e.org) {
      const org = e.org
        ? ` <span class="edu-org">${escapeHtml(e.org)}</span>`
        : '';
      const desc = e.description
        ? `\n    <div class="edu-desc">${escapeHtml(e.description)}</div>`
        : '';
      // Aaryan preference (2026-07-25): NO location (city/state) anywhere in the CV
      // — neither in Education nor anywhere else. The .edu-location CSS block was
      // intentionally left in the template so it can be re-enabled by future templates
      // without re-adding the CSS. AGY payloads may still include `location` — we
      // strip it here so no PDF shows "Philadelphia, PA" or any other city.
      const loc = '';
      return `<div class="edu-item">
    <div class="edu-header">
      <div class="edu-title">${escapeHtml(e.title)}${org}</div>
      <div class="edu-year">${escapeHtml(e.year || '')}</div>
    </div>${desc}${loc}
  </div>`;
    }
    return '';
  }).filter(Boolean).join('\n  ');
}

function buildCertifications(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(e => {
    const org = e.org ? `<span class="cert-org">${escapeHtml(e.org)}</span>` : '<span class="cert-org"></span>';
    const year = e.year ? `<span class="cert-year">${escapeHtml(e.year)}</span>` : '<span class="cert-year"></span>';
    return `<div class="cert-item">
      <span class="cert-title">${escapeHtml(e.title)}</span>
      ${org}
      ${year}
    </div>`;
  }).join('\n    ');
}

function buildSkills(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  // Aaryan preference (2026-07-25): pack more content into fewer lines by laying out
  // skill categories in a flex-wrap grid. Short categories (Languages, Cloud, CAD,
  // Design) share a row; long categories (Tools & Frameworks, GenAI/LLMOps) take
  // their own row. Each category uses display:inline-block with explicit minimum
  // widths so the browser wraps to a 2-column layout naturally — no fixed grid
  // that could force ugly overflow on different content lengths.
  //
  // NOTE on "no overlap" guarantee:
  //   - inline-block elements with margin-right create a vertical column gutter.
  //   - flex-wrap + align-content: flex-start ensures rows don't overlap vertically.
  //   - The CSS sets min-width so a single very long category is forced to its own
  //     row instead of squishing into half-width.
  const items = categories.filter(Boolean).map(c => {
    const cat = c.category
      ? `<span class="skill-category">${escapeHtml(c.category)}:</span> `
      : '';
    return `    <div class="skill-item">${cat}${escapeHtml(joinItems(c.items))}</div>`;
  }).join('\n');
  return `<div class="skills-grid">
${items}
  </div>`;
}

// Leadership entries are bulleted role/org pairs.
// Supports two shapes per entry:
//   1) { role: '...', org: '...' }  — explicit split, role bold + org italic
//   2) 'string'                     — naked string fallback
// The function returns an empty string when no entries are present, so the
// {{LEADERSHIP}} placeholder substitution ends up empty and the corresponding
// <div class="section leadership-section"> wraps to nothing — same pattern
// stripEmptySections uses for projects/education.
function buildLeadership(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  // Aaryan preference (2026-07-31 round-13): leadership formatted like
  // work-experience — title (organization) on header, role on its own line,
  // then bullets describing the role. If bullets[] present, render as <ul>;
  // else fall back to a single <li> with description (legacy strings).
  const items = entries.filter(Boolean).map(e => {
    if (typeof e === 'string') {
      return `<div class="leadership-entry">
    <div class="leadership-list"><li>${escapeHtml(e)}</li></div>
  </div>`;
    }
    const title = e.role
      ? `<span class="leadership-title">${escapeHtml(e.role)}</span>`
      : '';
    // Aaryan preference (2026-08-01 round-15b): remove em-dash prefix from
    // org name — keep it clean, just the org text on the right.
    const org = e.org
      ? `<span class="leadership-org">${escapeHtml(e.org)}</span>`
      : '';
    const dates = e.dates
      ? `<span class="leadership-period">${escapeHtml(e.dates)}</span>`
      : '';
    let body = '';
    if (Array.isArray(e.bullets) && e.bullets.filter(Boolean).length > 0) {
      const lis = e.bullets.filter(Boolean)
        .map(b => `      <li>${escapeHtml(b)}</li>`).join('\n');
      body = `\n    <ul class="leadership-list">\n${lis}\n    </ul>`;
    } else if (e.description) {
      body = `\n    <ul class="leadership-list"><li>${escapeHtml(e.description)}</li></ul>`;
    }
    // Aaryan preference (2026-08-01 round-15): org must sit on the FAR
    // RIGHT of the header (matches work-experience company/period layout).
    // Title-wrap is flex:1 to consume middle space; org is a separate
    // flex item with margin-left:auto to push it to the right edge.
    return `<div class="leadership-entry">
    <div class="leadership-header">
      <span class="leadership-title-wrap">${title}</span>
      ${org}
      ${dates}
    </div>${body}
  </div>`;
  }).join('\n  ');
  return items;
}

// Rebuild the whole .contact-row block. Its markup uses fixed "|" separators
// between phone / email / linkedin / portfolio / location, so an absent optional
// field (phone, linkedin, portfolio) must drop BOTH its <a> and one separator.
// Building the present items and joining them is more robust than excising
// separators from the template one placeholder at a time.
function buildContactRow(candidate) {
  const c = candidate || {};
  const items = [];
  if (c.phone) {
    const tel = sanitizeUrl('tel:' + String(c.phone).replace(/\s+/g, ''));
    items.push(`<a href="${tel}">${escapeHtml(c.phone)}</a>`);
  }
  if (c.email) {
    items.push(`<a href="${sanitizeUrl('mailto:' + c.email)}">${escapeHtml(c.email)}</a>`);
  }
  if (c.linkedin && c.linkedin.url) {
    items.push(`<a href="${sanitizeUrl(c.linkedin.url)}">${escapeHtml(c.linkedin.display || c.linkedin.url)}</a>`);
  }
  if (c.portfolio && c.portfolio.url) {
    items.push(`<a href="${sanitizeUrl(c.portfolio.url)}">${escapeHtml(c.portfolio.display || c.portfolio.url)}</a>`);
  }
  // Aaryan preference (2026-07-25): NO city/state in the contact row.
  // Even if candidate.location is provided, do NOT push it here.
  const sep = '\n      <span class="separator">|</span>\n      ';
  return `<div class="contact-row">\n      ${items.join(sep)}\n    </div>`;
}

function buildPhoto(candidate, name) {
  const photo = candidate && candidate.photo;
  if (!photo) return '';
  const style = PHOTO_STYLES.has(candidate.photo_style) ? candidate.photo_style : 'rounded';
  return `<img class="cv-photo cv-photo--${style}" src="${sanitizeImageSrc(photo)}" alt="${escapeHtml(name || '')}">`;
}

function renderReport(payload) {
  const sectionTitles = { ...DEFAULT_SECTION_TITLES, ...(payload.sections || {}) };
  const candidate = payload.candidate || {};
  const pageWidth = PAGE_WIDTHS[payload.page_format] || PAGE_WIDTHS.letter;
  // Round-23b: bullet length budget. payload.bulletMaxChars overrides the
  // default 145-char single-line target. Empirical reference: v9 gold-standard
  // PDF (Aaryan_Tahir_Resume_Cursor_SWE_Intern_2026-08-01_v9.pdf) has work-exp
  // bullets at xMin=50.8pt, xMax=540-578pt → 92-99% line utilization with
  // bullets 130-146 chars. Normalizer threshold 145 with hyphen-aware fallback
  // matches v9 fill without wrap regressions. 0 disables normalization.
  // Round-26 fix: default 145 → 150. The 145 threshold was tuned for A4 paper
  // (594.96pt page width = 566pt body width). Round-26 switched the renderer
  // to Letter (612pt = 583.4pt body width), giving 17.4pt of extra horizontal
  // space. cv.md's longest bullets are 149 chars and now fit on 1 line at the
  // new Letter width (xMax ≈ 583.4pt). 150 char threshold = 1-char safety
  // margin so the "walk back to last space" fallback (which produced mid-word
  // truncations like "and student." for CCI bullet 1) never fires for any
  // cv.md bullet. The 145 default is preserved for tests that explicitly pass
  // bulletMaxChars=145 to keep behavior unchanged.
  const bulletMax = typeof payload.bulletMaxChars === 'number' ? payload.bulletMaxChars : 150;

  const substitutions = {
    LANG: escapeHtml(payload.lang || 'en'),
    PAGE_WIDTH: pageWidth,
    NAME: escapeHtml(candidate.name || ''),
    SECTION_SUMMARY: escapeHtml(sectionTitles.summary),
    SUMMARY_TEXT: escapeHtml(payload.summary || ''),
    SECTION_COMPETENCIES: escapeHtml(sectionTitles.competencies),
    COMPETENCIES: buildCompetencies(payload.competencies),
    SECTION_EXPERIENCE: escapeHtml(sectionTitles.experience),
    EXPERIENCE: buildExperience(payload.experience, bulletMax),
    SECTION_PROJECTS: escapeHtml(sectionTitles.projects),
    PROJECTS: buildProjects(payload.projects, bulletMax),
    SECTION_EDUCATION: escapeHtml(sectionTitles.education),
    EDUCATION: buildEducation(payload.education),
    SECTION_CERTIFICATIONS: escapeHtml(sectionTitles.certifications),
    CERTIFICATIONS: buildCertifications(payload.certifications),
    SECTION_SKILLS: escapeHtml(sectionTitles.skills),
    SKILLS: buildSkills(payload.skills),
    SECTION_LEADERSHIP: escapeHtml(sectionTitles.leadership || 'Leadership Experience'),
    LEADERSHIP: buildLeadership(payload.leadership),
  };
  return { substitutions, candidate };
}

// Merge a payload into the template and return the final HTML (throws on any
// unresolved {{PLACEHOLDER}} so a malformed payload fails loudly, not silently).
function renderHtml(template, payload) {
  // Round-29 pre-flight: hard-fail if canonical sections are missing.
  // Aaryan (2026-08-05): "I see that the leadership section is completely gone.
  // I want you to look into the complete pipeline in detail and fix it from the
  // root." The r27 batch silently dropped leadership and skills because the
  // AGY-produced JSON omitted those keys, and stripEmptySections then dropped
  // the section HTML. This pre-flight makes that failure LOUD.
  assertCanonicalPayload(payload);

  const { substitutions, candidate } = renderReport(payload);

  // The contact row and photo carry conditional markup (dropped separators /
  // no <img>), so they are rebuilt as whole blocks before placeholder fill.
  let html = template.replace(CONTACT_ROW_RE, () => buildContactRow(candidate));
  html = html.replace(/\{\{PHOTO\}\}/g, () => buildPhoto(candidate, candidate.name));

  // Drop the optional sections (projects, education) that have no entries, so
  // an absent one leaves no bare header behind. See cv-sections-core.mjs.
  html = stripEmptySections(html, payload, 'html');

  for (const [key, value] of Object.entries(substitutions)) {
    html = html.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  const unresolved = html.match(PLACEHOLDER_RE);
  if (unresolved) {
    throw new Error(`Unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
  }
  return html;
}

// Round-29: assert that the payload contains the canonical sections expected
// for a 1-page + 2-page CV. A missing leadership or skills array means the
// AGY auto-pipeline did not read cv.md correctly (r27 batch regression).
// We hard-fail loudly here so the bug is caught at the JSON → HTML boundary
// rather than silently dropping the section in stripEmptySections().
function assertCanonicalPayload(payload) {
  const errors = [];

  // Leadership: must be an array with >=4 entries (canonical from cv.md).
  if (!Array.isArray(payload.leadership) || payload.leadership.length < 4) {
    errors.push(
      `payload.leadership missing or <4 entries ` +
      `(got ${Array.isArray(payload.leadership) ? payload.leadership.length : 'undefined'}; ` +
      `expected >=4 per cv.md round-23+ canonical). ` +
      `AGY auto-pipeline must read cv.md's "## Leadership" section verbatim.`
    );
  }

  // Skills: must be an array with >=4 categories.
  if (!Array.isArray(payload.skills) || payload.skills.length < 4) {
    errors.push(
      `payload.skills missing or <4 categories ` +
      `(got ${Array.isArray(payload.skills) ? payload.skills.length : 'undefined'}; ` +
      `expected >=4 per cv.md "## Technical Skills"). ` +
      `AGY auto-pipeline must read cv.md's "## Technical Skills" section verbatim.`
    );
  }

  // Competencies: must have >=6 keyword tags (schema spec).
  if (!Array.isArray(payload.competencies) || payload.competencies.length < 6) {
    errors.push(
      `payload.competencies missing or <6 tags ` +
      `(got ${Array.isArray(payload.competencies) ? payload.competencies.length : 'undefined'}; ` +
      `expected 6-8 per modes/pdf.md). ` +
      `AGY auto-pipeline must generate 6-8 JD-tailored competency tags.`
    );
  }

  // Experience: must have >=4 entries (canonical: SIG, Exelon Tech Services,
  // Exelon Distribution Standards, Drexel CCI / Visionii, etc).
  if (!Array.isArray(payload.experience) || payload.experience.length < 4) {
    errors.push(
      `payload.experience missing or <4 entries ` +
      `(got ${Array.isArray(payload.experience) ? payload.experience.length : 'undefined'}; ` +
      `expected >=4). Check cv.md "## Work Experience" was read.`
    );
  }

  if (errors.length > 0) {
    throw new Error(
      'Round-29 pre-flight failed — payload is missing canonical sections.\n' +
      'This is a structural bug in the AGY auto-pipeline that produced this JSON.\n' +
      'Read modes/pdf.md MUST-INCLUDE rules and ensure cv.md sections are being parsed.\n' +
      'Errors:\n  - ' + errors.join('\n  - ')
    );
  }
}


function countBullets(payload) {
  const ex = Array.isArray(payload.experience)
    ? payload.experience.flatMap(e => (Array.isArray(e?.bullets) ? e.bullets : []))
    : [];
  return ex.length;
}

async function writeAndReport(html, absOutput, payload, extra = {}) {
  const outDir = dirname(absOutput);
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  await writeFile(absOutput, html, 'utf-8');

  const fileInfo = await stat(absOutput);
  const report = {
    ...extra,
    file: basename(absOutput),
    path: absOutput,
    sizeKB: parseFloat((fileInfo.size / 1024).toFixed(1)),
    counts: {
      competencies: (payload.competencies || []).length,
      experienceEntries: (payload.experience || []).length,
      projectEntries: (payload.projects || []).length,
      educationEntries: (payload.education || []).length,
      certificationEntries: (payload.certifications || []).length,
      skillCategories: (payload.skills || []).length,
      totalBullets: countBullets(payload),
    },
    valid: true,
  };
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.error('Usage:');
    console.error('  node build-cv-html.mjs <input.json> <output.html> [template.html]');
    console.error('  node build-cv-html.mjs --preview <input.json> [template.html]');
    console.error('  node build-cv-html.mjs --test');
    console.error('');
    console.error('  [template.html] defaults to templates/cv-template.html. Pass the path');
    console.error('  printed by `node cv-templates.mjs resolve cv` to use a selected template.');
    process.exit(args.includes('--help') ? 0 : 1);
  }

  if (args.includes('--test')) {
    await runSelfTest();
    return;
  }

  const preview = args[0] === '--preview';
  const [inputPath, outputPath, templateArg] = preview
    ? [args[1], resolve(__dirname, 'output', 'cv-preview.html'), args[2]]
    : args;
  if (!inputPath || !outputPath) {
    console.error('Usage: node build-cv-html.mjs <input.json> <output.html> [template.html]');
    process.exit(1);
  }

  const absInput = resolve(inputPath);
  const absOutput = resolve(outputPath);
  // Round-43 fix: auto-resolve the configured template (cv.template from
  // config/profile.yml) when no explicit templateArg is passed. Without
  // this, omitting the third arg silently falls back to cv-template.html
  // (ATS-stripped base template) — which produces ~64KB PDFs without the
  // canonical Harvard leadership/org-at-far-right layout Aaryan spent
  // rounds 13-28 perfecting. The cron (2026-08-14) was silently emitting
  // 64KB PDFs because AGY wasn't passing the third arg.
  let templatePath;
  if (templateArg) {
    templatePath = resolve(templateArg);
  } else {
    try {
      const { resolveTemplate } = await import('./cv-templates.mjs');
      templatePath = resolveTemplate('cv');
      console.error(`[build-cv-html] Auto-resolved template from config: ${templatePath}`);
    } catch (err) {
      console.error(`[build-cv-html] resolveTemplate failed (${err.message}); falling back to ${TEMPLATE_PATH}`);
      templatePath = TEMPLATE_PATH;
    }
  }

  if (!existsSync(absInput)) {
    console.error(`Input file not found: ${absInput}`);
    process.exit(1);
  }
  if (!existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(await readFile(absInput, 'utf-8'));
    payload.candidate = await prepareCandidatePhoto(payload.candidate);
  } catch (err) {
    console.error(`Failed to prepare CV input: ${err.message}`);
    process.exit(1);
  }

  const template = await readFile(templatePath, 'utf-8');

  let html;
  try {
    html = renderHtml(template, payload);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  await writeAndReport(html, absOutput, payload, preview ? { status: 'preview-ready' } : {});
  process.exit(0);
}

async function runSelfTest() {
  const sample = {
    lang: 'en',
    page_format: 'letter',
    candidate: {
      name: 'Test Candidate',
      phone: '+1 234 567 8900',
      email: 'test@example.com',
      linkedin: { url: 'https://linkedin.com/in/test', display: 'linkedin.com/in/test' },
      portfolio: { url: 'https://test.example.com', display: 'test.example.com' },
      location: 'City, State',
    },
    summary: 'Backend engineer with a focus on R&D and cost-efficient "north star" systems.',
    competencies: ['Cloud Architecture', 'RESTful API Design', 'Kubernetes & Docker'],
    experience: [{
      company: 'Test Corp',
      role: 'Test Engineer',
      location: 'Remote',
      dates: 'June 2024 - Present',
      bullets: [
        'Built automated testing pipelines with CI/CD integration',
        'Reduced regression test time by 60% through parallel execution',
      ],
    }],
    projects: [{
      name: 'Test Project',
      badge: 'Open Source',
      tech: 'Python, FastAPI, Docker',
      description: 'Built a REST API with automated test coverage exceeding 90%.',
    }],
    education: [{
      title: 'Bachelor of Science in Computer Science',
      org: 'Test University',
      year: '2024',
      description: 'Coursework: Data Structures, Algorithms, Machine Learning.',
    }],
    certifications: [{ title: 'Certified Kubernetes Administrator', org: 'CNCF', year: '2025' }],
    skills: [
      { category: 'Languages', items: 'Python, JavaScript, TypeScript' },
      { category: 'Frameworks', items: ['FastAPI', 'React', 'PyTorch'] },
    ],
  };

  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`Self-test failed: template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  const template = await readFile(TEMPLATE_PATH, 'utf-8');

  let html;
  try {
    html = renderHtml(template, sample);
  } catch (err) {
    console.error(`Self-test failed: ${err.message}`);
    process.exit(1);
  }

  // Guard the escaping contract: the raw ampersand from "Kubernetes & Docker"
  // must reach the output escaped, and no unescaped literal must survive.
  if (!html.includes('Kubernetes &amp; Docker')) {
    console.error('Self-test failed: HTML escaping did not apply to competency text');
    process.exit(1);
  }
  if (/Kubernetes & Docker/.test(html)) {
    console.error('Self-test failed: found an unescaped ampersand in output');
    process.exit(1);
  }

  const absOutput = resolve(join(tmpdir(), 'build-cv-html-test.html'));
  await writeAndReport(html, absOutput, sample, { status: 'self-test-passed' });

  await import('fs/promises').then(fs => fs.rm(absOutput).catch(() => {}));
  process.exit(0);
}

// Only run main() when this file is invoked directly. Imports (e.g. tests
// that just want normalizeBullets()) skip it.
const __isMainModule = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
           process.argv[1]?.endsWith('build-cv-html.mjs');
  } catch { return false; }
})();
if (__isMainModule) main();
