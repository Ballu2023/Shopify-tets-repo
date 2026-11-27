#!/usr/bin/env node
// Make simple branded placeholder images for dummy collections/products (uses Playwright, already installed).
// Every image "src" in the dummy JSON files that points to a missing local file under inputs/assets/ is created.
// Usage: node pipeline/data/placeholder.js [--collections inputs/data/dummy-collections.json] [--products inputs/data/dummy-products.json]
const fs = require('fs');
const path = require('path');
const { P, readJSON } = require('../lib');
const { args, main } = require('./shopify');

let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright missing: npm install && npm run shots:install'); process.exit(2); }

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

main(async () => {
  const { flag } = args();
  const sg = readJSON(P.styleGuide, {});
  const c = sg.colors || {};
  const palette = [c.surface || '#EAF6FC', c.surfacePink || '#FDECE7', c.surfaceGrey || '#F4F4F4'];
  const accents = [c.primary || '#E2492B', c.secondary || '#00286C', c.accent || '#F7A9B8'];
  const font = (sg.fonts && sg.fonts.heading && sg.fonts.heading.family) || 'Poppins';
  const jobs = [];
  for (const [file, kind] of [[flag.collections || 'inputs/data/dummy-collections.json', 'collection'], [flag.products || 'inputs/data/dummy-products.json', 'product']]) {
    const list = readJSON(path.resolve(P.root, file), []);
    for (const item of list) {
      const imgs = kind === 'collection' ? (item.image ? [item.image] : []) : (item.images || []);
      for (const img of imgs) if (img.src && !/^https?:/i.test(img.src) && !fs.existsSync(path.resolve(P.root, img.src))) jobs.push({ src: img.src, title: item.title, kind });
    }
  }
  if (!jobs.length) { console.log('All placeholder images already exist.'); return; }
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
  let i = 0;
  for (const j of jobs) {
    const bg = palette[i % palette.length], ac = accents[i % accents.length], ac2 = accents[(i + 1) % accents.length];
    i++;
    const html = `<html><head><link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@600;700&display=swap" rel="stylesheet">
      <style>body{margin:0;width:800px;height:800px;background:${bg};font-family:'${font}',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;position:relative}
      .b{position:absolute;border-radius:50%;opacity:.9}.t{position:relative;z-index:2;text-align:center;padding:0 60px;color:${c.heading || '#00286C'};font-size:44px;font-weight:700;line-height:1.15;text-transform:uppercase}
      .k{position:relative;z-index:2;margin-top:18px;font-size:20px;font-weight:600;color:${ac};letter-spacing:2px;text-transform:uppercase}</style></head>
      <body><div class="b" style="width:260px;height:300px;background:${ac};left:70px;top:60px"></div>
      <div class="b" style="width:200px;height:230px;background:${ac2};right:90px;top:120px"></div>
      <div class="b" style="width:160px;height:180px;background:${ac};right:220px;bottom:70px;opacity:.6"></div>
      <div class="t">${esc(j.title)}</div><div class="k">${j.kind === 'collection' ? 'Collection' : 'Sample product'}</div></body></html>`;
    await page.setContent(html, { waitUntil: 'networkidle' }).catch(() => page.setContent(html));
    const out = path.resolve(P.root, j.src);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    console.log('made ' + j.src);
  }
  await browser.close();
  console.log(`Placeholder images: ${jobs.length} created.`);
});
