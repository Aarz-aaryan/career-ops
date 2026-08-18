# Article Digest — Aaryan Tahir Proof Points

<!-- ============================================================
     Source-of-truth for proof points referenced from CV and
     interview answers. Each entry maps to a real artifact in cv.md.
     ============================================================ -->

## Signature Stories (use in cover letters + interview answers)

### Story 1 — "I shipped PM-AI to 100+ enterprise users while still being an intern"

**Setup:** Exelon/Peco's Technical Services department had 15+ years of operational documentation buried across SharePoint, PDFs, and tribal knowledge. New engineers spent weeks ramping up.

**Task:** Build a production-grade RAG system that surfaces that knowledge in seconds, not weeks.

**Action:**
- Architected ingestion pipeline for 15+ years of departmental documents
- Selected and tuned the embedding + retrieval stack for utility-domain terminology
- Built the chat interface + escalation path to human engineers when the bot couldn't answer
- Ran weekly stakeholder reviews with department leadership during pilot

**Result:** 100+ active users across Technical Services. (See cv.md §Experience → Exelon – Peco)

**Reflection:** The hard part wasn't the LLM — it was the data hygiene, the change management, and making the bot trustworthy enough that senior engineers trusted its answers.

### Story 2 — "I reduced audit overhead 83% with autonomous CV at Peco"

**Setup:** Peco's field engineers manually audited utility infrastructure photos for compliance with internal Standards. The process was slow, inconsistent, and dangerous (engineers climbing poles).

**Task:** Build an autonomous system that does the audit in software, then deploy it via drone for field capture.

**Action:**
- Engineered AVIS: an autonomous LLM + computer vision defect detection and Standards validation system
- Architected a custom AI-powered drone for field deployment, including mission planning and job selection pipelines
- Trained detection models on Peco's historical audit data

**Result:** 83% reduction in audit workflow overhead. 60% reduction in in-field manual labor. (See cv.md §Experience)

**Reflection:** The lesson: AI is only valuable when it's deployed. A 99% accurate model sitting on a laptop is worth nothing. The drone + pipeline + handoff to engineers was the actual product.

### Story 3 — "I built a 5,000-student/month on-prem LLM stack at Drexel"

**Setup:** Drexel's College of Computing & Informatics needed 24/7 student support but couldn't use cloud LLMs (FERPA + university policy).

**Task:** Build a fully on-prem, self-hosted LLM that handles student queries without any cloud dependency.

**Action:**
- Self-hosted Linux server with Ollama + HuggingFace + vector storage + n8n
- Trained retrieval on 10+ years of Drexel support data (Canvas, Blackboard, TDX)
- VPN-restricted access to keep student data on-premises
- Surveyed 86% satisfaction rate post-launch

**Result:** 5,000+ students served monthly. 20% reduction in support wait times. (See cv.md §Projects)

**Reflection:** On-prem isn't a limitation, it's a forcing function for better engineering. When you can't just call OpenAI's API, you build a more careful system.

### Story 4 — "I founded and led a 5-person research team shipping edge CV"

**Setup:** Drexel's College of Engineering needed a real-time security monitoring solution for camera-dense environments. Existing systems were cloud-based, expensive, and slow.

**Task:** Lead a team of 5 researchers to deploy an edge-inference CV device that processes 40+ camera feeds on-device.

**Action:**
- Recruited + led a 5-person research team
- Architected the Jetson-based inference pipeline (40+ feeds simultaneously)
- Trained detection models on real-world camera data
- Co-authored publication with Drexel faculty

**Result:** 94% detection accuracy. 73% reduction in false alarms. <60s incident response time. (See cv.md §Experience → Drexel Alumni Labs)

**Reflection:** Leading researchers is different from leading engineers. You have to defend technical decisions to people who know more than you do, and the publication review process forces you to articulate your assumptions.

### Story 5 — "I deployed a department-wide automation platform at Peco"

**Setup:** Peco's Distribution Standards department had manual reporting workflows consuming 20+ hours/month on PUC compliance + circuit patrol.

**Task:** Automate the high-frequency workflows without disrupting the audit trail.

**Action:**
- Deployed a department server hosting automated operational scripts
- Built Power BI dashboards for real-time operational reporting
- Maintained 100% WO Standards compliance across 300+ work orders

**Result:** 20+ hours/month saved. 100% compliance maintained across 3 PECO territories. (See cv.md §Experience)

**Reflection:** Operations engineers care about two things: it doesn't break, and the audit trail is intact. Anything else is decoration.

## Claimable Numbers (always-safe)

| Number | Source | Safe to claim |
|--------|--------|---------------|
| 100+ users | PM-AI at Peco | ✓ |
| 5,000+ students/month | CCI-Bot | ✓ |
| 83% reduction | AVIS audit workflow overhead | ✓ |
| 60% reduction | AVIS in-field manual labor | ✓ |
| 86% satisfaction | CCI-Bot survey | ✓ |
| 94% accuracy | Visionii detection | ✓ |
| 73% reduction | Visionii false alarms | ✓ |
| 40+ camera feeds | Visionii | ✓ |
| <60s incident response | Visionii | ✓ |
| 70% reduction | Drexel CCI ticket automation | ✓ |
| 30% reduction | Drexel Bench wait times | ✓ |
| 20+ hours/month saved | Peco PUC reporting | ✓ |
| 100% compliance | Peco work orders | ✓ |

## Tech stack alignment matrix

| Stack | Used in | Comfort level |
|-------|---------|---------------|
| Python (LangChain, PyTorch, OpenCV) | PM-AI, AVIS, Visionii | Expert |
| Docker + Linux | All production deployments | Expert |
| Vector storage + RAG | PM-AI, CCI-Bot | Expert |
| Ollama + HuggingFace | CCI-Bot | Expert |
| NVIDIA Jetson | Visionii, AVIS | Comfortable |
| Kubernetes | Peco infrastructure | Working knowledge |
| React | Various | Working knowledge |
| Raspberry Pi | Drexel Bench | Comfortable |
| Power BI | Peco Distribution Standards | Working knowledge |

## Differentiation statements (for "Why should we hire you?" answers)

> "Most intern candidates have done a class project or a Kaggle competition. I've shipped production AI to 100+ enterprise users at Peco and 5,000+ students at Drexel. The bottleneck for me isn't learning — it's choosing where to ship next."

> "I'm ECE + CS. Most candidates are one or the other. That means I can debug the Jetson board AND the inference pipeline AND the API layer. End-to-end ownership."

> "I've already led a 5-person research team and a 12-person ambassador team. Most interns haven't managed anyone yet."

> "I've turned down proprietary trading firms because they're not aligned with my values. I want to build AI products that matter, not optimize spread."

## Question pool (for interview-prep mode)

### Behavioral
1. Tell me about a time you had to ship something under pressure.
2. Tell me about a disagreement with a teammate.
3. Tell me about a time you failed and what you learned.
4. Tell me about a time you went above and beyond.
5. Tell me about leading a team through ambiguity.

### Technical (AI/ML)
1. How would you evaluate a RAG system in production?
2. How do you handle hallucinations in a customer-facing chatbot?
3. Walk me through how you'd build a CV system for real-time camera feeds.
4. How do you decide between fine-tuning and RAG for a new use case?
5. What's your approach to MLOps at a small team?

### System design
1. Design a real-time threat detection system for 100 camera feeds.
2. Design an enterprise RAG system that scales to 10,000 employees.
3. Design an on-prem LLM stack for a regulated industry.
4. Design a CI/CD pipeline for ML models.
5. Design a system to ingest 15 years of unstructured documents.
