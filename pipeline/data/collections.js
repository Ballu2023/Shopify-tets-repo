#!/usr/bin/env node
// Create (or update with --update) collections from inputs/data/collections.json and publish them.
// Usage: node pipeline/data/collections.js [--file inputs/data/collections.json] [--update]
// File: [{ "handle": "balloons", "title": "Balloons", "descriptionHtml": "<p>..</p>",
//          "image": { "src": "https://...jpg", "alt": "Balloons" },
//          "rules": { "appliedDisjunctively": false, "rules": [{ "column": "TAG", "relation": "EQUALS", "condition": "balloon" }] } }]
//   Without "rules" the collection is manual; products.js adds products to it.
const { gql, checkUserErrors, loadMap, saveMap, publish, args, readInput, main, uploadImage, isUrl } = require('./shopify');

async function findByHandle(handle) {
  const d = await gql(`query($q: String!) { collections(first: 1, query: $q) { nodes { id handle title } } }`, { q: `handle:'${handle}'` });
  return d.collections.nodes.find(n => n.handle === handle) || null;
}

main(async () => {
  const { flag } = args();
  const list = readInput(flag.file, 'inputs/data/collections.json');
  const map = loadMap();
  let made = 0, updated = 0, skipped = 0;
  for (const c of list) {
    const input = { title: c.title, handle: c.handle };
    if (c.descriptionHtml) input.descriptionHtml = c.descriptionHtml;
    if (c.image && c.image.src && !isUrl(c.image.src)) { c.image.src = await uploadImage(c.image.src, map, c.image.alt || c.title); saveMap(map); }
    if (c.image && c.image.src) input.image = { src: c.image.src, altText: c.image.alt || c.title };
    if (c.rules) input.ruleSet = c.rules;
    if (c.sortOrder) input.sortOrder = c.sortOrder;
    if (c.seo) input.seo = c.seo;
    const found = await findByHandle(c.handle);
    let id;
    if (found && !flag.update) { id = found.id; skipped++; console.log('exists   ' + c.handle); }
    else if (found) {
      delete input.ruleSet; // rule type cannot change on update
      const r = await gql(`mutation($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }`, { input: { ...input, id: found.id } });
      checkUserErrors('collectionUpdate ' + c.handle, r.collectionUpdate); id = found.id; updated++; console.log('updated  ' + c.handle);
    } else {
      const r = await gql(`mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id handle } userErrors { field message } } }`, { input });
      checkUserErrors('collectionCreate ' + c.handle, r.collectionCreate); id = r.collectionCreate.collection.id; made++; console.log('created  ' + c.handle);
    }
    const published = await publish(id);
    map.collections[c.handle] = { id, title: c.title, smart: !!c.rules, published, dummy: !!c.dummy };
    saveMap(map);
  }
  console.log(`Collections: ${made} created, ${updated} updated, ${skipped} already existed.`);
});
