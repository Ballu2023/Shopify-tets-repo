#!/usr/bin/env node
// Pull real catalogue data from a live website into inputs/data/collections.json + products.json,
// ready for collections.js and products.js. Only use it on sites you have permission to copy (your client's own store).
//
// Source store Admin API (recommended): set SOURCE_CLIENT_ID + SOURCE_CLIENT_SECRET in .env → used automatically.
//   Includes product metafields (namespace "custom" by default, change with source.metafieldNamespaces).
// Shopify site (auto-detected): uses the public /collections.json and /products.json feeds.
//   node pipeline/data/extract.js --url https://client-store.com --collections balloons,hire --per-collection 10
//   node pipeline/data/extract.js --url https://client-store.com --limit 20            (first 20 products, all their collections)
// Any other site: scrapes product pages (sitemap or a URL list) using JSON-LD / Open Graph data.
//   node pipeline/data/extract.js --url https://site.com --mode scrape --limit 20 [--match /product/] [--collection "Balloons"]
//   node pipeline/data/extract.js --url https://site.com --mode scrape --product-urls inputs/data/urls.txt
// Options: --out inputs/data   --delay 1000 (ms between page requests)   --list-collections [--search hire] [--empty] (show source collection handles)
// Settings can live in pipeline/config.json "source" (url, collections, perCollection, limit) so you can run it with no flags.
const fs = require('fs');
const path = require('path');
const { P, writeJSON } = require('../lib');
const { args, main, sleep, env } = require('./shopify');
const { config } = require('../lib');

const UA = 'Mozilla/5.0 (compatible; BotStudioMigrator/1.0)';
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 80);
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

let COOKIE = '';
async function get(url, json) {
  const headers = { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,application/xml' };
  if (COOKIE) headers.Cookie = COOKIE;
  let r;
  for (let i = 0; i < 6; i++) {
    r = await fetch(url, { headers, redirect: 'follow' });
    if (r.status !== 429 && r.status < 500) break;
    const wait = (Number(r.headers.get('retry-after')) || 2 ** (i + 1)) * 1000;
    console.log(`  rate limited (${r.status}), waiting ${Math.round(wait / 1000)}s…`);
    await sleep(wait);
  }
  if (r.status === 401 || (json && /\/password/.test(r.url))) throw new Error(`Store is password protected (HTTP ${r.status}). Add "password" to "source" in pipeline/config.json (or SOURCE_PASSWORD in .env).`);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return json ? r.json() : r.text();
}

// Unlock a password-protected Shopify storefront and keep its session cookies for the feed requests.
async function unlock(base, password) {
  const r = await fetch(`${base}/password`, {
    method: 'POST', redirect: 'manual',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ form_type: 'storefront_password', utf8: '✓', password }),
  });
  const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || '']).map(c => c.split(';')[0]).filter(Boolean);
  COOKIE = cookies.join('; ');
  const loc = r.headers.get('location') || '';
  if (!COOKIE || /\/password/.test(loc)) throw new Error('Storefront password was not accepted. Check "source.password".');
  console.log('Storefront unlocked with password.');
}

// ---------- Shopify feeds ----------
function fromShopifyProduct(p) {
  const options = (p.options || []).filter(o => !(o.name === 'Title' && o.values && o.values[0] === 'Default Title'))
    .map(o => ({ name: o.name, values: o.values }));
  return {
    handle: p.handle, title: p.title, descriptionHtml: p.body_html || '', vendor: p.vendor || '', productType: p.product_type || '',
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map(t => t.trim()).filter(Boolean),
    status: 'ACTIVE', options,
    variants: (p.variants || []).map(v => ({
      options: Object.fromEntries(options.map((o, i) => [o.name, v['option' + (i + 1)]])),
      price: v.price, compareAtPrice: v.compare_at_price || null, sku: v.sku || '', barcode: v.barcode || undefined,
    })),
    images: (p.images || []).map(i => ({ src: i.src, alt: i.alt || p.title })),
    collections: [], source: 'shopify',
  };
}

async function shopify(base, flag) {
  const wanted = flag.collections ? String(flag.collections).split(',').map(s => s.trim()).filter(Boolean) : null;
  const per = Number(flag['per-collection'] || 10);
  const limit = Number(flag.limit || 0);
  let cols = [];
  if (wanted) {
    // Fetch only the collections we need (fewer requests, no rate limit trouble).
    for (const h of wanted) {
      try { const d = await get(`${base}/collections/${h}.json`, true); if (d.collection) cols.push(d.collection); }
      catch (e) { console.warn(`WARN: collection "${h}" not found on source (${e.message})`); }
      await sleep(Number(flag.delay || 1000));
    }
  } else {
    for (let page = 1; page < 20; page++) {
      const d = await get(`${base}/collections.json?limit=250&page=${page}`, true);
      if (!d.collections || !d.collections.length) break;
      cols.push(...d.collections);
      if (d.collections.length < 250) break;
    }
  }
  const products = new Map();
  const collections = [];
  if (wanted || !limit) {
    for (const c of cols.slice(0, wanted ? cols.length : Number(flag['max-collections'] || 10))) {
      collections.push({ handle: c.handle, title: c.title, descriptionHtml: c.body_html || '', image: c.image ? { src: c.image.src, alt: c.image.alt || c.title } : undefined });
      const d = await get(`${base}/collections/${c.handle}/products.json?limit=${per}`, true);
      for (const p of d.products || []) {
        const item = products.get(p.handle) || fromShopifyProduct(p);
        if (!item.collections.includes(c.handle)) item.collections.push(c.handle);
        products.set(p.handle, item);
      }
      console.log(`collection ${c.handle}: ${(d.products || []).length} products`);
      await sleep(Number(flag.delay || 1000));
    }
  } else {
    const d = await get(`${base}/products.json?limit=${Math.min(limit, 250)}`, true);
    for (const p of d.products || []) products.set(p.handle, fromShopifyProduct(p));
    console.log(`products: ${products.size}`);
  }
  return { collections, products: [...products.values()].slice(0, limit || undefined) };
}


// ---------- Source store Admin API (best: no rate-limit trouble, includes metafields) ----------
// .env: SOURCE_CLIENT_ID + SOURCE_CLIENT_SECRET (app from the Dev Dashboard org that owns the SOURCE store, installed on it)
//       or SOURCE_ADMIN_TOKEN. Store comes from source.url (must be the *.myshopify.com domain) or SOURCE_STORE.
function sourceAdmin(e, src, base) {
  const store = (e.SOURCE_STORE || src.store || new URL(base).host).replace(/^https?:\/\//, '');
  const origin = e.SOURCE_ADMIN_BASE || `https://${store}`;
  const version = e.SHOPIFY_API_VERSION || config().apiVersion || '2026-10';
  const cacheFile = path.join(P.root, 'pipeline', 'data', '.source-token.json');
  let token = e.SOURCE_ADMIN_TOKEN || null;
  async function getToken(force) {
    if (e.SOURCE_ADMIN_TOKEN) return e.SOURCE_ADMIN_TOKEN;
    if (!e.SOURCE_CLIENT_ID || !e.SOURCE_CLIENT_SECRET) throw new Error('Add SOURCE_CLIENT_ID and SOURCE_CLIENT_SECRET (or SOURCE_ADMIN_TOKEN) to .env for the source store');
    let c = null; try { c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
    if (!force && c && c.store === store && c.expiresAt > Date.now() + 300000) return c.token;
    const r = await fetch(`${origin}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: e.SOURCE_CLIENT_ID, client_secret: e.SOURCE_CLIENT_SECRET }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Source token failed (${r.status}): ${JSON.stringify(j)}. The app must be in the same Dev Dashboard org as ${store} and installed on it.`);
    writeJSON(cacheFile, { store, token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 86399) * 1000 });
    return j.access_token;
  }
  async function gql(query, variables = {}) {
    for (let i = 0; i < 6; i++) {
      token = await getToken(i > 0 && !token);
      const r = await fetch(`${origin}/admin/api/${version}/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }) });
      if (r.status === 401) { token = null; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      const j = await r.json();
      if ((j.errors || []).some(x => x.extensions && x.extensions.code === 'THROTTLED')) { await sleep(2000 * (i + 1)); continue; }
      if (j.errors) throw new Error('Source GraphQL error: ' + JSON.stringify(j.errors).slice(0, 600));
      return j.data;
    }
    throw new Error('Source Admin API failed after retries');
  }
  return { store, gql };
}

const PRODUCT_FIELDS = `handle title descriptionHtml vendor productType tags status
  options { name values }
  variants(first: 100) { nodes { price compareAtPrice sku barcode selectedOptions { name value } } }
  media(first: 10) { nodes { ... on MediaImage { image { url altText } } } }
  metafields(first: 50) { nodes { namespace key type value } }`;

function fromAdminProduct(p, mfNamespaces) {
  const options = (p.options || []).filter(o => !(o.name === 'Title' && o.values.length === 1 && o.values[0] === 'Default Title'));
  return {
    handle: p.handle, title: p.title, descriptionHtml: p.descriptionHtml || '', vendor: p.vendor || '', productType: p.productType || '',
    tags: p.tags || [], status: 'ACTIVE', options: options.map(o => ({ name: o.name, values: o.values })),
    variants: p.variants.nodes.map(v => ({
      options: Object.fromEntries(v.selectedOptions.filter(o => options.some(x => x.name === o.name)).map(o => [o.name, o.value])),
      price: v.price, compareAtPrice: v.compareAtPrice || null, sku: v.sku || '', barcode: v.barcode || undefined,
    })),
    images: p.media.nodes.filter(m => m.image).map(m => ({ src: m.image.url, alt: m.image.altText || p.title })),
    // Copy plain metafields only; *_reference values point to ids in the source store and would be wrong here.
    metafields: p.metafields.nodes.filter(m => mfNamespaces.includes(m.namespace) && !/reference/.test(m.type)),
    collections: [], source: 'admin',
  };
}

async function adminSource(base, flag, e, src) {
  const api = sourceAdmin(e, src, base);
  const shop = await api.gql(`{ shop { name myshopifyDomain } }`);
  console.log(`Source Admin API: ${shop.shop.name} (${shop.shop.myshopifyDomain})`);
  const mfNamespaces = String(flag.metafields || src.metafieldNamespaces || 'custom').split(',').map(s => s.trim());
  const wanted = flag.collections ? String(flag.collections).split(',').map(s => s.trim()).filter(Boolean) : [];
  const per = Number(flag['per-collection'] || 5), limit = Number(flag.limit || 0);
  const products = new Map(), collections = [];
  if (!wanted.length) {
    const d = await api.gql(`query($n: Int!) { products(first: $n, query: "status:active") { nodes { ${PRODUCT_FIELDS} } } }`, { n: Math.min(limit || 20, 250) });
    for (const p of d.products.nodes) products.set(p.handle, fromAdminProduct(p, mfNamespaces));
    console.log(`products: ${products.size}`);
  }
  for (const h of wanted) {
    const d = await api.gql(`query($q: String!, $n: Int!) { collections(first: 1, query: $q) { nodes {
        handle title descriptionHtml image { url altText }
        products(first: $n) { nodes { ${PRODUCT_FIELDS} } } } } }`, { q: `handle:'${h}'`, n: per });
    const c = d.collections.nodes.find(x => x.handle === h);
    if (!c) { console.warn(`WARN: collection "${h}" not found on source`); continue; }
    collections.push({ handle: c.handle, title: c.title, descriptionHtml: c.descriptionHtml || '', image: c.image ? { src: c.image.url, alt: c.image.altText || c.title } : undefined });
    for (const p of c.products.nodes) {
      const item = products.get(p.handle) || fromAdminProduct(p, mfNamespaces);
      if (!item.collections.includes(h)) item.collections.push(h);
      products.set(p.handle, item);
    }
    console.log(`collection ${h}: ${c.products.nodes.length} products`);
  }
  const mfCount = [...products.values()].reduce((a, p) => a + p.metafields.length, 0);
  if (mfCount) console.log(`metafields copied: ${mfCount} values (namespaces: ${mfNamespaces.join(', ')})`);
  return { collections, products: [...products.values()].slice(0, limit || undefined) };
}

// ---------- Generic scraping ----------
function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1].trim());
      const flat = x => Array.isArray(x) ? x.flatMap(flat) : x && x['@graph'] ? flat(x['@graph']) : [x];
      out.push(...flat(j));
    } catch {}
  }
  return out;
}
const isType = (o, t) => o && [].concat(o['@type'] || []).includes(t);
function meta(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
  return m ? decode(m[1]) : '';
}
const imgs = x => [].concat(x || []).map(i => typeof i === 'string' ? i : i && (i.url || i.contentUrl)).filter(Boolean);
const offerList = o => [].concat(o || []).flatMap(x => x && x.offers ? [].concat(x.offers) : [x]).filter(Boolean);

function fromPage(url, html, flag) {
  const blocks = jsonLdBlocks(html);
  const prod = blocks.find(b => isType(b, 'Product') || isType(b, 'ProductGroup'));
  const crumbs = blocks.find(b => isType(b, 'BreadcrumbList'));
  const handle = slug(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
  const title = decode(prod && prod.name) || meta(html, 'og:title');
  if (!title) return null;
  const description = decode(prod && prod.description) || meta(html, 'og:description');
  let images = imgs(prod && prod.image);
  if (!images.length && meta(html, 'og:image')) images = [meta(html, 'og:image')];
  images = images.map(i => new URL(i, url).href);
  let variants = [];
  if (prod && Array.isArray(prod.hasVariant) && prod.hasVariant.length) {
    variants = prod.hasVariant.map(v => { const o = offerList(v.offers)[0] || {}; return { options: { Variant: decode(v.name) }, price: String(o.price || '0.00'), sku: v.sku || '' }; });
  } else {
    const offers = offerList(prod && prod.offers);
    const price = offers[0] ? (offers[0].price || offers[0].lowPrice) : meta(html, 'product:price:amount');
    variants = [{ price: String(price || '0.00'), sku: (prod && prod.sku) || '' }];
  }
  let category = flag.collection || '';
  if (!category && crumbs && Array.isArray(crumbs.itemListElement) && crumbs.itemListElement.length > 2) {
    const items = crumbs.itemListElement.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
    const c = items[items.length - 2];
    category = decode(c.name || (c.item && c.item.name) || '');
  }
  return {
    handle: handle || slug(title), title, descriptionHtml: description ? `<p>${description}</p>` : '',
    vendor: decode(prod && prod.brand && (prod.brand.name || prod.brand)) || '', productType: category, tags: [], status: 'ACTIVE',
    options: variants.length > 1 ? [{ name: 'Variant', values: [...new Set(variants.map(v => v.options.Variant))] }] : [],
    variants, images: images.map(src => ({ src, alt: title })),
    collections: category ? [slug(category)] : [], _category: category, source: url,
  };
}

async function sitemapUrls(base, match, limit) {
  const seen = new Set(), out = [];
  const queue = [`${base}/sitemap.xml`];
  while (queue.length && out.length < limit * 3) {
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm);
    let xml; try { xml = await get(sm, false); } catch { continue; }
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => decode(m[1]));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs.sort((a, b) => /product/i.test(b) - /product/i.test(a)));
    else out.push(...locs.filter(u => match.test(u)));
  }
  return [...new Set(out)].slice(0, limit);
}

async function scrape(base, flag) {
  const limit = Number(flag.limit || 20);
  const match = new RegExp(flag.match || '/products?/|/p/|/item/', 'i');
  let urls;
  if (flag['product-urls']) urls = fs.readFileSync(path.resolve(P.root, flag['product-urls']), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, limit);
  else urls = await sitemapUrls(base, match, limit);
  if (!urls.length) throw new Error('No product URLs found. Pass --product-urls <file> or a --match pattern for product page URLs.');
  const products = [];
  for (const u of urls) {
    try {
      const p = fromPage(u, await get(u, false), flag);
      if (p) { products.push(p); console.log('scraped  ' + p.handle + (p._category ? '  [' + p._category + ']' : '')); }
      else console.warn('skipped  ' + u + ' (no product data found)');
    } catch (e) { console.warn('failed   ' + u + ': ' + e.message); }
    await sleep(Number(flag.delay || 400));
  }
  const cats = new Map();
  for (const p of products) if (p._category) cats.set(slug(p._category), p._category);
  const collections = [...cats].map(([handle, title]) => ({ handle, title }));
  products.forEach(p => delete p._category);
  return { collections, products };
}

main(async () => {
  const { flag: cli } = args();
  // Settings come from (highest first): command line → .env (SOURCE_URL, SOURCE_COLLECTIONS, SOURCE_PER_COLLECTION, SOURCE_LIMIT)
  // → pipeline/config.json "source": { "url", "collections", "perCollection", "limit", "mode" }
  const e = env(), src = config().source || {};
  const flag = { ...cli };
  flag.url = cli.url || e.SOURCE_URL || src.url;
  if (!flag.url) throw new Error('No source URL. Set "source.url" in pipeline/config.json, SOURCE_URL in .env, or pass --url');
  if (!flag.collections) flag.collections = e.SOURCE_COLLECTIONS || [].concat(src.collections || []).join(',') || undefined;
  if (!flag['per-collection']) flag['per-collection'] = e.SOURCE_PER_COLLECTION || src.perCollection;
  if (!flag.limit) flag.limit = e.SOURCE_LIMIT || src.limit;
  if (!flag.mode && src.mode) flag.mode = src.mode;
  // Accept any page URL: https://shop.com/collections/balloons → base https://shop.com + collection "balloons"
  const u = new URL(String(flag.url));
  const base = u.origin;
  const password = cli.password || e.SOURCE_PASSWORD || src.password;
  const useAdmin = flag.mode === 'admin' || (!flag.mode || flag.mode === 'auto') && (e.SOURCE_CLIENT_ID || e.SOURCE_ADMIN_TOKEN);
  if (password && !useAdmin) await unlock(base, password);
  const m = u.pathname.match(/\/collections\/([^/?#]+)/);
  if (m && !flag.collections && m[1] !== 'all') flag.collections = m[1];
  if (m && m[1] === 'all' && !flag.collections && !flag.limit) flag.limit = 20;
  console.log(`Source: ${base}` + (flag.collections ? `  collections: ${flag.collections}` : '') + (flag.limit ? `  limit: ${flag.limit}` : '') + (flag['per-collection'] ? `  per collection: ${flag['per-collection']}` : ''));
  if (flag['list-collections'] && useAdmin) {
    const api = sourceAdmin(e, src, base); const all = []; let after = null;
    do {
      const d = await api.gql(`query($after: String) { collections(first: 250, after: $after) { nodes { handle title productsCount { count } } pageInfo { hasNextPage endCursor } } }`, { after });
      all.push(...d.collections.nodes.map(c => ({ handle: c.handle, title: c.title, products_count: c.productsCount ? c.productsCount.count : null })));
      after = d.collections.pageInfo.hasNextPage ? d.collections.pageInfo.endCursor : null;
    } while (after);
    const filter = flag.search ? new RegExp(flag.search, 'i') : null;
    const shown = all.filter(c => (!filter || filter.test(c.handle + ' ' + c.title)) && (flag.empty || c.products_count !== 0));
    console.log(`Collections on source (Admin API): ${all.length} total, showing ${shown.length}:`);
    for (const c of shown) console.log(`  ${c.handle}  —  ${c.title}  —  ${c.products_count ?? '?'}`);
    return;
  }
  if (flag['list-collections']) {
    const all = [];
    for (let page = 1; page < 20; page++) {
      const d = await get(`${base}/collections.json?limit=250&page=${page}`, true);
      if (!d.collections || !d.collections.length) break;
      all.push(...d.collections);
      if (d.collections.length < 250) break;
    }
    const filter = flag.search ? new RegExp(flag.search, 'i') : null;
    const shown = all.filter(c => (!filter || filter.test(c.handle + ' ' + c.title)) && (flag.empty || c.products_count !== 0));
    console.log(`Collections on source: ${all.length} total, showing ${shown.length}${flag.empty ? '' : ' with products'} (handle — title — products):`);
    for (const c of shown) console.log(`  ${c.handle}  —  ${c.title}  —  ${c.products_count ?? '?'}`);
    return;
  }
  let mode = useAdmin ? 'admin' : (flag.mode || 'auto');
  if (mode === 'auto') {
    try { const d = await get(`${base}/products.json?limit=1`, true); mode = Array.isArray(d.products) ? 'shopify' : 'scrape'; }
    catch (err) { if (/password protected/.test(err.message)) throw err; mode = 'scrape'; }
    console.log('Source detected as: ' + (mode === 'shopify' ? 'Shopify store (public JSON feeds)' : 'non-Shopify site (page scraping)'));
  }
  const result = mode === 'admin' ? await adminSource(base, flag, e, src) : mode === 'shopify' ? await shopify(base, flag) : await scrape(base, flag);
  const outDir = path.resolve(P.root, flag.out || 'inputs/data');
  for (const [name, data] of [['collections.json', result.collections], ['products.json', result.products]]) {
    const f = path.join(outDir, name);
    if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');
    writeJSON(f, data);
  }
  const imgCount = result.products.reduce((a, p) => a + p.images.length, 0);
  console.log(`\nSaved ${result.collections.length} collections and ${result.products.length} products (${imgCount} images) to ${path.relative(P.root, outDir)}/`);
  console.log('Review the files, then run: node pipeline/data/collections.js && node pipeline/data/products.js');
  if (mode !== 'admin' && mode === 'shopify') console.log('Note: public feeds do not include metafields. Define them in inputs/data/metafields.json and fill values in products.json.');
});
