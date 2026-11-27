#!/usr/bin/env node
// Run an Admin GraphQL query/mutation for the Backend bot.
// Needs SHOPIFY_ADMIN_TOKEN in .env (custom app token with the scopes you need).
// Usage: node pipeline/admin.js --file reports/gql/create-collection.graphql [--vars reports/gql/vars.json]
//        node pipeline/admin.js --q "{ shop { name } }"
const fs = require('fs');
const path = require('path');
const { P, config } = require('./lib');

const env = {};
try { for (const l of fs.readFileSync(path.join(P.root, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const a = process.argv.slice(2), flag = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) flag[a[i].slice(2)] = a[++i];

const cfg = config();
const token = env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
if (!token) { console.error('ERROR: SHOPIFY_ADMIN_TOKEN missing in .env'); process.exit(1); }
const query = flag.q || (flag.file && fs.readFileSync(path.resolve(P.root, flag.file), 'utf8'));
if (!query) { console.error('Usage: --q "<graphql>" or --file <path>'); process.exit(1); }
const variables = flag.vars ? JSON.parse(fs.readFileSync(path.resolve(P.root, flag.vars), 'utf8')) : {};

fetch(`https://${cfg.store}/admin/api/${cfg.apiVersion || '2026-10'}/graphql.json`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
  body: JSON.stringify({ query, variables }),
}).then(r => r.json()).then(j => {
  console.log(JSON.stringify(j, null, 2));
  const userErrors = JSON.stringify(j).match(/"userErrors":\[\{/);
  if (j.errors || userErrors) process.exit(1);
}).catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
