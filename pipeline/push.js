#!/usr/bin/env node
// Push only the given theme files to the UNPUBLISHED bot theme. Never touches the live theme.
// Usage: node pipeline/push.js sections/custom-hero.liquid templates/index.json
const { spawnSync } = require('child_process');
const { config } = require('./lib');

const cfg = config();
const files = process.argv.slice(2);
if (!cfg.store || cfg.store.startsWith('your-store')) { console.error('ERROR: set "store" in pipeline/config.json'); process.exit(1); }
if (!cfg.themeId) { console.error('ERROR: set "themeId" (the unpublished bot theme) in pipeline/config.json. See README step 4.'); process.exit(1); }
if (!files.length) { console.error('Usage: node pipeline/push.js <file> [file...]   (paths relative to the theme folder)'); process.exit(1); }

const q = s => '"' + String(s).replace(/"/g, '\\"') + '"';
const args = ['theme', 'push', '--store', q(cfg.store), '--theme', q(cfg.themeId), '--path', q(cfg.themeDir), '--nodelete'];
for (const f of files) args.push('--only', q(f.replace(/\\/g, '/')));
const r = spawnSync('shopify', args, { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
