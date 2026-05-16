#!/usr/bin/env node
// Render per-locale Open Graph PNGs from qm-og-template.html.
//
// Usage: node _build/build-og.mjs
// Requires: playwright (or chromium) available locally.
//
// Reads:  _build/qm-locales.json + _build/qm-og-template.html + _build/fonts/*
// Writes: quantum-match/og-<lang>.png (1200×630) + quantum-match/og.png (en mirror)

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BUILD_DIR = path.join(ROOT, '_build');

const locales = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'qm-locales.json'), 'utf8'));
const template = fs.readFileSync(path.join(BUILD_DIR, 'qm-og-template.html'), 'utf8');

function interpolate(tpl, data) {
  let out = tpl;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') {
      out = out.replaceAll(`{{${k}}}`, v);
    }
  }
  return out;
}

// Tiny static server so the page can fetch local font files via http://, which
// the Chromium font loader cooperates with more reliably than file:// URLs.
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const fp = path.join(BUILD_DIR, urlPath);
  if (!fp.startsWith(BUILD_DIR)) { res.statusCode = 403; return res.end(); }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.statusCode = 404; return res.end();
  }
  const ext = path.extname(fp).toLowerCase();
  const type = {
    '.html': 'text/html; charset=utf-8',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.json': 'application/json',
    '.png': 'image/png',
  }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(fp).pipe(res);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`local font server on http://127.0.0.1:${port}`);

const browser = await chromium.launch();
try {
  for (const [lang, loc] of Object.entries(locales)) {
    const share = loc.share || {};
    const html = interpolate(template, {
      lang: loc.lang,
      htmlLang: loc.htmlLang || loc.lang,
      dir: loc.dir || 'ltr',
      name: loc.name || 'Quantum Match',
      headline: share.msg || share.ogTitle || '',
    });
    const tmpPath = path.join(BUILD_DIR, `_og-${lang}.html`);
    fs.writeFileSync(tmpPath, html);

    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/_og-${lang}.html`, { waitUntil: 'networkidle' });
    // Be conservative: wait for web fonts to be ready before snapshotting.
    await page.evaluate(() => document.fonts.ready);
    const outPath = path.join(ROOT, 'quantum-match', `og-${lang}.png`);
    await page.screenshot({ path: outPath, fullPage: false, omitBackground: false });
    await ctx.close();
    fs.unlinkSync(tmpPath);
    console.log(`  rendered og-${lang}.png`);
  }
} finally {
  await browser.close();
  server.close();
}

// og.png mirrors og-en.png for the root /s/ redirect's fallback.
fs.copyFileSync(
  path.join(ROOT, 'quantum-match', 'og-en.png'),
  path.join(ROOT, 'quantum-match', 'og.png'),
);
console.log('  og.png ← og-en.png');
console.log('\n✓ OG render complete');
