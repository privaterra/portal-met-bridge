#!/usr/bin/env node
// bump-version.mjs — set the app version everywhere it appears, in one go:
//   node tools/bump-version.mjs 0.9.0
// Touches package.json, the About line and start-up log in js/main.js, the
// Beanconqueror envelope's app.version in js/beanconqueror.js, the ?v=
// cache-busting stamp on every app module import and on the <script>/<link>
// tags in index.html, and the Home Assistant app's config.yaml (its version is
// also the release tag its Dockerfile downloads). `npm test` fails if any of
// these disagree.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next || '')) {
  console.error('usage: node tools/bump-version.mjs <major.minor.patch>');
  process.exit(1);
}
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const prev = pkg.version;
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const edit = (rel, fn) => {
  const p = join(root, rel);
  const before = readFileSync(p, 'utf8');
  const after = fn(before);
  if (after !== before) {
    writeFileSync(p, after);
    console.log('updated', rel);
  }
};
const stamp = (s) => s.replace(/(\.(?:js|mjs|css)\?v=)\d+\.\d+\.\d+/g, `$1${next}`);
edit('index.html', stamp);
for (const f of readdirSync(join(root, 'js'))) if (f.endsWith('.js')) edit(`js/${f}`, stamp);
edit('js/main.js', (s) => s.replaceAll(`'v${prev}'`, `'v${next}'`).replaceAll(`portal-met-bridge v${prev} started`, `portal-met-bridge v${next} started`));
edit('js/beanconqueror.js', (s) => s.replace(/version: '\d+\.\d+\.\d+'/, `version: '${next}'`));
edit('homeassistant/portal_met_bridge/config.yaml', (s) => s.replace(/^version: "\d+\.\d+\.\d+"$/m, `version: "${next}"`));
console.log(`${prev} → ${next}`);
