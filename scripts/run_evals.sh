#!/usr/bin/env bash

JOBS=(
  "https://apply.careers.microsoft.com/careers/job/1970393556922923|Microsoft|Software Engineer Intern - Cloud & Distributed Backend"
  "https://lifeattiktok.com/search/7668834837268416821|TikTok|Backend Software Engineer Intern - Global E-Commerce"
  "https://ats.rippling.com/rippling/jobs/35b3ba25-ff2e-4b68-a2d7-61be26f2b24a|Rippling|Full Stack Software Engineer Intern"
  "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California---San-Francisco/Software-Engineering-Intern---Future-Pathways_JR355842|Salesforce|Software Engineer Intern - Future Pathways"
  "https://careers.formlabs.com/job/8065543/apply/?gh_jid=8065543|Formlabs|Test Software Intern"
)

mkdir -p /tmp/career_ops_evals

eval_job() {
  local url="$1"
  local company="$2"
  local role="$3"
  
  echo "Evaluating $company..."
  agy --dangerously-skip-permissions -p "Evaluate this JD: $url using modes/auto-pipeline.md. Output ONLY a raw JSON with {\"score\": <number>, \"report_path\": \"<path-to-saved-report>\", \"company\": \"<company>\"} after saving the report." > "/tmp/career_ops_evals/${company}.json"
  
  local score=$(grep -oP '"score":\s*\K[0-9.]+' "/tmp/career_ops_evals/${company}.json" | head -1)
  echo "Score for $company is $score"
  
  if [[ -n "$score" ]] && (( $(echo "$score >= 4.0" | bc -l) )); then
    echo "Score >= 4.0, generating PDF for $company..."
    agy --dangerously-skip-permissions -p "Generate a PDF CV for $company $role using modes/pdf.md. Output ONLY the absolute path to the generated PDF." > "/tmp/career_ops_evals/${company}_pdf.txt"
    PDF_PATH=$(cat "/tmp/career_ops_evals/${company}_pdf.txt" | grep -oP '/home/Aarz/[^"]+\.pdf' | head -1)
    if [[ -n "$PDF_PATH" ]]; then
       /home/Aarz/career-ops/scripts/upload-to-nextcloud.sh "$PDF_PATH"
    fi
  fi
}

export -f eval_job

for job in "${JOBS[@]}"; do
  url=$(echo "$job" | cut -d'|' -f1)
  company=$(echo "$job" | cut -d'|' -f2)
  role=$(echo "$job" | cut -d'|' -f3)
  eval_job "$url" "$company" "$role" &
done

wait
echo "All evaluations finished."
