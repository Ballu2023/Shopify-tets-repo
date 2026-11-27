#!/usr/bin/env node
// Create metaobject definitions and upsert entries from inputs/data/metaobjects.json.
// Usage: node pipeline/data/metaobjects.js [--file inputs/data/metaobjects.json] [--only definitions|entries]
// File: { "definitions": [{ "type": "faq", "name": "FAQ", "displayNameKey": "question",
//            "fields": [{ "key": "question", "name": "Question", "type": "single_line_text_field", "required": true }] }],
//         "entries": { "faq": [{ "handle": "shipping", "fields": { "question": "...", "answer": "..." } }] } }
// Field values may use refs: "@collection:balloons", "@product:handle", "@file:hero.jpg", "@metaobject:type/handle", or arrays of them.
const { gql, checkUserErrors, loadMap, saveMap, resolveRefs, args, readInput, main } = require('./shopify');

main(async () => {
  const { flag } = args();
  const input = readInput(flag.file, 'inputs/data/metaobjects.json');
  const map = loadMap();

  if (flag.only !== 'entries') {
    for (const d of input.definitions || []) {
      const definition = {
        type: d.type, name: d.name,
        displayNameKey: d.displayNameKey || (d.fields[0] && d.fields[0].key),
        fieldDefinitions: d.fields.map(f => ({ key: f.key, name: f.name || f.key, type: f.type, required: !!f.required, ...(f.validations ? { validations: f.validations } : {}) })),
        access: { storefront: 'PUBLIC_READ' },
        capabilities: { publishable: { enabled: true } },
      };
      const r = await gql(`mutation($definition: MetaobjectDefinitionCreateInput!) {
        metaobjectDefinitionCreate(definition: $definition) { metaobjectDefinition { id type } userErrors { field message code } } }`, { definition });
      const existed = checkUserErrors(`metaobject definition ${d.type}`, r.metaobjectDefinitionCreate, ['TAKEN']);
      map.metaobjectDefinitions[d.type] = { id: r.metaobjectDefinitionCreate.metaobjectDefinition?.id || map.metaobjectDefinitions[d.type]?.id || null, name: d.name, fields: d.fields.map(f => f.key) };
      console.log(`${existed ? 'exists ' : 'created'}  definition ${d.type}`);
    }
    saveMap(map);
  }

  if (flag.only !== 'definitions') {
    for (const [type, list] of Object.entries(input.entries || {})) {
      for (const e of list) {
        const fields = Object.entries(e.fields).map(([key, value]) => ({ key, value: resolveRefs(value, map) }));
        const r = await gql(`mutation($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
          metaobjectUpsert(handle: $handle, metaobject: $metaobject) { metaobject { id handle } userErrors { field message code } } }`,
          { handle: { type, handle: e.handle }, metaobject: { fields, capabilities: { publishable: { status: 'ACTIVE' } } } });
        checkUserErrors(`metaobject ${type}/${e.handle}`, r.metaobjectUpsert);
        map.metaobjects[`${type}/${e.handle}`] = { id: r.metaobjectUpsert.metaobject.id };
        console.log(`upserted entry ${type}/${e.handle}`);
      }
    }
    saveMap(map);
  }
  console.log('Metaobjects done. See reports/backend/data-map.json');
});
