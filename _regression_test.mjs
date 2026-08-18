// Regression test: ensure round-31 / round-32 cases still pass with new compileKeyword
import { buildTitleFilter } from './scan.mjs';
import fs from 'fs';
import yaml from 'js-yaml';
const cfg = yaml.load(fs.readFileSync('portals.yml', 'utf8'));

const filter = buildTitleFilter(cfg.title_filter);

// Regression cases from round-31 / round-32 stress tests
const regression_cases = [
  // Round-31 stress test titles
  ["Software Engineer Intern", true],
  ["AI Research Intern", true],
  ["Machine Learning Intern, Summer 2028", true],
  ["SWE Intern - Backend", true],
  ["PhD Research Intern", false],  // PhD in negative
  ["Senior Software Engineer", false],
  ["Staff Data Engineer", false],
  ["Principal Engineer", false],
  ["iOS Engineer Intern", false],
  ["PhD Software Engineer Intern", false],
  ["Director, US International Tax", false],
  ["Internal Communications Manager", false],
  ["Software Development Engineer (Full-time)", false],
  ["Account Executive", false],
  ["Product Manager", false],
  ["Seniority-based program manager", false],

  // Round-32 stress test titles
  ["AI Builder Intern", true],
  ["Roblox Software Engineer Intern", true],  // Roblox had "[Summer 2027] SWE Intern"
  ["Software Engineer, Intern", true],
  ["PhD GenAI Research Scientist Intern", false],
  ["Research Engineer Intern (Fall 2026)", true],  // Cloudflare had this
  ["Network Strategy Intern (Fall 2026)", true],
  ["Brand Social Media Intern (Fall 2026)", true],

  // Round-33 specific — grad targeting
  ["Graduate Intern", false],
  ["MS Research Intern", false],
  ["MBA Intern", false],
  ["Postdoctoral Intern", false],
  ["PhD Intern", false],
  ["Doctoral Intern", false],
  ["Undergraduate Research Intern", true],
  ["Undergraduate Intern", true],
];

let pass = 0, fail = 0;
const fails = [];
for (const [title, expected] of regression_cases) {
  const actual = filter(title);
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    fails.push([title, expected, actual]);
  }
}

console.log(`Regression: PASS=${pass} FAIL=${fail}`);
for (const [title, expected, actual] of fails) {
  console.log(`  FAIL: expected=${expected} got=${actual}: "${title}"`);
}
