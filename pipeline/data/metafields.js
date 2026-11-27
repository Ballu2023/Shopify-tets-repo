#!/usr/bin/env node
// Create metafield definitions from inputs/data/metafields.json. Existing ones are skipped.
// Usage: node pipeline/data/metafields.js [--file inputs/data/metafields.json]
// File: [{ "ownerType": "PRODUCT", "namespace": "custom", "key": "ingredients", "name": "Ingredients",
//          "type": "rich_text_field", "description": "...", "validations": [{ "name": "max", "value": "500" }] }]
const { gql, checkUserErrors, loadMap, saveMap, args, readInput, main } = require('./shopify');

main(async () => {
  const { flag } = args();
  const defs = readInput(flag.file, 'inputs/data/metafields.json');
  const map = loadMap();
  let made = 0, skipped = 0;
  for (const d of defs) {
    const key = `${d.ownerType}.${d.namespace}.${d.key}`;
    const definition = { name: d.name, namespace: d.namespace, key: d.key, type: d.type, ownerType: d.ownerType };
    if (d.description) definition.description = d.description;
    if (d.validations) definition.validations = d.validations;
    if (d.pin) definition.pin = true;
    const r = await gql(`mutation($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) { createdDefinition { id } userErrors { field message code } } }`, { definition });
    const existed = checkUserErrors(`metafield ${key}`, r.metafieldDefinitionCreate, ['TAKEN']);
    map.metafieldDefinitions[key] = { id: r.metafieldDefinitionCreate.createdDefinition?.id || map.metafieldDefinitions[key]?.id || null, type: d.type, name: d.name };
    existed ? skipped++ : made++;
    console.log(`${existed ? 'exists ' : 'created'}  ${key} (${d.type})`);
  }
  saveMap(map);
  console.log(`Metafield definitions: ${made} created, ${skipped} already existed.`);
});
