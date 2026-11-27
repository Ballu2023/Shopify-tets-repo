#!/usr/bin/env node
// Remove the dummy data the Backend bot created (products tagged "bot-dummy" + collections marked dummy in data-map).
// Safe by default: shows what WOULD be deleted. Add --yes to really delete.
// Usage: node pipeline/data/cleanup.js            (preview)
//        node pipeline/data/cleanup.js --yes      (delete)
const { gql, checkUserErrors, loadMap, saveMap, args, main } = require('./shopify');

main(async () => {
  const { flag } = args();
  const map = loadMap();
  // Products: anything in the store tagged bot-dummy (even if the map was lost).
  const products = [];
  let after = null;
  do {
    const d = await gql(`query($after: String) { products(first: 100, after: $after, query: "tag:'bot-dummy'") { nodes { id handle title } pageInfo { hasNextPage endCursor } } }`, { after });
    products.push(...d.products.nodes);
    after = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (after);
  const collections = Object.entries(map.collections).filter(([, c]) => c.dummy).map(([handle, c]) => ({ handle, id: c.id, title: c.title }));

  console.log(`Dummy products: ${products.length}`);
  products.forEach(p => console.log('  - ' + p.handle));
  console.log(`Dummy collections: ${collections.length}`);
  collections.forEach(c => console.log('  - ' + c.handle));
  if (!flag.yes) { console.log('\nPreview only. Run again with --yes to delete these.'); return; }

  for (const p of products) {
    const r = await gql(`mutation($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }`, { input: { id: p.id } });
    checkUserErrors('productDelete ' + p.handle, r.productDelete);
    delete map.products[p.handle];
    console.log('deleted product ' + p.handle);
  }
  for (const c of collections) {
    const r = await gql(`mutation($input: CollectionDeleteInput!) { collectionDelete(input: $input) { deletedCollectionId userErrors { field message } } }`, { input: { id: c.id } });
    checkUserErrors('collectionDelete ' + c.handle, r.collectionDelete);
    delete map.collections[c.handle];
    console.log('deleted collection ' + c.handle);
  }
  saveMap(map);
  console.log('Dummy data removed. Uploaded placeholder images stay in Files (harmless); delete them from Content → Files if you want.');
});
