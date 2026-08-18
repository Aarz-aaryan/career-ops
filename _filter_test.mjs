import { compileKeyword, buildTitleFilter } from './scan.mjs';
import fs from 'fs';
import yaml from 'js-yaml';
const cfg = yaml.load(fs.readFileSync('portals.yml', 'utf8'));

const filter = buildTitleFilter(cfg.title_filter);
const negative_list = cfg.title_filter.negative;
const positive_list = cfg.title_filter.positive;

const test_titles = [
  // Grad-targeting — MUST REJECT
  ["PhD GenAI Research Scientist Intern", false],
  ["PhD Intern, AI Research", false],
  ["Graduate Research Intern", false],
  ["Graduate Intern", false],
  ["MS Research Intern, AI", false],
  ["Master's Intern - Computer Vision", false],
  ["Graduate Intern, Applied ML", false],
  ["Postdoctoral Researcher Intern", false],
  ["Postdoc Intern", false],
  ["MBA Intern, Strategy", false],
  ["MBA Summer Intern", false],
  ["MBA Program Intern", false],
  ["Doctoral Intern, Statistics", false],
  ["PhD Required Intern", false],
  ["Returning Professional SWE Intern", false],
  ["Data Science Intern (Graduate)", false],
  ["Advanced Degree Required Intern", false],
  ["PhD Student Intern", false],
  ["Grad Student Researcher Intern", false],
  ["MS Program Intern", false],
  ["Master Student Researcher Intern", false],
  ["Graduate Degree Intern", false],
  ["Graduate Program Intern", false],
  ["Amazon Graduate Hiring Program Intern", false],
  ["Software Engineer Intern (New Graduate)", false],
  ["PhD Research Intern, Machine Learning", false],
  ["PhD Candidate Research Intern", false],
  ["Research Intern (PhD Required)", false],

  // Undergrad-targeted — MUST PASS
  ["Software Engineer Intern", true],
  ["AI Research Intern", true],
  ["Machine Learning Intern, Summer 2028", true],
  ["SWE Intern - Backend", true],
  ["AI Builder Intern", true],
  ["Software Engineering Intern (Class of 2028)", true],
  ["College Student Intern Program", true],
  ["Undergraduate Research Intern", true],
  ["Undergraduate Intern", true],
  ["Bachelor's Intern - Software Engineering", true],
  ["2028 Summer Intern - AI Engineering", true],

  // Seniority filters — should still work
  ["Senior Software Engineer", false],
  ["Director, US International Tax", false],
  ["Manager of Engineering", false],
  ["Principal Engineer", false],
  ["Staff Engineer", false],
  ["Lead Software Engineer", false],
  ["VP of Engineering", false],
  ["Head of Engineering", false],

  // Edge cases
  ["Internal Communications Intern", true],
  ["Junior Software Engineer Intern", false],
  ["iOS Engineer Intern", false],
  ["Android Engineer Intern", false],
];

let pass = 0, fail = 0;
const fails = [];
for (const [title, expected] of test_titles) {
  const actual = filter(title);
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    fails.push([title, expected, actual]);
  }
}

console.log(`PASS=${pass} FAIL=${fail}`);
for (const [title, expected, actual] of fails) {
  console.log(`  FAIL: expected=${expected} got=${actual}: "${title}"`);
}
