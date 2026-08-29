# Mode: auto-pipeline — Full Automatic Pipeline

When the user pastes a JD (text or URL) without an explicit sub-command, execute the ENTIRE pipeline in sequence:

## Step 0 — Extract JD

If the input is a **URL** (not pasted JD text), follow this strategy to extract the content:

**Priority order:**

1. **Playwright (preferred):** Most job portals (Lever, Ashby, Greenhouse, Workday) are SPAs. Use `browser_navigate` + `browser_snapshot` to render and read the JD.
   - **Opt-in — CLI extractor (`scan.extractor: cli` in `config/profile.yml`):** run `node browser-extract.mjs <url>` (default `--mode jd`) instead; it returns compact `{ "url", "title", "text" }` — just the distilled JD main text rather than the full page a11y tree, so the model processes fewer tokens (board-dependent — modest on clean boards, larger on chrome-heavy SPAs). Use its `text` as the JD. **Fall back silently** to `browser_navigate` + `browser_snapshot` if it errors or is missing. Read-only (navigate + read, no clicks/fills), so it never applies to the apply-form step below.
2. **WebFetch (fallback):** For static pages (ZipRecruiter, WeLoveProduct, company career pages).
3. **WebSearch (last resort):** Search for the role title + company in secondary portals that index the JD in static HTML.

**If no method works:** Ask the candidate to paste the JD manually or share a screenshot.

**If the input is JD text** (not a URL): use directly, without needing to fetch.

## Step 0.5 — Liveness gate

Before running any evaluation, confirm the posting is still live. The Step 0 Playwright snapshot already holds the evidence — judge it now, before spending tokens on the A-G evaluation, the report, or a PDF. A 404/expired page silently served as a static fallback ("position filled", empty shell) otherwise scores a full evaluation against phantom content.

**SimplifyJobs URLs — skip liveness check:** Entries tagged `provider: simplify-jobs` in the pipeline come from the SimplifyJobs listings.json live API. That feed is updated hourly and already filters out closed/inactive postings via `is_visible: true`. The URL is trustworthy without a browser check. Skip the Playwright snapshot for liveness purposes and go straight to JD extraction. (The JD extraction step still reads the actual page content — if it returns nothing useful, the visa/gate steps will catch it.)

1. From the Step 0 snapshot/fetched content, classify the posting:
   - **active posting evidence:** title/role + a real job description or an application/apply path
   - **closed posting evidence:** expired/closed/"no longer accepting applications", missing JD with only nav/footer, hard redirect to a generic careers/search page, or 404/410
2. If the posting appears closed or the page is a dead/fallback shell, **stop here**: do not run Step 1–Step 4. Tell the candidate the link is dead, and if the entry came from `data/pipeline.md`, mark it `- [x] ~~Company | Role~~ — oferta nieaktywna`.
3. If only JD text was pasted (no URL), there is no link to verify — skip the gate and proceed.

Do not continue to Step 1 until this gate is resolved.

## Step 0.6 — Blacklist gate (#1742)

If `data/blacklist.md` exists, check the posting's company against it before running any evaluation — the file is the candidate's own do-not-apply list (user layer, opt-in; absent file = skip this gate). Match case- and punctuation-insensitively.

On a hit, **stop before Step 1** and surface the candidate's own recorded decision: tell them which entry matched and quote their recorded reason ("{Company} is on your blacklist (since {Since}): *{Reason}*. Do you still want me to evaluate it?"). Wait for an explicit answer — never silently refuse, never silently proceed. The candidate's call always wins (same HITL spirit as the score < 4.0 rule): an explicit yes continues to Step 1 as normal; anything else stops the pipeline here, and if the entry came from `data/pipeline.md`, mark it `- [x] ~~Company | Role~~ — blacklisted`. A blacklist entry never changes any score.

## Step 0.7 — Visa eligibility gate (round-44/45)

**Read `config/profile.yml` → `preferences.sponsorship_required_internship` / `sponsorship_required_fulltime`.** The current Aaryan profile is:
- `sponsorship_required_internship: false` (CPT/OPT covers it — international students on F1 are explicitly eligible for internship roles)
- `sponsorship_required_fulltime: true` (H-1B sponsorship needed for full-time post-grad)

For the **internship pipeline** (the only mode this cron runs), `sponsorship_required_internship` is the gate. Since it's currently `false`, the only disqualifying condition in this gate is **citizenship / security clearance** — postings that explicitly exclude F1 holders regardless of sponsorship posture.

Scan the JD text (preferring US Citizenship / Work Authorization section, then "Requirements", "Eligibility", "Qualifications") for ANY of these HARD-DISQUALIFYING patterns (these exclude F1 visa holders even with OPT/CPT):

```
# Citizenship / residency required (always hard-disqualifying for F1, even with OPT)
us citizen
us citizenship
u\.?s\.? citizen
united states citizenship
american citizen
u\.?s\.? national
permanent resident (often paired with: green card, gc holder)
green card (sometimes listed as "GC holder", "GC EAD")

# Security clearance (almost always disqualifying for international students)
secret clearance
top secret clearance
ts/sci clearance
security clearance (when paired with "required", "must have", "current")
ts sci
sci clearance
polygraph
q clearance
l clearance
```

**Do NOT flag on anti-sponsorship language alone.** Even when an internship JD says "must be authorized to work" or "will not sponsor," that's a soft concern for OPT/CPT-eligible F1 holders — not a hard disqualifier. The recruiter screen is where this gets verified; auto-rejecting would drop otherwise strong matches.

**On a HIT (citizenship / clearance)**, the pipeline does NOT auto-reject — it surfaces the eligibility concern as a flag in the A-G evaluation Block G and the row's `Notes` (col 138). Why not auto-reject: some defense-adjacent postings have explicit citizenship requirements due to ITAR/EAR, but Aaryan still benefits from seeing them flagged + scored (the dealbreakers gate in `_custom.md` plus the sponsorship script in `_profile.md` are the final say).

**Track the result in the existing `US Citizen?` (col 130) AND `Notes` (col 138):**
- Default for a sponsorship-silent posting (interviews eligibility) → col 130 = `"F1 visa — no sponsorship needed (CPT/OPT eligible)"`
- Confirmed citizenship required → col 130 = `"NO (citizenship required)"` + Notes flagged "JD requires citizenship — confirm sponsorship posture before applying"
- Confirmed clearance required → col 130 = `"NO (clearance required)"` + Notes flagged "JD requires security clearance — confirm eligibility before applying"
- Posting mentions "sponsorship provided" / "OPT/CPT supported" → col 130 = `"F1 visa — no sponsorship needed (CPT/OPT eligible)"` (confirms eligible, no concern)

**Notes (col 138) default text** for sponsorship-silent postings:
> "F1 visa international student (Drexel B.S. ECE, June 2028). For internships: no sponsorship needed — CPT during current co-op rotations and OPT for Summer 2028 cover full work authorization. JD is sponsorship-silent; verify posture during recruiter screen."

For flagged postings, prepend `"FLAGGED: citizenship required"` or `"FLAGGED: clearance required"` to the standard note.

This gate runs ONCE per pipeline run (caches the result on the row), avoids burning LLM tokens on postings that clearly exclude F1 holders via citizenship/clearance, and gives Aaryan the accurate OPT/CPT framing on every other posting.

## Step 1 — A-G Evaluation

Execute the same as the `oferta` mode (read `modes/oferta.md` for all A-F blocks + Block G Posting Legitimacy). Read `modes/_custom.md` → Evaluation Rules, if it exists, and apply its override here. Default (if absent or silent): standard A-G evaluation.

**Agency-mediated postings (#1596):** if the JD smells like a recruiter/agency listing ("our client", agency domain, no employer named), ask the user which agency it came through BEFORE writing the tracker row. Record the end employer as `?` (never "Confidential"), the agency in the Via field / `via=` TSV tag, and a distinguishing descriptor in Notes — see `modes/oferta.md` and `modes/tracker.md` for the full convention and reveal workflow.

The evaluation inherits `oferta`'s bounded research budget. Company, compensation, and hiring-signal lookup must not invoke `deep-research`, must not spawn subagents, and must stop at the shared query cap instead of escalating into open-ended research.

## Step 2 — Save Report .md

Save the full evaluation in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (see format in `modes/oferta.md`).
Include Block G in the saved report. Add **URL:** {url} and **Legitimacy:** {tier} to the report header.

## Step 3 — Generate PDF

Read `config/profile.yml`. Check `cv.output_format`:

- If `"latex"`, execute the full pipeline from `modes/latex.md`
- Otherwise (default), execute the full pipeline from `modes/pdf.md`

## Step 4 — Draft Application Answers (only if score >= 4.5)

If the final score is >= 4.5, generate a draft of responses for the application form:

1. **Extract form questions**: Use Playwright to navigate to the form and take a snapshot. If they cannot be extracted, use the generic questions.
2. **Generate responses** following the tone (see below).
3. **Save in the report** as section `## H) Draft Application Answers`.

### Generic questions (use if they cannot be extracted from the form)

- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement
- What makes you a good fit for this position?
- How did you hear about this role?

### Tone for Form Answers

**Position: "I'm choosing you."** The candidate has options and is choosing this company for specific reasons.

**Tone rules:**
- **Confident without arrogance**: "I've spent the past year building production AI agent systems — your role is where I want to apply that experience next"
- **Selective without arrogance**: "I've been intentional about finding a team where I can contribute meaningfully from day one"
- **Specific and concrete**: Always reference something REAL from the JD or the company, and something REAL from the candidate's experience
- **Direct, without fluff**: 2-4 sentences per response. No "I'm passionate about..." or "I would love the opportunity to..."
- **The hook is the proof, not the statement**: Instead of "I'm great at X", say "I built X that does Y"

**Framework per question:**
- **Why this role?** → "Your [specific thing] maps directly to [specific thing I built]."
- **Why this company?** → Mention something specific about the company. "I've been using [product] for [time/purpose]."
- **Relevant experience?** → A quantified proof point. "Built [X] that [metric]. Sold the company in 2025."
- **Good fit?** → "I sit at the intersection of [A] and [B], which is exactly where this role lives."
- **How did you hear?** → Honest: "Found through [portal/scan], evaluated against my criteria, and it scored highest."

**Language**: Always in the language of the JD (EN default). Apply `/tech-translate`.

## Step 5 — Update Tracker

Record it in `data/applications.md` with all columns including Report and PDF as ✅.

**If any step fails**, continue with the next ones and mark the failed step as pending in the tracker.
