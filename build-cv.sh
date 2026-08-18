#!/bin/bash
node build-cv-html.mjs /tmp/cv-muhammad-aaryan-tahir-scaleai.json output/cv-muhammad-aaryan-tahir-scaleai.html
node verify-cv-facts.mjs output/cv-muhammad-aaryan-tahir-scaleai.html
node generate-pdf.mjs output/cv-muhammad-aaryan-tahir-scaleai.html output/cv-muhammad-aaryan-tahir-scaleai-2026-08-07.pdf --format=letter --report=018
