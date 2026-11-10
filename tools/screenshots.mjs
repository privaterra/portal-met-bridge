#!/usr/bin/env node
// Regenerates docs/screenshot-*.png for the README from the running app:
// real Chrome, the simulated Portal (tests/fake-bluetooth.js), the mock machine
// and its mock AI endpoint (tests/mock-meticulous.mjs), and a handful of seeded
// shots so every view has something to show. Nothing here touches a real
// machine or a real provider.
//
//   npm run screenshots            # writes docs/screenshot-*.png at 2× scale
//   node tools/screenshots.mjs --headed
//
// Needs playwright (npm i -D playwright) and socket.io for the mock, like the e2e.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const headed = process.argv.includes('--headed');

const APP_PORT = 8791;
const MOCK_PORT = 8792;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const app = spawn(process.execPath, [join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(APP_PORT) }, stdio: 'ignore' });
let mock = null; // started right before the machine connects, so its scripted shot (3 s after boot) is recorded from the start
await wait(800);

const launch = { headless: !headed, args: ['--no-sandbox'] };
if (existsSync('/usr/bin/google-chrome')) launch.executablePath = '/usr/bin/google-chrome';
else launch.channel = 'chrome';
const browser = await chromium.launch(launch);
// one context = one IndexedDB, so every page sees the seeded shots and the saved settings
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, acceptDownloads: true });
await context.addInitScript({ content: readFileSync(join(root, 'tests', 'fake-bluetooth.js'), 'utf8') });
await context.addInitScript({ content: readFileSync(join(root, 'tests', 'fake-folder.js'), 'utf8') });

async function newPage(width, height) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  return page;
}

const shot = (page, name, opts = {}) => page.screenshot({ path: join(docs, `screenshot-${name}.png`), ...opts }).then(() => console.log(`  wrote docs/screenshot-${name}.png`));

/** Seed a believable history: three coffees, a week of shots, one weighed cup, one reading, one shot without Portal data. */
async function seed(page) {
  await page.evaluate(async (v) => {
    const { makeDemoShot } = await import(`./js/demo.js?v=${v}`);
    const day = 86400000;
    const now = Date.now();
    const profile = (name, target, temp) => ({ name, temperature: temp, final_weight: target, variables: [{ name: 'Bloom Time', key: 'bloom_time', type: 'time', value: 20 }, { name: 'Extraction Flow', key: 'extraction_flow', type: 'flow', value: 2 }], stages: [{ name: 'Saturate', key: 'saturate', type: 'flow', dynamics: { over: 'time', points: [[0, 4]] }, exit_triggers: [{ type: 'pressure', value: 4 }, { type: 'time', value: 12 }], limits: [] }, { name: 'Bloom', key: 'bloom', type: 'flow', dynamics: { over: 'time', points: [[0, 0]] }, exit_triggers: [{ type: 'time', value: '$bloom_time' }], limits: [] }, { name: 'Extract', key: 'extract', type: 'flow', dynamics: { over: 'time', points: [[0, '$extraction_flow']] }, exit_triggers: [], limits: [{ type: 'pressure', value: 7 }] }] });
    const mk = (seed, ago, ctx, extra = {}) => {
      const s = makeDemoShot({ seed, doseG: ctx.doseG, targetG: extra.targetG || 40, durationSec: extra.durationSec || 30 });
      if (extra.ecScale) s.portal = s.portal.map((p) => ({ ...p, ec: Math.round(p.ec * extra.ecScale * 1000) / 1000 })); // a finer grind pulls a stronger cup
      delete extra.durationSec;
      delete extra.ecScale;
      delete s.manual;
      return { ...s, id: `seed-${seed}`, source: 'live', startedAt: now - ago, profileName: extra.profileName || 'Blooming Espresso', profileTemperatureC: 92, profileTargetG: extra.targetG || 40, machineShotId: `m-${seed}`, machineSource: { id: `m-${seed}`, profile: profile(extra.profileName || 'Blooming Espresso', extra.targetG || 40, 92) }, context: { roastLevel: 'light', process: 'natural', grinderName: 'Zerno Z1', ...ctx }, ...extra };
    };
    const put = (s) => window.__pb.store.putShot(s);
    await put(mk(11, 6 * day + 3600e3, { beanName: 'Supernova', roaster: 'Hatch', origin: 'Brazil, Cerrado', doseG: 18, grindSize: '430 µm' }, { targetG: 40, durationSec: 26, ecScale: 0.88 }));
    await put(mk(12, 5 * day + 1800e3, { beanName: 'Supernova', roaster: 'Hatch', origin: 'Brazil, Cerrado', doseG: 18, grindSize: '420 µm' }, { targetG: 40, beverageG: 41.3, refractometer: { tdsPct: 9.4, eyPct: 21.6, at: now - 5 * day } }));
    await put(mk(13, 4 * day, { beanName: 'Supernova', roaster: 'Hatch', origin: 'Brazil, Cerrado', doseG: 18.2, grindSize: '415 µm' }, { targetG: 40, durationSec: 34, ecScale: 1.1, refractometer: { tdsPct: 9.9, eyPct: 21.8, at: now - 4 * day } }));
    await put(mk(21, 3 * day + 7200e3, { beanName: 'Geishify Espresso Blend', roaster: 'Cafe Unido', origin: 'Panama', doseG: 18.3, grindSize: '80 µm', process: 'washed' }, { targetG: 43, durationSec: 37, ecScale: 0.93, profileName: 'Blooming Espresso Straight' }));
    await put(mk(22, 2 * day + 5400e3, { beanName: 'Geishify Espresso Blend', roaster: 'Cafe Unido', origin: 'Panama', doseG: 18.3, grindSize: '85 µm', process: 'washed' }, { targetG: 43, durationSec: 35, profileName: 'Blooming Espresso Straight', refractometer: { tdsPct: 8.7, eyPct: 20.4, at: now - 2 * day } }));
    const dry = mk(31, 1 * day + 9000e3, { beanName: 'Revolver SO Bali', roaster: 'Revolver', origin: 'Indonesia, Kintamani', doseG: 18, grindSize: '65 µm', roastLevel: 'medium', process: 'washed' }, { targetG: 40, durationSec: 27 });
    dry.portal = []; // the Portal was not connected for this one
    await put(dry);
    await put(mk(32, 0.5 * day, { beanName: 'Revolver SO Bali', roaster: 'Revolver', origin: 'Indonesia, Kintamani', doseG: 18, grindSize: '70 µm', roastLevel: 'medium', process: 'washed' }, { targetG: 40, durationSec: 31, ecScale: 1.04 }));
    await window.__pb.store.seedListsFromHistory();
  }, await page.evaluate(() => document.querySelector('script[src*="main.js"]').src.split('v=')[1]));
}

async function settle(page) {
  // settings: machine address, AI provider against the mock, reviewer context
  await page.click('.view-tab[data-view="settings"]');
  await page.fill('#meticulous-host', `localhost:${MOCK_PORT}`);
  await page.press('#meticulous-host', 'Enter');
  await page.selectOption('#set-ai-provider', 'anthropic');
  await page.waitForTimeout(150);
  await page.fill('#set-ai-key-anthropic', 'sk-ant-api03-demo-key-not-real-0000000000000000');
  await page.selectOption('#set-ai-drink', 'cortado');
  await page.fill('#set-ai-notes', 'Zerno Z1 with SSP HU blind burrs (5 µm steps); Toronto tap water through a BWT magnesium filter; 18 g VST basket.');
  await page.click('#savebar .btn.primary');
  await page.waitForTimeout(300);
  await page.click('.view-tab[data-view="shots"]');
}

async function connect(page) {
  mock = spawn(process.execPath, [join(root, 'tests', 'mock-meticulous.mjs')], { env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
  await wait(900);
  await page.click('#meticulous-connect');
  await page.waitForFunction(() => !document.getElementById('brew-controls').hidden, null, { timeout: 8000 });
  await page.click('#portal-connect');
  await page.waitForFunction(() => document.querySelector('#link-portal .dot')?.dataset.state === 'connected', null, { timeout: 8000 });
}

/**
 * "This coffee" for the shot the mock is about to pull. Values are set without
 * change events: the panel would otherwise (by design) write them into the
 * newest seeded shot; the recorder reads the fields when the shot is saved.
 */
async function describeCoffee(page) {
  await page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('ctx-bean', 'Supernova'); set('ctx-roaster', 'Hatch'); set('ctx-origin', 'Brazil, Cerrado');
    set('ctx-dose', '18'); set('ctx-grind', '420'); set('ctx-grinder', 'Zerno Z1');
    set('ctx-roast', 'light'); set('ctx-process', 'natural');
  });
}

try {
  console.log('Screenshots:');
  // ---- Shots view: machine + Portal connected, the mock's shot recorded and its record attached
  const page = await newPage(1280, 760);
  await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await seed(page);
  await page.reload({ waitUntil: 'networkidle' });
  await settle(page);
  await describeCoffee(page);
  await connect(page);
  await page.waitForFunction(() => window.__pb.recorder.isRecording, null, { timeout: 20000 });
  // the shot ends, is saved, and ~4 s later gets the machine's record attached
  await page.waitForFunction(() => window.__pb.state.shots.some((x) => !x.inProgress && Date.now() - x.startedAt < 300000 && x.machineShotId), null, { timeout: 90000 });
  // The simulated Portal (tests/fake-bluetooth.js) emits a flat, tiny EC trace; give the recorded shot the
  // demo's realistic Portal samples instead, so the pictures show what a real shot looks like.
  const liveId = await page.evaluate(async (v) => {
    const { makeDemoShot } = await import(`./js/demo.js?v=${v}`);
    const s = [...window.__pb.state.shots].filter((x) => !x.inProgress && Date.now() - x.startedAt < 300000).sort((a, b) => b.startedAt - a.startedAt)[0]; // the shot just recorded
    s.portal = makeDemoShot({ seed: 42 }).portal;
    s.lagSec = 0;
    delete s.analysisCache;
    await window.__pb.store.putShot(s);
    await window.__pb.refreshShotList();
    return s.id;
  }, await page.evaluate(() => document.querySelector('script[src*="main.js"]').src.split('v=')[1]));
  await page.click('.view-tab[data-view="history"]');
  await page.click(`#hist-rows tr[data-id="${liveId}"] button[data-act="open"]`);
  await page.waitForTimeout(4500); // let the "Saved shot" toast go
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await shot(page, 'shots');
  await shot(page, 'brew', { clip: { x: 0, y: 60, width: 300, height: 400 } });
  // the after-brew prompt for the final weight (Settings → Recording → Final weight: typed)
  await page.evaluate(() => { window.__pb.settings.beverageDefault = 'manual'; });
  await page.evaluate((id) => window.__pb.openWeightDialog(id), liveId);
  await page.waitForSelector('#weight-dialog[open]');
  await page.fill('#w-bev', '43');
  await page.waitForTimeout(200);
  const wbox = await page.evaluate(() => { const r = document.querySelector('#weight-dialog').getBoundingClientRect(); return { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.width + 24, height: r.height + 24 }; });
  await shot(page, 'final-weight', { clip: wbox });
  await page.click('#w-later');
  await page.evaluate(() => { window.__pb.settings.beverageDefault = 'profile'; });

  // ---- History: grind, ◎ / ⚖, ratio, data tags
  await page.setViewportSize({ width: 1440, height: 560 });
  await page.click('.view-tab[data-view="history"]');
  await page.waitForTimeout(400);
  await shot(page, 'history');

  // ---- Compare: the three Supernova shots overlaid
  await page.setViewportSize({ width: 1440, height: 860 });
  for (const id of ['seed-11', 'seed-12', 'seed-13']) await page.check(`#hist-rows tr[data-id="${id}"] input[type="checkbox"]`);
  await page.click('#hist-compare');
  await page.waitForTimeout(400);
  await page.selectOption('#cmp-series', 'ec-time'); // the demo's EC curves coincide in mass space; over time the three durations show
  await page.waitForTimeout(400);
  await page.evaluate(() => { const p = document.querySelector('#compare-panel'); window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 12); });
  await page.waitForTimeout(300);
  await shot(page, 'compare');
  await page.click('#cmp-close');

  // ---- Analysis: two Bali shots (one without Portal data) reviewed by the mock endpoint
  await page.setViewportSize({ width: 1440, height: 1360 });
  // the review comes from the mock's OpenAI-compatible endpoint (the same one the e2e uses), through the real request path
  await page.evaluate((port) => {
    window.__pb.settings.aiProvider = 'openai';
    window.__pb.settings.aiKeyOpenai = 'sk-test-123';
    window.__pb.settings.aiModelOpenai = '';
    window.__pb.settings.aiBaseOpenai = `http://127.0.0.1:${port}`;
  }, MOCK_PORT);
  await page.evaluate((id) => window.__pb.openAnalysis([id]), liveId);
  await page.waitForTimeout(500);
  await page.fill('#an-taste', 'Sweet and round as a cortado; a little drying at the end when drunk straight.');
  await page.fill('#an-question', 'Is 420 µm right for this bean, and should I touch the bloom or the grind next?');
  await page.click('#an-run');
  await page.waitForFunction(() => !window.__pb.an.running && window.__pb.an.markdown.length > 500, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'analysis');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.querySelector('#an-report-panel').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await shot(page, 'analysis-report');

  // ---- Machine view
  const narrow = await newPage(1180, 1100);
  await narrow.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await narrow.evaluate(() => { window.__pb.settings.aiProvider = 'anthropic'; }); // the settings page shows the default provider's block
  await narrow.click('#meticulous-connect');
  await narrow.waitForFunction(() => !document.getElementById('brew-controls').hidden, null, { timeout: 8000 });
  await narrow.click('.view-tab[data-view="machine"]');
  await narrow.waitForTimeout(2500);
  await shot(narrow, 'machine');

  // ---- Settings (full page) and the save bar mid-edit
  await narrow.click('.view-tab[data-view="settings"]');
  await narrow.waitForTimeout(300);
  await narrow.evaluate(() => { const r = document.querySelector('.ai-provider[data-provider="anthropic"]'); if (r) { r.hidden = false; } document.querySelectorAll('.ai-provider:not([data-provider="anthropic"])').forEach((el) => (el.hidden = true)); document.querySelector('#set-ai-provider').value = 'anthropic'; window.scrollTo(0, 0); });
  await shot(narrow, 'settings');
  await narrow.locator('#set-ai-panel').screenshot({ path: join(docs, 'screenshot-settings-ai.png') });
  console.log('  wrote docs/screenshot-settings-ai.png');
  await narrow.locator('#about-version').locator('xpath=ancestor::section[1]').screenshot({ path: join(docs, 'screenshot-about.png') });
  console.log('  wrote docs/screenshot-about.png');
  const bar = await newPage(1180, 420);
  await bar.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await bar.click('.view-tab[data-view="settings"]');
  await bar.click('#meticulous-host');
  await bar.keyboard.press('Control+A');
  await bar.keyboard.type('192.168.1.42');
  await bar.fill('#settle-sec', '7');
  await bar.waitForTimeout(300);
  await bar.evaluate(() => document.querySelector('#savebar').scrollIntoView({ block: 'center' }));
  await shot(bar, 'settings-savebar');

  // ---- Start over dialog
  await narrow.click('#reset-all');
  await narrow.waitForSelector('#reset-dialog[open]');
  await narrow.waitForTimeout(300);
  const box = await narrow.evaluate(() => { const r = document.querySelector('#reset-dialog').getBoundingClientRect(); return { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.width + 20, height: r.height + 20 }; });
  await shot(narrow, 'start-over', { clip: box });
  console.log('done');
} finally {
  await browser.close();
  app.kill();
  mock?.kill();
}
