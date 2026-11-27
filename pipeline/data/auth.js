#!/usr/bin/env node
// Step 1: check access. Gets a token from client id + secret and shows the shop and granted scopes.
// Usage: node pipeline/data/auth.js
const { getToken, gql, store, main } = require('./shopify');
const { readJSON } = require('../lib');
const path = require('path');

main(async () => {
  await getToken(true);
  const d = await gql(`{ shop { name myshopifyDomain plan { displayName } } currentAppInstallation { accessScopes { handle } } }`);
  const scopes = d.currentAppInstallation.accessScopes.map(s => s.handle);
  const need = ['write_products', 'write_files', 'write_metaobject_definitions', 'write_metaobjects', 'write_online_store_navigation', 'write_publications', 'write_content'];
  console.log(`Connected: ${d.shop.name} (${d.shop.myshopifyDomain}), plan ${d.shop.plan.displayName}`);
  console.log('Scopes: ' + scopes.join(', '));
  const missing = need.filter(s => !scopes.includes(s));
  if (missing.length) console.log('MISSING scopes (add in app config, reinstall): ' + missing.join(', '));
  else console.log('All needed scopes present.');
  const cache = readJSON(path.join(__dirname, '.token.json'), null);
  if (cache) console.log('Token cached until ' + new Date(cache.expiresAt).toLocaleString() + ' (auto-refreshes).');
});
