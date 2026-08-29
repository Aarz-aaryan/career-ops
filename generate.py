import os

# Create report
report_content = """# Evaluation: Robert Bosch Venture Capital — AI Systems Engineer Intern

**Date:** 2026-08-20
**Archetype:** AI/ML Engineer
**Score:** 0.0/5
**Legitimacy:** Suspicious
**URL:** https://jobs.smartrecruiters.com/BoschGroup/744000131158534
**PDF:** not generated — run /career-ops pdf bosch to create on demand
**Batch ID:** 082

---

## Machine Summary
```yaml
company: "Robert Bosch Venture Capital"
role: "AI Systems Engineer Intern"
score: 0.0
legitimacy_tier: "Suspicious"
archetype: "AI/ML Engineer"
final_decision: "Skip"
hard_stops:
  - "Job has expired"
soft_gaps: []
top_strengths: []
risk_level: "High"
confidence: "High"
next_action: "Skip"
discard_reasons:
  - "job_expired"
via: null
company_confidential: false
advertised_comp: null
risk_summary:
  legitimacy: "suspicious"
  classification: "not_evaluated"
  culture: "not_evaluated"
  interview_redflags: "none"
  ai_infra: "not_evaluated"
```

## Risk Summary

| Signal | Status |
|--------|--------|
| Posting legitimacy | ⚠️ Suspicious — Job has expired |
| Employment classification | — not evaluated |
| Culture screen | — not evaluated |
| Interview red flags | — no interview sessions yet |
| AI claims vs. infrastructure | — not evaluated |
"""

os.makedirs('/home/Aarz/career-ops/reports', exist_ok=True)
with open('/home/Aarz/career-ops/reports/082-bosch-2026-08-20.md', 'w') as f:
    f.write(report_content)

# Create TSV
cols = [""] * 148
cols[0] = "082"
cols[1] = "2026-08-20"
cols[2] = "Robert Bosch Venture Capital"
cols[3] = "AI Systems Engineer Intern"
cols[4] = "Evaluated"
cols[5] = "0.0/5"
cols[6] = "❌"
cols[7] = "[082](reports/082-bosch-2026-08-20.md)"
cols[8] = "Job has expired."
cols[145] = "https://jobs.smartrecruiters.com/BoschGroup/744000131158534"
cols[147] = ""

os.makedirs('/home/Aarz/career-ops/batch/tracker-additions', exist_ok=True)
with open('/home/Aarz/career-ops/batch/tracker-additions/082-bosch.tsv', 'w') as f:
    f.write("\t".join(cols) + "\n")

# Update pipeline.md
pipeline_path = '/home/Aarz/career-ops/data/pipeline.md'
with open(pipeline_path, 'r') as f:
    content = f.read()

content = content.replace(
    "- [ ] https://jobs.smartrecruiters.com/BoschGroup/744000131158534 | Robert Bosch Venture Capital | AI Systems Engineer Intern | Sunnyvale, CA | posted: 2026-06-09",
    "- [x] ~~Robert Bosch Venture Capital | AI Systems Engineer Intern~~ — oferta nieaktywna"
)

with open(pipeline_path, 'w') as f:
    f.write(content)

print("SUCCESS")
