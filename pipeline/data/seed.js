#!/usr/bin/env node
// Create DUMMY test data for the current design in one go (marked "bot-dummy", removable with cleanup.js):
//   metafield definitions → placeholder images → dummy collections → dummy products → sample metafield values
// Input: inputs/data/dummy-collections.json, inputs/data/dummy-products.json (Backend bot writes these from the section specs)
// Usage: node pipeline/data/seed.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { P } = require('../lib');

const has = f => fs.existsSync(path.join(P.root, f));
const steps = [
  ['auth.js', [], true],
  ['metafields.js', [], has('inputs/data/metafields.json')],
  ['placeholder.js', [], true],
  ['collections.js', ['--file', 'inputs/data/dummy-collections.json'], has('inputs/data/dummy-collections.json')],
  ['products.js', ['--file', 'inputs/data/dummy-products.json'], has('inputs/data/dummy-products.json')],
  ['sample-values.js', [], has('inputs/data/metafields.json')],
];
for (const [script, a, run] of steps) {
  if (!run) { console.log(`\n— skip ${script} (no input)`); continue; }
  console.log(`\n=== ${script} ${a.join(' ')} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...a], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\nStopped: ${script} failed. Fix it and run seed again (done steps are skipped).`); process.exit(1); }
}
console.log('\nDummy data ready (tag: bot-dummy). Map: reports/backend/data-map.json. Remove later with: node pipeline/data/cleanup.js --yes');
