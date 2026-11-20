#!/usr/bin/env node
// Read-only check that the AP timing and raw-plan files required by the checkpoint are present.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadQueries } from '../src/queries.js';
import { paths } from '../src/paths.js';

const timingFile = path.join(paths.apDir, '05_query_timings.md');
const problems = [];
const queries = [...loadQueries().values()];

if (!existsSync(timingFile)) {
  problems.push('missing dbms/05_query_timings.md');
} else {
  const timings = readFileSync(timingFile, 'utf8');
  for (const { id } of queries) {
    if (!timings.includes(`](plans/${id}.txt)`)) {
      problems.push(`timing table has no link to plans/${id}.txt`);
    }
  }
}

if (!existsSync(paths.apPlansDir)) {
  problems.push('missing dbms/plans/');
} else {
  const actual = new Set(readdirSync(paths.apPlansDir).filter((file) => file.endsWith('.txt')));
  const expected = new Set(queries.map(({ id }) => `${id}.txt`));
  for (const file of expected) {
    if (!actual.has(file)) {
      problems.push(`missing dbms/plans/${file}`);
      continue;
    }
    const plan = readFileSync(path.join(paths.apPlansDir, file), 'utf8');
    for (const run of [1, 2, 3]) {
      if (!plan.includes(`Run ${run}  [`)) {
        problems.push(`dbms/plans/${file} is missing run ${run}`);
      }
    }
  }
  for (const file of actual) {
    if (!expected.has(file)) problems.push(`unexpected AP plan file dbms/plans/${file}`);
  }
}

if (problems.length) {
  console.error(`AP deliverables incomplete:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

console.log(`AP deliverables present: timing table and ${queries.length} per-query plan files.`);
