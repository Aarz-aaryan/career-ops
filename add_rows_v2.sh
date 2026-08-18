#!/usr/bin/env bash
set -e

create_row() {
  local json_payload="$1"
  curl -s -w '\n%{http_code}' \
       -u "aaryantahir8918@gmail.com:aarz1947" \
       -X POST \
       -H "Content-Type: application/json" \
       -H "OCS-APIRequest: true" \
       -d "$json_payload" \
       "http://100.84.224.18:9080/ocs/v2.php/apps/tables/api/1/tables/6/rows"
  echo ""
}

echo "Row 1 (Notion Winter)"
create_row '{"111":"Notion","112":"Software Engineer Intern (Winter 2027)","113":"https://jobs.ashbyhq.com/notion/e66c6658-9e65-4c58-8db2-844628b6e8f8","116":"v1","118":"1","119":"Ashby","120":"2026-08-14","123":"http://100.84.224.18:9080/remote.php/dav/files/aaryantahir8918@gmail.com/Career-ops/Resumes/cv-aaryan-notion-winter-2026-08-14.pdf","127":"To Apply","128":"High","129":"No","130":"Yes","137":4.6,"138":"primary","139":"2026-08-14"}'

echo "Row 2 (Notion Summer)"
create_row '{"111":"Notion","112":"Software Engineer Intern (Summer 2027)","113":"https://jobs.ashbyhq.com/notion/3fba1c39-c5cb-47d7-9ad2-1cec4d7e9d0c","116":"v1","118":"1","119":"Ashby","120":"2026-08-14","123":"http://100.84.224.18:9080/remote.php/dav/files/aaryantahir8918@gmail.com/Career-ops/Resumes/cv-aaryan-notion-summer-2026-08-14.pdf","127":"To Apply","128":"High","129":"No","130":"Yes","137":4.8,"138":"primary","139":"2026-08-14"}'

echo "Row 3 (Abridge)"
create_row '{"111":"Abridge","112":"Software Engineer, Intern","113":"https://jobs.ashbyhq.com/abridge/3f07a457-dc14-4238-bf4e-5c33b5c1f883","116":"v1","118":"1","119":"Ashby","120":"2026-08-14","123":"http://100.84.224.18:9080/remote.php/dav/files/aaryantahir8918@gmail.com/Career-ops/Resumes/cv-aaryan-abridge-2026-08-14.pdf","127":"To Apply","128":"High","129":"No","130":"Yes","137":4.7,"138":"primary","139":"2026-08-14"}'

echo "Row 4 (Centerfield)"
create_row '{"111":"Centerfield","112":"Frontend Engineer Intern (6 month internship)","113":"https://jobs.ashbyhq.com/centerfield/1d7eacc1-37f7-478c-9b0a-fa7974f1a9e4","116":"v1","118":"1","119":"Ashby","120":"2026-08-14","123":"http://100.84.224.18:9080/remote.php/dav/files/aaryantahir8918@gmail.com/Career-ops/Resumes/cv-aaryan-centerfield-2026-08-14.pdf","127":"To Apply","128":"High","129":"No","130":"Yes","137":4.5,"138":"primary","139":"2026-08-14"}'

echo "Row 5 (Epic Games)"
create_row '{"111":"Epic Games","112":"Gameplay Programmer Intern (LEGO Fortnite)","113":"https://epicgames.com/careers/jobs/6141180004?gh_jid=6141180004","116":"v1","118":"1","119":"Greenhouse","120":"2026-08-14","123":"http://100.84.224.18:9080/remote.php/dav/files/aaryantahir8918@gmail.com/Career-ops/Resumes/cv-aaryan-epic-games-2026-08-14.pdf","127":"To Apply","128":"High","129":"No","130":"Yes","137":3.9,"138":"TIER_FALLBACK","139":"2026-08-14"}'
