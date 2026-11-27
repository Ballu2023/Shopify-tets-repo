#!/usr/bin/env node
// TEST STORES ONLY: fill product metafields with sample values so sections can be checked with data.
// Uses the "samples" list of each definition in inputs/data/metafields.json and picks one at random per product.
// Usage: node pipeline/data/sample-values.js [--limit 20] [--file inputs/data/metafields.json]
//   Products come from reports/backend/data-map.json; if empty, the first --limit products of the store are used.
const { gql, checkUserErrors, loadMap, args, readInput, main } = require('./shopify');

const pick = a => a[Math.floor(Math.random() * a.length)];
function sampleValue(def) {
  const s = def.samples;
  if (def.type.startsWith('list.')) {
    const n = Math.min(s.length, 2 + Math.floor(Math.random() * 2));
    return JSON.stringify([...s].sort(() => Math.random() - 0.5).slice(0, n));
  }
  if (def.type === 'boolean') return String(pick(s));
  return String(pick(s));
}

main(async () => {
  const { flag } = args();
  const defs = readInput(flag.file, 'inputs/data/metafields.json').filter(d => d.ownerType === 'PRODUCT' && Array.isArray(d.samples) && d.samples.length);
  if (!defs.length) throw new Error('No PRODUCT definitions with a "samples" list in metafields.json');
  const limit = Number(flag.limit || 20);
  const map = loadMap();
  let products = Object.entries(map.products).map(([handle, p]) => ({ handle, id: p.id })).slice(0, limit);
  if (!products.length) {
    const d = await gql(`query($n: Int!) { products(first: $n) { nodes { id handle } } }`, { n: limit });
    products = d.products.nodes;
  }
  const rows = [];
  for (const p of products) for (const d of defs) rows.push({ ownerId: p.id, namespace: d.namespace, key: d.key, type: d.type, value: sampleValue(d) });
  for (let i = 0; i < rows.length; i += 25) {
    const r = await gql(`mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message code } } }`, { metafields: rows.slice(i, i + 25) });
    checkUserErrors('metafieldsSet', r.metafieldsSet);
  }
  console.log(`Sample values set: ${defs.length} metafields × ${products.length} products (${rows.length} values).`);
  console.log('Products: ' + products.map(p => p.handle).join(', '));
});
