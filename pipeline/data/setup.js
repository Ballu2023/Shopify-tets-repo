#!/usr/bin/env node
// Run the whole data setup in the right order, skipping steps whose input file is missing.
// Usage: node pipeline/data/setup.js [--update] [--samples]   (--samples = test store only: random metafield values)
//   auth → metafields → metaobjects (definitions) → collections → products → files → metaobjects (entries, may reference products/files)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { P } = require('../lib');

const update = process.argv.includes('--update') ? ['--update'] : [];
const has = f => fs.existsSync(path.join(P.root, f));
const steps = [
  ['auth.js', [], true],
  ['metafields.js', [], has('inputs/data/metafields.json')],
  ['metaobjects.js', ['--only', 'definitions'], has('inputs/data/metaobjects.json')],
  ['collections.js', update, has('inputs/data/collections.json')],
  ['products.js', update, has('inputs/data/products.json')],
  ['files.js', [], has('inputs/assets') && fs.readdirSync(path.join(P.root, 'inputs/assets')).some(f => /\.(jpe?g|png|webp|gif|svg)$/i.test(f))],
  ['metaobjects.js', ['--only', 'entries'], has('inputs/data/metaobjects.json')],
  ['sample-values.js', [], process.argv.includes('--samples') && has('inputs/data/metafields.json')],
];
for (const [script, args, run] of steps) {
  if (!run) { console.log(`\n— skip ${script} (no input)`); continue; }
  console.log(`\n=== ${script} ${args.join(' ')} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`\nStopped: ${script} failed. Fix the error above and run setup again (finished steps are skipped).`); process.exit(1); }
}
console.log('\nData setup complete. Map of everything created: reports/backend/data-map.json');
