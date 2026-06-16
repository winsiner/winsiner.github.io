#!/usr/bin/env node
// Build per-locale static pages for Quantum Match + OneColor.
//
// Usage: node _build/build.mjs
//
// Reads:   _build/{qm,oc}-locales.json + _build/{qm,oc}-{landing,share,redirect}-template.html
// Writes:  quantum-match/<lang>/index.html + s/index.html, quantum-match/index.html, etc.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const GAMES = [
  {
    slug: 'quantum-match',
    localesPath: '_build/qm-locales.json',
    landingTpl: '_build/qm-landing-template.html',
    shareTpl: '_build/qm-share-template.html',
    redirectTpl: '_build/qm-redirect-template.html',
  },
  {
    slug: 'onecolor',
    localesPath: '_build/oc-locales.json',
    landingTpl: '_build/oc-landing-template.html',
    shareTpl: '_build/oc-share-template.html',
    redirectTpl: '_build/oc-redirect-template.html',
  },
];

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function writeFile(rel, content) {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  console.log('  wrote', rel);
}

function interpolate(template, data, prefix = '') {
  let out = template;
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out = interpolate(out, v, prefix + k + '.');
    } else if (typeof v === 'string') {
      const re = new RegExp('\\{\\{' + escapeRegExp(prefix + k) + '\\}\\}', 'g');
      out = out.replace(re, v);
    }
  }
  return out;
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// Quantum Match: emoji + title + body cards
function buildFeaturesHTMLQM(features) {
  return features.map(f => `      <div class="feat">
        <span class="emoji">${f.emoji}</span>
        <h3>${escapeHtml(f.title)}</h3>
        <p>${escapeHtml(f.body)}</p>
      </div>`).join('\n');
}

// OneColor: <li> with bold title + muted span body
function buildFeaturesHTMLOC(features) {
  return features.map(f => `      <li><b>${escapeHtml(f.title)}</b> <span>${escapeHtml(f.body)}</span></li>`).join('\n');
}

// OneColor: modes cards
function buildModesHTMLOC(modes) {
  return modes.map(m => `      <div class="mode">
        <h3>${escapeHtml(m.title)}</h3>
        <p>${escapeHtml(m.body)}</p>
      </div>`).join('\n');
}

const LANG_LABEL = {
  'en': 'English', 'ko': '한국어', 'ja': '日本語', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文',
  'es': 'Español', 'pt-BR': 'Português (BR)', 'fr': 'Français', 'de': 'Deutsch',
  'it': 'Italiano', 'tr': 'Türkçe', 'id': 'Bahasa Indonesia',
};

// Quantum Match App Store listing. The storefront country code in the URL path
// drives the language Apple shows (e.g. /jp/ → Japanese, no code → US/English),
// so each locale links to the storefront whose primary language matches the page.
const QM_APPSTORE_ID = '6771239973';
const QM_APPSTORE_CC = {
  // zh-Hans points to the Taiwan (tw) store: the app isn't on the mainland
  // China (cn) storefront, and Traditional Chinese is far more readable to
  // Simplified readers than the English (US) listing would be.
  'en': 'us', 'ko': 'kr', 'ja': 'jp', 'zh-Hans': 'tw', 'zh-Hant': 'tw',
  'es': 'es', 'pt-BR': 'br', 'fr': 'fr', 'de': 'de', 'it': 'it', 'tr': 'tr', 'id': 'id',
};
function qmAppStoreUrl(lang) {
  const cc = QM_APPSTORE_CC[lang] || 'us';
  return `https://apps.apple.com/${cc}/app/id${QM_APPSTORE_ID}`;
}

function buildLangLinksHTML(slug, locales, currentLang) {
  return locales.map(l => {
    const cls = l.lang === currentLang ? 'active' : '';
    const label = LANG_LABEL[l.lang] || l.lang;
    return `      <a href="../${l.lang}/" class="${cls}" hreflang="${l.htmlLang}">${escapeHtml(label)}</a>`;
  }).join('\n');
}

function buildLangOptionsHTML(locales, currentLang) {
  return locales.map(l => {
    const sel = l.lang === currentLang ? ' selected' : '';
    const label = LANG_LABEL[l.lang] || l.lang;
    return `      <option value="${l.lang}"${sel}>${escapeHtml(label)}</option>`;
  }).join('\n');
}

function currentLangLabel(lang) {
  return LANG_LABEL[lang] || lang;
}

function buildHreflangBlock(slug, locales, currentLang, subPath = '') {
  // <link rel="alternate" hreflang="en" href="...">
  const lines = locales.map(l => {
    const href = `https://winsiner.github.io/${slug}/${l.lang}/${subPath}`;
    return `<link rel="alternate" hreflang="${l.htmlLang}" href="${href}">`;
  });
  // x-default → English
  lines.push(`<link rel="alternate" hreflang="x-default" href="https://winsiner.github.io/${slug}/en/${subPath}">`);
  return lines.join('\n');
}

function buildNoscriptLinks(slug, locales) {
  return locales.map(l => {
    const labelMap = {
      'en': 'English', 'ko': '한국어', 'ja': '日本語', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文',
      'es': 'Español', 'pt-BR': 'Português', 'fr': 'Français', 'de': 'Deutsch',
      'it': 'Italiano', 'tr': 'Türkçe', 'id': 'Bahasa Indonesia',
    };
    return `  <a href="./${l.lang}/">${escapeHtml(labelMap[l.lang] || l.lang)}</a>`;
  }).join('\n');
}

function buildGame(game) {
  console.log(`\nBuilding ${game.slug}…`);
  const locales = JSON.parse(readFile(game.localesPath));
  const localeList = Object.values(locales);
  const supported = localeList.map(l => l.lang);

  const landingTpl = readFile(game.landingTpl);
  const shareTpl = readFile(game.shareTpl);
  const redirectTpl = readFile(game.redirectTpl);

  for (const loc of localeList) {
    let featuresHTML = '';
    let modesHTML = '';
    if (loc.features) {
      featuresHTML = game.slug === 'onecolor'
        ? buildFeaturesHTMLOC(loc.features)
        : buildFeaturesHTMLQM(loc.features);
    }
    if (loc.modes) modesHTML = buildModesHTMLOC(loc.modes);

    const langLinksHTML = buildLangLinksHTML(game.slug, localeList, loc.lang);
    const langOptionsHTML = buildLangOptionsHTML(localeList, loc.lang);
    const hreflangLanding = buildHreflangBlock(game.slug, localeList, loc.lang, '');
    const hreflangShare = buildHreflangBlock(game.slug, localeList, loc.lang, 's/');

    const landingData = {
      ...loc,
      featuresHTML,
      modesHTML,
      langLinksHTML,
      langOptionsHTML,
      currentLangLabel: currentLangLabel(loc.lang),
      hreflangBlock: hreflangLanding,
    };
    const shareData = { ...loc, hreflangBlock: hreflangShare };
    if (game.slug === 'quantum-match') shareData.appStoreUrl = qmAppStoreUrl(loc.lang);

    const landingHtml = interpolate(landingTpl, landingData);
    const shareHtml = interpolate(shareTpl, shareData);

    writeFile(`${game.slug}/${loc.lang}/index.html`, landingHtml);
    writeFile(`${game.slug}/${loc.lang}/s/index.html`, shareHtml);
  }

  // Root redirect page
  const redirectData = {
    supportedJSON: JSON.stringify(supported),
    hreflangBlock: buildHreflangBlock(game.slug, localeList, 'en', ''),
    noscriptLinks: buildNoscriptLinks(game.slug, localeList),
  };
  writeFile(`${game.slug}/index.html`, interpolate(redirectTpl, redirectData));

  // Root /s/ redirect page — preserves ?score=N then goes to locale-matched /s/
  const sharedRootRedirect = `<!doctype html><html><head><meta charset="utf-8"><title>Quantum Match</title><meta name="robots" content="noindex"><script>
(function() {
  var SUPPORTED = ${JSON.stringify(supported)};
  function pick() {
    try {
      var langs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || ''];
      for (var i = 0; i < langs.length; i++) {
        var raw = (langs[i] || '').toLowerCase();
        if (!raw) continue;
        if (raw.indexOf('zh-tw') === 0 || raw.indexOf('zh-hk') === 0 || raw.indexOf('zh-mo') === 0 || raw.indexOf('zh-hant') === 0) {
          if (SUPPORTED.indexOf('zh-Hant') >= 0) return 'zh-Hant';
        }
        if (raw.indexOf('zh') === 0) {
          if (SUPPORTED.indexOf('zh-Hans') >= 0) return 'zh-Hans';
        }
        if (raw.indexOf('pt') === 0) {
          if (SUPPORTED.indexOf('pt-BR') >= 0) return 'pt-BR';
        }
        var base = raw.split('-')[0];
        if (SUPPORTED.indexOf(base) >= 0) return base;
        if (SUPPORTED.indexOf(raw) >= 0) return raw;
      }
    } catch(_) {}
    return 'en';
  }
  var target = pick();
  var qs = window.location.search || '';
  var hash = window.location.hash || '';
  window.location.replace('../' + target + '/s/' + qs + hash);
})();
</script></head><body></body></html>`;
  writeFile(`${game.slug}/s/index.html`, sharedRootRedirect);
}

for (const g of GAMES) buildGame(g);
console.log('\n✓ build complete');
