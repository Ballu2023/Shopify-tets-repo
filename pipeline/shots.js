#!/usr/bin/env node
// Screenshot a preview page at the four review widths (375 / 768 / 1024 / 1440) for UAT/QA.
// Needs: npm install (installs playwright) and: npx playwright install chromium
// Usage: node pipeline/shots.js --path /pages/about-us --name about [--widths 375,1440] [--full false]
const fs = require('fs');
const path = require('path');
const { P, config } = require('./lib');

let chromium;
try { ({ chromium } = require('playwright')); } catch {
  console.error('Playwright not installed. Run: npm install && npx playwright install chromium'); process.exit(2);
}
const a = process.argv.slice(2), flag = {};
for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) flag[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;

const cfg = config();
if (!cfg.themeId || !cfg.store) { console.error('ERROR: set store and themeId in pipeline/config.json'); process.exit(1); }

// The review widths are a QA policy (CLAUDE.md rule 7), not CSS breakpoints, so they live here.
const WIDTHS = { mobile: 375, tablet: 768, laptop: 1024, desktop: 1440 };
const widths = flag.widths
  ? String(flag.widths).split(',').map(w => parseInt(w, 10)).filter(Boolean).map(w => [String(w), w])
  : Object.entries(WIDTHS);

// Git Bash on Windows turns "/pages/x" into "C:/Program Files/Git/pages/x"; undo that, and allow "pages/x" without slash.
let pagePath = String(flag.path || '/').replace(/\\/g, '/');
const mangled = pagePath.match(/^[A-Za-z]:\/.*?\/Git(\/.*)$/i);
if (mangled) pagePath = mangled[1];
if (!pagePath.startsWith('/')) pagePath = '/' + pagePath;
const name = flag.name || (pagePath.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home');
fs.mkdirSync(P.shots, { recursive: true });

const withPreview = (origin) => `${origin}${pagePath}${pagePath.includes('?') ? '&' : '?'}preview_theme_id=${cfg.themeId}`;

(async () => {
  const browser = await chromium.launch();
  // ONE context for every width, so the storefront-password cookie is reused instead of logging in again each time.
  const context = await browser.newContext();
  const out = [];

  // Log in once. The shop's primary domain may differ from <store>.myshopify.com (it redirects), and the password
  // cookie is set on whichever origin actually served the form — so after logging in we keep using THAT origin.
  let origin = `https://${cfg.store}`;
  {
    const page = await context.newPage();
    await page.goto(withPreview(origin), { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (page.url().includes('/password')) {
      if (!cfg.storePassword) throw new Error('Store is password protected: set storePassword in pipeline/config.json');
      // Horizon hides the password field inside a dialog, so set the value and submit the form directly.
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
        page.evaluate(pw => {
          const input = document.querySelector('input[type=password][name=password], input[name=password]');
          if (!input) throw new Error('password input not found on ' + location.href);
          input.value = pw;
          const form = input.closest('form');
          form.requestSubmit ? form.requestSubmit() : form.submit();
        }, cfg.storePassword),
      ]);
      // Carry on from the origin we landed on, not the one we asked for.
      origin = new URL(page.url()).origin;
      await page.goto(withPreview(origin), { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (page.url().includes('/password')) {
        throw new Error(`Store password login failed at ${page.url()} — check storePassword in pipeline/config.json`);
      }
    }
    await page.close();
  }

  for (const [label, width] of widths) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(withPreview(origin), { waitUntil: 'networkidle', timeout: 60000 });
    if (page.url().includes('/password')) throw new Error(`Hit the password page again at ${width}px (${page.url()})`);
    // Hide the Shopify preview bar so it does not show up as a layout bug or cover the footer.
    await page.addStyleTag({ content: '#preview-bar-iframe,#PBarNextFrameWrapper{display:none!important}' });
    // Let lazy images and any scroll-triggered sections settle before capturing a full-page shot.
    await page.evaluate(async () => {
      await new Promise(r => {
        let y = 0;
        const step = () => {
          y += window.innerHeight;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight) setTimeout(step, 100); else { window.scrollTo(0, 0); setTimeout(r, 300); }
        };
        step();
      });
    });
    await page.waitForTimeout(800);
    const file = path.join(P.shots, `${name}-${label}-${width}.png`);
    await page.screenshot({ path: file, fullPage: flag.full !== 'false' });
    out.push({ label, width, file: path.relative(P.root, file).replace(/\\/g, '/') });
    await page.close();
  }
  await context.close();
  await browser.close();
  console.log(JSON.stringify({ origin, shots: out }, null, 2));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
