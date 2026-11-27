#!/usr/bin/env node
// Create (or update with --update) products from inputs/data/products.json: variants, images, metafields,
// collection membership and Online Store publishing.
// Usage: node pipeline/data/products.js [--file inputs/data/products.json] [--update] [--limit 20]
// File: [{ "handle": "gold-balloon", "title": "Gold Balloon", "descriptionHtml": "<p>..</p>", "vendor": "Lombard",
//          "productType": "Balloons", "tags": ["gold"], "status": "ACTIVE",
//          "options": [{ "name": "Size", "values": ["Small", "Large"] }],
//          "variants": [{ "options": { "Size": "Small" }, "price": "9.95", "compareAtPrice": null, "sku": "GB-S" }],
//          "images": [{ "src": "https://...jpg", "alt": "Gold balloon" }],
//          "collections": ["balloons"],
//          "metafields": [{ "namespace": "custom", "key": "ingredients", "type": "multi_line_text_field", "value": "..." }] }]
const { gql, checkUserErrors, loadMap, saveMap, resolveRefs, publish, args, readInput, main, uploadImage, isUrl } = require('./shopify');

async function findByHandle(handle) {
  const d = await gql(`query($q: String!) { products(first: 1, query: $q) { nodes { id handle } } }`, { q: `handle:'${handle}'` });
  return d.products.nodes.find(n => n.handle === handle) || null;
}

function buildInput(p, map) {
  let options = (p.options || []).filter(o => o.name && o.values && o.values.length);
  let variants = p.variants && p.variants.length ? p.variants : [{ price: p.price || '0.00' }];
  if (!options.length) {
    options = [{ name: 'Title', values: ['Default Title'] }];
    variants = [{ ...variants[0], options: { Title: 'Default Title' } }];
  }
  const input = {
    title: p.title, handle: p.handle, status: p.status || 'ACTIVE',
    productOptions: options.map(o => ({ name: o.name, values: o.values.map(v => ({ name: String(v) })) })),
    variants: variants.map(v => {
      const out = {
        optionValues: options.map(o => ({ optionName: o.name, name: String((v.options || {})[o.name] ?? o.values[0]) })),
        price: String(v.price ?? '0.00'),
        inventoryItem: { tracked: false, ...(v.sku ? { sku: v.sku } : {}) },
      };
      if (v.compareAtPrice) out.compareAtPrice = String(v.compareAtPrice);
      if (v.barcode) out.barcode = v.barcode;
      return out;
    }),
  };
  for (const k of ['descriptionHtml', 'vendor', 'productType']) if (p[k]) input[k] = p[k];
  if (p.tags && p.tags.length) input.tags = p.tags;
  if (p.images && p.images.length) input.files = p.images.slice(0, 20).map(i => ({ originalSource: i.src, alt: i.alt || p.title, contentType: 'IMAGE' }));
  if (p.metafields && p.metafields.length) input.metafields = p.metafields.map(m => ({ namespace: m.namespace, key: m.key, type: m.type, value: resolveRefs(m.value, map) }));
  if (p.seo) input.seo = p.seo;
  return input;
}

main(async () => {
  const { flag } = args();
  let list = readInput(flag.file, 'inputs/data/products.json');
  if (flag.limit) list = list.slice(0, Number(flag.limit));
  const map = loadMap();
  let made = 0, updated = 0, skipped = 0, failed = 0;
  for (const p of list) {
    try {
      const found = await findByHandle(p.handle);
      let id;
      if (found && !flag.update) { id = found.id; skipped++; console.log('exists   ' + p.handle); }
      else {
        // Local image paths (e.g. inputs/assets/dummy/x.png) are uploaded to Files first.
        for (const img of p.images || []) if (!isUrl(img.src)) { img.src = await uploadImage(img.src, map, img.alt || p.title); saveMap(map); }
        const r = await gql(`mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $synchronous: Boolean!) {
          productSet(input: $input, identifier: $identifier, synchronous: $synchronous) { product { id handle } userErrors { field message code } } }`,
          { input: buildInput(p, map), identifier: found ? { handle: p.handle } : null, synchronous: true });
        checkUserErrors('productSet ' + p.handle, r.productSet);
        id = r.productSet.product.id;
        found ? updated++ : made++;
        console.log((found ? 'updated  ' : 'created  ') + p.handle);
      }
      for (const h of p.collections || []) {
        const col = map.collections[h];
        if (!col) { console.warn(`  WARN: collection "${h}" not in data-map (run collections.js first)`); continue; }
        if (col.smart) continue; // smart collections fill themselves from rules
        const r = await gql(`mutation($id: ID!, $productIds: [ID!]!) { collectionAddProducts(id: $id, productIds: $productIds) { userErrors { field message } } }`, { id: col.id, productIds: [id] });
        const errs = r.collectionAddProducts.userErrors.filter(e => !/already/i.test(e.message));
        if (errs.length) console.warn('  WARN: ' + errs.map(e => e.message).join('; '));
      }
      const published = await publish(id);
      map.products[p.handle] = { id, title: p.title, collections: p.collections || [], published, dummy: (p.tags || []).includes('bot-dummy') };
      saveMap(map);
    } catch (e) { failed++; console.error(`FAILED   ${p.handle}: ${e.message}`); }
  }
  console.log(`Products: ${made} created, ${updated} updated, ${skipped} already existed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
});
