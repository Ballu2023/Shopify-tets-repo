#!/usr/bin/env node
// Upload images to Shopify Files so sections can use real images.
// Usage: node pipeline/data/files.js [--dir inputs/assets]          (uploads every image in the folder)
//        node pipeline/data/files.js --url https://site.com/a.jpg --name hero-1.jpg
// In theme JSON an uploaded file is used as: "shopify://shop_images/<file name>"
const fs = require('fs');
const path = require('path');
const { gql, checkUserErrors, loadMap, saveMap, args, main, sleep } = require('./shopify');
const { P } = require('../lib');

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

async function createFile(originalSource, filename, alt) {
  const r = await gql(`mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } } }`,
    { files: [{ originalSource, contentType: 'IMAGE', filename, alt: alt || filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') }] });
  checkUserErrors('fileCreate ' + filename, r.fileCreate);
  const id = r.fileCreate.files[0].id;
  // Wait until Shopify has processed the image so the URL exists.
  for (let i = 0; i < 20; i++) {
    const s = await gql(`query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`, { id });
    const n = s.node || {};
    if (n.fileStatus === 'READY') return { id, url: n.image && n.image.url };
    if (n.fileStatus === 'FAILED') throw new Error('Shopify could not process ' + filename);
    await sleep(1500);
  }
  return { id, url: null };
}

async function uploadLocal(file) {
  const filename = path.basename(file);
  const mimeType = MIME[path.extname(file).toLowerCase()] || 'image/jpeg';
  const buf = fs.readFileSync(file);
  const r = await gql(`mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
    { input: [{ filename, mimeType, httpMethod: 'POST', resource: 'IMAGE', fileSize: String(buf.length) }] });
  checkUserErrors('stagedUploadsCreate ' + filename, r.stagedUploadsCreate);
  const t = r.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of t.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type: mimeType }), filename);
  const up = await fetch(t.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Upload of ${filename} failed: HTTP ${up.status}`);
  return createFile(t.resourceUrl, filename);
}

main(async () => {
  const { flag } = args();
  const map = loadMap();
  const jobs = [];
  if (flag.url) jobs.push({ name: flag.name || path.basename(new URL(flag.url).pathname), run: () => createFile(flag.url, flag.name || path.basename(new URL(flag.url).pathname)) });
  else {
    const dir = path.resolve(P.root, flag.dir || 'inputs/assets');
    if (!fs.existsSync(dir)) throw new Error('Folder not found: ' + path.relative(P.root, dir));
    for (const f of fs.readdirSync(dir).filter(f => MIME[path.extname(f).toLowerCase()]).sort())
      jobs.push({ name: f, run: () => uploadLocal(path.join(dir, f)) });
  }
  for (const j of jobs) {
    if (map.files[j.name] && !flag.force) { console.log('exists   ' + j.name + '  (use --force to upload again)'); continue; }
    const res = await j.run();
    map.files[j.name] = { id: res.id, url: res.url, theme: `shopify://shop_images/${j.name}` };
    saveMap(map);
    console.log('uploaded ' + j.name + '  →  shopify://shop_images/' + j.name);
  }
  console.log(`Files done (${jobs.length}). Theme references are in reports/backend/data-map.json → files.`);
});
