#!/usr/bin/env node
// Consistency check for the KST2You UI string tables. See doc/I18N.md.
//
//   node scripts/check_i18n.js
//
// Exits 1 if any error is found. Checks that:
//   - every key used in docs/index.html (data-i18n*) and docs/assets/js
//     (I18n.t / I18n.h / _th([...]), and t() inside i18n.js) exists in en.js;
//   - en.js has no unused keys;
//   - every other table has exactly the en.js keys, with the same {placeholders}
//     and the same HTML tags/ids in each value;
//   - every table is loaded by index.html before i18n.js and named in i18n.js.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'docs');
const I18N_DIR = path.join(ROOT, 'assets', 'i18n');
const JS_DIR = path.join(ROOT, 'assets', 'js');
const HTML = path.join(ROOT, 'index.html');

const errors = [];
const warnings = [];

// ── Load tables ──────────────────────────────────────
global.window = {};
const langFiles = fs.readdirSync(I18N_DIR).filter(f => f.endsWith('.js')).sort();
for (const f of langFiles) {
  try {
    new Function(fs.readFileSync(path.join(I18N_DIR, f), 'utf8'))();
  } catch (e) {
    errors.push(`${f}: does not parse: ${e.message}`);
  }
}
const tables = window.KST_I18N || {};
const en = tables.en;
if (!en) {
  console.error('ERROR: en.js missing or did not register window.KST_I18N.en');
  process.exit(1);
}
for (const f of langFiles) {
  const code = f.replace(/\.js$/, '');
  if (!tables[code]) errors.push(`${f}: must register window.KST_I18N.${code}`);
}

// ── Collect keys used by the app ─────────────────────
const used = new Map(); // key -> first file it was seen in
function use(key, where) { if (!used.has(key)) used.set(key, where); }

const html = fs.readFileSync(HTML, 'utf8');
for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) use(m[1], 'index.html');

const jsFiles = fs.readdirSync(JS_DIR, { recursive: true })
  .filter(f => f.endsWith('.js') && !/jquery/.test(f));
for (const rel of jsFiles) {
  const lines = fs.readFileSync(path.join(JS_DIR, rel), 'utf8').split(/\r?\n/);
  // Ignore whole-line comments so usage examples in comments don't count.
  const code = lines.map(l => (/^\s*(\/\/|\*)/.test(l) ? '' : l));
  const src = code.join('\n');
  for (const m of src.matchAll(/I18n\.[th]\(\s*'([^']+)'/g)) use(m[1], rel);
  // i18n.js calls its internal t() directly.
  if (path.basename(rel) === 'i18n.js') {
    for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) use(m[1], rel);
  }
  for (const m of src.matchAll(/_th\(\[([^\]]*)\]/g)) {
    for (const k of m[1].matchAll(/'([^']+)'/g)) use(k[1], rel);
  }
  // Keys built at runtime can't be checked, so keep them literal. A deliberate
  // exception (like a helper that takes a list of keys) is marked "i18n-dynamic".
  code.forEach((line, i) => {
    if (/I18n\.[th]\(\s*[^'\s)]/.test(line) && !line.includes('i18n-dynamic')) {
      warnings.push(`${rel}:${i + 1}: non-literal key, cannot be checked: ${line.trim()}`);
    }
  });
}

for (const [key, where] of used) {
  if (!(key in en)) errors.push(`${where}: key "${key}" is not defined in en.js`);
}
for (const key of Object.keys(en)) {
  if (!used.has(key)) errors.push(`en.js: key "${key}" is never used`);
}

// ── Compare translations with English ────────────────
const placeholders = s => (s.match(/\{\w+\}/g) || []).sort().join(' ');
const tags = s => (s.match(/<\/?[a-z][^>]*>/gi) || []).map(t => t.replace(/\s.*$/, '>')).join('');
const ids = s => (s.match(/\sid="[^"]+"/g) || []).join(' ');

for (const [code, table] of Object.entries(tables)) {
  if (code === 'en') continue;
  for (const key of Object.keys(en)) {
    if (!(key in table)) { errors.push(`${code}.js: missing key "${key}"`); continue; }
    const a = en[key], b = table[key];
    if (placeholders(a) !== placeholders(b)) {
      errors.push(`${code}.js: "${key}" placeholders differ from en (${placeholders(a) || 'none'} vs ${placeholders(b) || 'none'})`);
    }
    if (tags(a) !== tags(b)) errors.push(`${code}.js: "${key}" HTML tags differ from en`);
    if (ids(a) !== ids(b)) errors.push(`${code}.js: "${key}" element ids differ from en`);
  }
  for (const key of Object.keys(table)) {
    if (!(key in en)) errors.push(`${code}.js: extra key "${key}" not in en.js`);
  }
}

// ── Wiring: script tags and language names ───────────
const runtimeTag = html.indexOf('assets/js/i18n.js');
if (runtimeTag < 0) errors.push('index.html: does not load assets/js/i18n.js');
for (const f of langFiles) {
  const at = html.indexOf(`assets/i18n/${f}`);
  if (at < 0) errors.push(`index.html: does not load assets/i18n/${f}`);
  else if (runtimeTag >= 0 && at > runtimeTag) errors.push(`index.html: assets/i18n/${f} must load before assets/js/i18n.js`);
}
const runtime = fs.readFileSync(path.join(JS_DIR, 'i18n.js'), 'utf8');
const names = runtime.match(/var NAMES = \{([^}]*)\}/);
for (const code of Object.keys(tables)) {
  if (!names || !new RegExp(`\\b${code}:`).test(names[1])) {
    errors.push(`i18n.js: NAMES has no entry for "${code}"`);
  }
}

// ── Report ───────────────────────────────────────────
for (const w of warnings) console.log('WARNING: ' + w);
for (const e of errors) console.log('ERROR: ' + e);
console.log(`${Object.keys(en).length} keys, ${used.size} used, languages: ${Object.keys(tables).join(', ')}; ` +
            `${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
