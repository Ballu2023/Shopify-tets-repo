#!/usr/bin/env node
// Cuts tall Figma exports into readable parts so the Design reader can read every word.
// inputs/figma/01-home.png → inputs/figma/slices/01-home/part-01.png, part-02.png …
// Usage: node pipeline/slice.js            (all screenshots)
//        node pipeline/slice.js 01-home.png (one file)
// Needs Playwright (npm install + npm run shots:install), already used for screenshots.
const fs = require('fs');
const path = require('path');
const { P } = require('./lib');

let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Playwright missing: npm install && npm run shots:install'); process.exit(2); }

const TARGET_W = 1440;   // parts are scaled to this width
const PART_H = 1400;     // height of each part at that width
const OVERLAP = 80;      // small overlap so no section is cut in half unseen

function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 1, 4) === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  // JPEG: scan for SOF marker
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('Unknown image size: ' + file);
}

(async () => {
  const only = process.argv[2];
  const files = fs.readdirSync(P.figma).filter(f => /\.(png|jpe?g)$/i.test(f) && (!only || f === only));
  if (!files.length) { console.error('No screenshots in inputs/figma'); process.exit(1); }
  const browser = await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
  for (const f of files) {
    const src = path.join(P.figma, f);
    const { w, h } = pngSize(src);
    const scale = TARGET_W / w;
    const fullH = Math.round(h * scale);
    const outDir = path.join(P.figma, 'slices', path.basename(f, path.extname(f)));
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: TARGET_W, height: PART_H } });
    const data = 'data:image/' + (/\.png$/i.test(f) ? 'png' : 'jpeg') + ';base64,' + fs.readFileSync(src).toString('base64');
    await page.setContent(`<html><body style="margin:0"><img id="i" src="${data}" style="display:block;width:${TARGET_W}px;height:${fullH}px"></body></html>`);
    await page.waitForFunction(() => document.getElementById('i').complete);
    let n = 0;
    for (let y = 0; y < fullH; y += PART_H - OVERLAP) {
      const hh = Math.min(PART_H, fullH - y);
      if (hh < 120 && n) break;
      n++;
      await page.screenshot({ path: path.join(outDir, `part-${String(n).padStart(2, '0')}.png`), clip: { x: 0, y, width: TARGET_W, height: hh }, fullPage: true });
    }
    await page.close();
    console.log(`${f}: ${w}x${h} → ${n} parts in inputs/figma/slices/${path.basename(outDir)}/`);
  }
  await browser.close();
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
