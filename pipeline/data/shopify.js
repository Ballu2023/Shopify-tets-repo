// Shared Shopify Admin client for the Backend bot scripts.
// Auth: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (client credentials grant, token cached + refreshed)
//       or SHOPIFY_ADMIN_TOKEN (old custom-app token). Values come from .env in the project root.
const fs = require('fs');
const path = require('path');
const { P, config, readJSON, writeJSON } = require('../lib');

const TOKEN_CACHE = path.join(P.root, 'pipeline', 'data', '.token.json');
const DATA_MAP = path.join(P.reports, 'backend', 'data-map.json');

function env() {
  const e = {};
  try {
    for (const l of fs.readFileSync(path.join(P.root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) e[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
  return { ...e, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SHOPIFY_') || k.startsWith('SOURCE_'))) };
}

function store() {
  const s = env().SHOPIFY_STORE || config().store;
  if (!s || s.startsWith('your-store')) throw new Error('Set "store" in pipeline/config.json (e.g. my-store.myshopify.com)');
  return s.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
const apiVersion = () => env().SHOPIFY_API_VERSION || config().apiVersion || '2026-10';
const base = () => env().SHOPIFY_ADMIN_BASE || `https://${store()}`; // ADMIN_BASE only for local mock tests

async function getToken(force = false) {
  const e = env();
  if (e.SHOPIFY_ADMIN_TOKEN && !e.SHOPIFY_CLIENT_ID) return e.SHOPIFY_ADMIN_TOKEN;
  if (!e.SHOPIFY_CLIENT_ID || !e.SHOPIFY_CLIENT_SECRET) throw new Error('Add SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN) to .env');
  const cached = readJSON(TOKEN_CACHE, null);
  if (!force && cached && cached.store === store() && cached.expiresAt > Date.now() + 5 * 60000) return cached.token;
  const res = await fetch(`${base()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: e.SHOPIFY_CLIENT_ID, client_secret: e.SHOPIFY_CLIENT_SECRET }),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  if (!res.ok || !j.access_token) {
    throw new Error(`Token request failed (${res.status}): ${JSON.stringify(j)}\n` +
      'Check: app is installed on this store, app and store are in the same Shopify organization, client id/secret are correct.');
  }
  const expiresAt = Date.now() + (Number(j.expires_in) || 86399) * 1000;
  writeJSON(TOKEN_CACHE, { store: store(), token: j.access_token, scope: j.scope, expiresAt });
  return j.access_token;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GraphQL with retry on throttling, 429, 5xx and one token refresh on 401.
async function gql(query, variables = {}, tries = 6) {
  let refreshed = false;
  for (let i = 0; i < tries; i++) {
    const token = await getToken();
    let res;
    try {
      res = await fetch(`${base()}/admin/api/${apiVersion()}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) { await sleep(1000 * (i + 1)); if (i === tries - 1) throw err; continue; }
    if (res.status === 401 && !refreshed) { refreshed = true; await getToken(true); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    const j = await res.json();
    const throttled = (j.errors || []).some(e => e.extensions && e.extensions.code === 'THROTTLED');
    if (throttled) { await sleep(2000 * (i + 1)); continue; }
    if (j.errors) throw new Error('GraphQL error: ' + JSON.stringify(j.errors).slice(0, 800));
    const ts = j.extensions && j.extensions.cost && j.extensions.cost.throttleStatus;
    if (ts && ts.currentlyAvailable < 200) await sleep(1000);
    return j.data;
  }
  throw new Error('GraphQL request failed after retries');
}

// Throws on userErrors except the codes we treat as "already exists".
function checkUserErrors(label, payload, okCodes = []) {
  const errs = (payload && payload.userErrors) || [];
  const real = errs.filter(e => !okCodes.includes(e.code));
  if (real.length) throw new Error(`${label}: ${real.map(e => (e.field ? e.field.join('.') + ': ' : '') + e.message).join('; ')}`);
  return errs.length > 0; // true when it was an allowed "exists" error
}

// data-map.json: everything the Backend bot created, so other bots can bind sections to real data.
function loadMap() { return readJSON(DATA_MAP, { store: null, collections: {}, products: {}, metafieldDefinitions: {}, metaobjectDefinitions: {}, metaobjects: {}, files: {}, updatedAt: null }); }
function saveMap(map) { map.store = store(); map.updatedAt = new Date().toISOString(); writeJSON(DATA_MAP, map); }

// Values like "@collection:balloons", "@product:handle", "@file:hero-1.jpg", "@metaobject:faq/shipping"
// are replaced with real GIDs from the data map. Arrays become JSON lists (for list.* reference types).
function resolveRefs(value, map) {
  const one = v => {
    if (typeof v !== 'string' || !v.startsWith('@')) return v;
    const [kind, ...rest] = v.slice(1).split(':'); const key = rest.join(':');
    const table = { collection: map.collections, product: map.products, file: map.files, metaobject: map.metaobjects }[kind];
    const hit = table && table[key];
    if (!hit || !hit.id) throw new Error(`Reference ${v} not found in data-map. Create it first.`);
    return hit.id;
  };
  if (Array.isArray(value)) return JSON.stringify(value.map(one));
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(one(value));
}

let onlineStoreId = null;
async function onlineStorePublication() {
  if (onlineStoreId !== null) return onlineStoreId;
  try {
    const d = await gql(`{ publications(first: 25) { nodes { id name } } }`);
    const pub = d.publications.nodes.find(p => /online store/i.test(p.name));
    onlineStoreId = pub ? pub.id : '';
  } catch (e) { console.warn('WARN: could not read publications (needs read_publications scope). Items will not be auto-published.'); onlineStoreId = ''; }
  return onlineStoreId;
}
async function publish(id) {
  const pubId = await onlineStorePublication();
  if (!pubId) return false;
  const d = await gql(`mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
    { id, input: [{ publicationId: pubId }] });
  const errs = d.publishablePublish.userErrors || [];
  if (errs.length) { console.warn('  WARN publish: ' + errs.map(e => e.message).join('; ')); return false; }
  return true;
}

function args() {
  const a = process.argv.slice(2), flag = {}, pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); flag[k] = a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[++i] : true; }
    else pos.push(a[i]);
  }
  return { flag, pos };
}
function readInput(file, fallback) {
  const f = path.resolve(P.root, file || fallback);
  if (!fs.existsSync(f)) throw new Error('Input file not found: ' + path.relative(P.root, f));
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function main(fn) { fn().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); }); }

// Upload a local image to Shopify Files and return its CDN URL (cached in data-map.files by file name).
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
async function uploadImage(localPath, map, alt) {
  const name = path.basename(localPath);
  if (map && map.files[name] && map.files[name].url) return map.files[name].url;
  const file = path.resolve(P.root, localPath);
  if (!fs.existsSync(file)) throw new Error('Image not found: ' + localPath);
  const mimeType = MIME[path.extname(file).toLowerCase()] || 'image/png';
  const buf = fs.readFileSync(file);
  const st = await gql(`mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`,
    { input: [{ filename: name, mimeType, httpMethod: 'POST', resource: 'IMAGE', fileSize: String(buf.length) }] });
  checkUserErrors('stagedUploadsCreate ' + name, st.stagedUploadsCreate);
  const t = st.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of t.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buf], { type: mimeType }), name);
  const up = await fetch(t.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Upload of ${name} failed: HTTP ${up.status}`);
  const r = await gql(`mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id } userErrors { field message } } }`,
    { files: [{ originalSource: t.resourceUrl, contentType: 'IMAGE', filename: name, alt: alt || name }] });
  checkUserErrors('fileCreate ' + name, r.fileCreate);
  const id = r.fileCreate.files[0].id;
  for (let i = 0; i < 30; i++) {
    const s2 = await gql(`query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`, { id });
    const n = s2.node || {};
    if (n.fileStatus === 'READY' && n.image) {
      if (map) map.files[name] = { id, url: n.image.url, theme: `shopify://shop_images/${name}` };
      return n.image.url;
    }
    if (n.fileStatus === 'FAILED') throw new Error('Shopify could not process ' + name);
    await sleep(1500);
  }
  throw new Error('Timed out waiting for ' + name);
}
const isUrl = s => /^https?:\/\//i.test(String(s || ''));

module.exports = { uploadImage, isUrl, env, store, apiVersion, getToken, gql, checkUserErrors, loadMap, saveMap, resolveRefs, publish, args, readInput, main, sleep, DATA_MAP };
