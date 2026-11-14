#!/usr/bin/env node
// End-to-end check of the Portal path in a real Chrome, with a simulated Portal
// (tests/fake-bluetooth.js) and a mock Meticulous (tests/mock-meticulous.mjs).
//
//   npm i -D playwright socket.io      # once; Chrome/Chromium must be installed
//   node tests/e2e-portal.mjs [--headed] [--chrome /path/to/chrome]
//
// What it proves: requestDevice is called with the 0x7400 service filter, the
// driver walks GATT → service → characteristics → notifications, 13-byte
// packets update the readouts and the connection check, a live shot from the
// mock machine is recorded with Portal samples, the analysis reaches status
// "ok" with high coverage, the show/hide-graph bytes are written, and the
// JPEG / PDF / zip exports produce files. It does not prove a physical Portal
// behaves the same — that is issue #1.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, statSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const chromeArg = args.indexOf('--chrome') >= 0 ? args[args.indexOf('--chrome') + 1] : null;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  // Fall back to a globally installed playwright (NODE_PATH or npm -g).
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const candidates = [...(process.env.NODE_PATH || '').split(':').filter(Boolean).map((p) => join(p, 'playwright')), 'playwright'];
    let found = null;
    for (const c of candidates) {
      try {
        found = req.resolve(c);
        break;
      } catch {
        /* next */
      }
    }
    if (!found) throw new Error('not found');
    const mod = await import(found);
    chromium = mod.chromium || mod.default?.chromium;
  } catch {
    console.error('playwright is not installed: npm i -D playwright socket.io');
    process.exit(2);
  }
}

const APP_PORT = 8797;
const MOCK_PORT = 8098;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'pmb-e2e-data-')); // the server's data folder (Settings → Files and folders → server)
const server = spawn('node', [join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(APP_PORT), DATA_DIR }, stdio: 'ignore' });
const onDisk = (dir = DATA_DIR, pre = '') => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? onDisk(join(dir, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`])) : []);
const mock = spawn('node', [join(here, 'mock-meticulous.mjs')], { env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
process.env.PMB_E2E_DATA = DATA_DIR;
await new Promise((r) => setTimeout(r, 1200));

let failures = 0;
const check = (name, ok, detail = '') => {
  failures += ok ? 0 : 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

try {
  const launch = { headless: !headed, args: ['--no-sandbox'] };
  if (chromeArg) launch.executablePath = chromeArg;
  else if (existsSync('/usr/bin/google-chrome')) launch.executablePath = '/usr/bin/google-chrome';
  else launch.channel = 'chrome';
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript({ content: readFileSync(join(here, 'fake-bluetooth.js'), 'utf8') });
  await context.addInitScript({ content: readFileSync(join(here, 'fake-folder.js'), 'utf8') });
  const page = await context.newPage();
  const keep = process.env.E2E_OUT; // set to a folder to keep the exported files
  const dl = async (sel) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(sel)]);
    const p = await d.path();
    if (keep) await d.saveAs(join(keep, d.suggestedFilename()));
    return { name: d.suggestedFilename(), bytes: statSync(p).size, path: p };
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`http://localhost:${APP_PORT}/`, { waitUntil: 'networkidle' });
  check('page loads with default host 127.0.0.1', (await page.inputValue('#meticulous-host')) === '127.0.0.1');

  // Coffee context + machine
  await page.fill('#ctx-bean', 'E2E coffee');
  await page.dispatchEvent('#ctx-bean', 'change');
  await page.fill('#ctx-roaster', 'E2E roaster');
  await page.dispatchEvent('#ctx-roaster', 'change');
  await page.selectOption('#ctx-roast', 'light');
  await page.fill('#ctx-origin', 'Colombia, Huila');
  await page.dispatchEvent('#ctx-origin', 'change');
  await page.fill('#ctx-grinder', 'Zerno Z1');
  await page.dispatchEvent('#ctx-grinder', 'change');
  await page.fill('#ctx-grind', '420');
  await page.dispatchEvent('#ctx-grind', 'change');
  await page.fill('#ctx-dose', '18');
  await page.dispatchEvent('#ctx-dose', 'change');
  await page.waitForTimeout(300);
  const lists = await page.evaluate(() => Object.fromEntries(['bean', 'roaster', 'origin', 'grinder'].map((k) => [k, [...document.querySelectorAll(`#${k}-list option`)].map((o) => o.value)])));
  check('bean, roaster, origin and grinder pick-lists remember new entries', lists.bean.includes('E2E coffee') && lists.roaster.includes('E2E roaster') && lists.origin.includes('Colombia, Huila') && lists.grinder.includes('Zerno Z1'), JSON.stringify(lists));
  // Picking a previous bean fills roaster / origin
  await page.fill('#ctx-roaster', '');
  await page.fill('#ctx-origin', '');
  await page.fill('#ctx-bean', 'E2E coffee');
  await page.dispatchEvent('#ctx-bean', 'change');
  await page.waitForTimeout(300);
  check('picking a previous bean fills in its roaster and origin', (await page.inputValue('#ctx-roaster')) === 'E2E roaster' && (await page.inputValue('#ctx-origin')) === 'Colombia, Huila');
  // Settings sections fold (v0.20) and open compact by default. This run works in open sections; the choice is made
  // here without the save-bar flash or any waiting, because the mock machine starts its scripted shot three seconds
  // after it boots and every second spent before connecting is Portal coverage lost. The folding is checked further down.
  const layoutDefault = await page.evaluate(async () => {
    const was = window.__pb.settings.settingsLayout;
    window.__pb.settings.settingsLayout = 'detailed';
    await window.__pb.store.setSetting('settingsLayout', 'detailed');
    document.querySelector('#set-layout').value = 'detailed';
    return was;
  });
  check('Settings opens compact by default', layoutDefault === 'compact', layoutDefault);
  await page.click('.view-tab[data-view="settings"]');
  // Machine address lives under Settings; typing + Enter saves it and the rail follows.
  await page.click('#meticulous-host');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('10.9.8.7');
  check('save bar shows the pending change while typing', /Unsaved: machine address/.test(await page.textContent('#savebar-status')), (await page.textContent('#savebar-status')).trim());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter saves the address and the rail shows it', (await page.textContent('#meticulous-addr')) === '10.9.8.7' && /Saved 1 setting/.test(await page.textContent('#savebar-status')), `${await page.textContent('#meticulous-addr')} | ${(await page.textContent('#savebar-status')).trim()}`);
  await page.click('#meticulous-host');
  await page.keyboard.press('Control+A');
  await page.keyboard.type(`localhost:${MOCK_PORT}`);
  await page.fill('#settle-sec', '7');
  await page.click('#settings-save');
  await page.waitForTimeout(300);
  check('Save settings commits every edited field', (await page.textContent('#meticulous-addr')) === `localhost:${MOCK_PORT}` && (await page.evaluate(() => window.__pb.settings.settleSec)) === 7 && /Saved 2 settings/.test(await page.textContent('#savebar-status')), (await page.textContent('#savebar-status')).trim());
  // Rating settings (v0.18): on, 1–5, rated manually afterwards — switched to "when the shot completes" for the dialog test below
  const ratingDefaults = await page.evaluate(() => ({ on: document.querySelector('#set-ratings').checked, scale: document.querySelector('#set-rating-scale').value, when: document.querySelector('#set-rating-when').value, via: document.querySelector('#set-shot-files-via').value, exportsVia: document.querySelector('#set-exports-via').value, rail: !!document.querySelector('.rail #demo-load'), demoInSettings: !!document.querySelector('#view-settings #demo-load'), nav: !!document.querySelector('#view-shots .panel-tools #shot-prev') }));
  check('defaults: ratings on, 1–5 scale, rated manually; per-shot files and exports download; the rail has no Shots block, demo buttons live in Settings and ◀ ▶ by the shot title', ratingDefaults.on && ratingDefaults.scale === '5' && ratingDefaults.when === 'manual' && ratingDefaults.via === 'browser' && ratingDefaults.exportsVia === 'browser' && !ratingDefaults.rail && ratingDefaults.demoInSettings && ratingDefaults.nav, JSON.stringify(ratingDefaults));
  await page.selectOption('#set-rating-when', 'after');
  await page.waitForTimeout(200);
  await page.click('#meticulous-host');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('typo.local');
  check('Discard is enabled while a change is pending', !(await page.isDisabled('#settings-discard')));
  await page.click('#settings-discard');
  check('Discard changes restores the saved address', (await page.inputValue('#meticulous-host')) === `localhost:${MOCK_PORT}` && (await page.textContent('#meticulous-addr')) === `localhost:${MOCK_PORT}` && (await page.isDisabled('#settings-discard')));
  await page.fill('#settle-sec', '6');
  await page.dispatchEvent('#settle-sec', 'change');
  check('blur alone does not commit a typed field', (await page.evaluate(() => window.__pb.settings.settleSec)) === 7 && /Unsaved: settle window/.test(await page.textContent('#savebar-status')), (await page.textContent('#savebar-status')).trim());
  await page.keyboard.press('Control+S');
  await page.waitForTimeout(200);
  check('⌘/Ctrl+S saves pending fields', (await page.evaluate(() => window.__pb.settings.settleSec)) === 6, String(await page.evaluate(() => window.__pb.settings.settleSec)));
  await page.fill('#lag-sec', '2.5');
  await page.click('.view-tab[data-view="shots"]');
  await page.waitForTimeout(200);
  check('leaving Settings auto-saves pending fields', (await page.evaluate(() => window.__pb.settings.lagSec)) === 2.5, String(await page.evaluate(() => window.__pb.settings.lagSec)));
  await page.click('.view-tab[data-view="settings"]');
  await page.click('#meticulous-test');
  await page.waitForFunction(() => /OK in|No answer/.test(document.querySelector('#meticulous-test-result').textContent), null, { timeout: 10000 });
  check('Settings → Test connection reaches the machine', /OK in \d+ ms/.test(await page.textContent('#meticulous-test-result')), (await page.textContent('#meticulous-test-result')).trim());
  // Turn the debug log on and point it at a (fake) folder
  await page.check('#log-enabled');
  await page.dispatchEvent('#log-enabled', 'change');
  const beforePick = await page.evaluate(() => ({ eff: window.__pb.files.effective, server: window.__pb.files.server?.dataDir, status: document.querySelector('#files-status').textContent }));
  check('the server advertises its data folder and "whatever is available" picks it while no folder is chosen', beforePick.eff === 'server' && beforePick.server === process.env.PMB_E2E_DATA && /Files are written to/.test(beforePick.status), JSON.stringify(beforePick));
  await page.click('#files-pick-folder');
  await page.waitForTimeout(300);
  check('a folder picked in Chrome is writable and wins over the server\'s data folder', /writable/.test(await page.textContent('#files-folder')) && (await page.evaluate(() => window.__pb.files.effective)) === 'folder', (await page.textContent('#files-folder')).trim());
  const layoutRows = await page.evaluate(() => [...document.querySelectorAll('#files-layout tr')].map((r) => r.children[1].textContent));
  check('the layout table shows one subfolder per kind under the chosen folder', layoutRows.length === 6 && layoutRows.every((t) => /^FakeFolder\/portal-met-bridge\/(shots|exports|reports|reviews|backups|logs)\/$/.test(t)), layoutRows.join(' | '));
  // Pick-list management: a second roaster, then remove it via its chip
  await page.click('.view-tab[data-view="shots"]');
  await page.fill('#ctx-roaster', 'Typo Roasters');
  await page.dispatchEvent('#ctx-roaster', 'change');
  await page.waitForTimeout(200);
  await page.fill('#ctx-roaster', 'E2E roaster');
  await page.dispatchEvent('#ctx-roaster', 'change');
  await page.waitForTimeout(200);
  await page.click('.view-tab[data-view="settings"]');
  const chipsBefore = await page.evaluate(() => [...document.querySelectorAll('#list-roaster .chip')].map((c) => c.firstChild.textContent.trim()));
  await page.click('#list-roaster .chip button[aria-label="Remove Typo Roasters"]');
  await page.waitForTimeout(300);
  const chipsAfter = await page.evaluate(() => [...document.querySelectorAll('#list-roaster .chip')].map((c) => c.firstChild.textContent.trim()));
  const roasterOpts = await page.evaluate(() => [...document.querySelectorAll('#roaster-list option')].map((o) => o.value));
  check('Settings → Pick-lists removes an entry from the roaster list', chipsBefore.includes('Typo Roasters') && !chipsAfter.includes('Typo Roasters') && !roasterOpts.includes('Typo Roasters') && roasterOpts.includes('E2E roaster'), `${chipsBefore.join('/')} → ${chipsAfter.join('/')}`);
  await page.click('.view-tab[data-view="shots"]');
  check('rail shows the configured address', (await page.textContent('#meticulous-addr')).includes(`localhost:${MOCK_PORT}`));
  await page.click('#meticulous-connect');

  // Portal: connect through the fake
  await page.click('#portal-connect');
  await page.waitForFunction(() => document.querySelector('#link-portal .dot')?.dataset.state === 'connected', null, { timeout: 8000 });
  const req = await page.evaluate(() => window.__fakePortalRequest);
  check('requestDevice filters on service 0x7400 with name fallbacks', JSON.stringify(req).includes('29696') && JSON.stringify(req).includes('PORTAL'), JSON.stringify(req));
  await page.waitForTimeout(1500);
  const steps = await page.evaluate(() => [...document.querySelectorAll('#portal-steps li')].map((li) => [li.dataset.step, li.dataset.ok]));
  check('connection check: all ten steps green', steps.every(([, ok]) => ok === 'true'), steps.map((s) => s.join(':')).join(' '));
  const summary = await page.textContent('#portal-check-summary');
  check('connection check summary says packets flowing', /packets flowing/.test(summary), summary.trim());
  const ec = await page.textContent('#ro-ec');
  check('live EC readout updating', /^\d+\.\d{3}$/.test(ec.trim()), ec.trim());

  // Let the mock machine's shot happen (it starts ~3 s after the mock boots and lasts 30 s)
  await page.evaluate(() => {
    const el = document.querySelector('#rec-indicator');
    const obs = new MutationObserver(() => {
      if (el.dataset.state === 'recording' && !Number.isFinite(window.__fakePortalShotStart)) window.__fakePortalShotStart = performance.now();
    });
    obs.observe(el, { attributes: true });
    if (el.dataset.state === 'recording') window.__fakePortalShotStart = performance.now();
  });
  await page.waitForFunction(() => document.querySelector('#rec-indicator')?.dataset.state === 'recording', null, { timeout: 30000 });
  check('recording started on the machine’s extracting flag', true);
  await page.waitForTimeout(2500);
  // The live shot is checkpointed to the database while it runs
  const ckpt = await page.evaluate(async () => {
    const live = window.__pb.recorder.shot;
    const rows = await window.__pb.store.listShots();
    const row = rows.find((r) => r.id === live?.id);
    return { liveId: live?.id, found: !!row, inProgress: !!row?.inProgress, portal: row?.portal?.length || 0, machine: row?.machine?.length || 0, target: live?.profileTargetG, sub: document.querySelector('#shot-sub').textContent, histRow: document.querySelector('#hist-rows tr.recording') ? document.querySelector('#hist-rows tr.recording').textContent : null };
  });
  check('live shot is checkpointed to IndexedDB while recording', ckpt.found && ckpt.inProgress && ckpt.machine > 3, JSON.stringify(ckpt).slice(0, 200));
  check('live shot picks up the profile\'s target weight from the machine\'s profile list at the start', ckpt.target === 38 && /target 38\.0 g/.test(ckpt.sub), JSON.stringify({ target: ckpt.target, sub: ckpt.sub }));
  const writes = await page.evaluate(() => window.__fakePortalWrites || []);
  const dbg = await page.evaluate(() => ({ autoGraph: window.__pb.settings.autoGraph, connected: window.__pb.portal.connected, cmd: !!window.__pb.portal.command, log: window.__pb.log.ring.filter((e) => /graph|command/i.test(e.msg)).map((e) => e.msg) }));
  check('show-graph command written at shot start (40 00 01 2D)', JSON.stringify(writes).includes('[64,0,1,45]'), JSON.stringify(writes) + ' ' + JSON.stringify(dbg));
  await page.waitForFunction(() => document.querySelector('#rec-indicator')?.dataset.state === 'idle' && window.__pb.state.shots.some((x) => !x.inProgress), null, { timeout: 90000 });
  await page.waitForTimeout(6000); // machine-record swap
  const writes2 = await page.evaluate(() => window.__fakePortalWrites || []);
  check('hide-graph command written at shot end (40 00 01 2E)', JSON.stringify(writes2).includes('[64,0,1,46]'));

  const sel = await page.evaluate(() => {
    const s = window.__pb.state.selected;
    const a = window.__pb.state.analysis;
    return { portal: s.portal.length, machine: s.machine.length, status: a.status, coverage: a.coverageRatio, meanEc: a.meanEcPerG, peak: a.mainPeakEc, machineRecord: !!s.machineShotId, target: s.profileTargetG, recordTarget: s.machineSource?.profile?.final_weight, scale: s.finalWeightG, sub: document.querySelector('#shot-sub').textContent };
  });
  check('shot has Portal samples at ~8 Hz', sel.portal > 150, `${sel.portal} samples`);
  check('machine record attached', sel.machineRecord);
  const targets = await page.evaluate(() => ({ byName: window.__pb.state.profileTargets.get('Blooming Espresso'), byId43: window.__pb.state.profileTargetsById.get('80c5ea87'), byId38: window.__pb.state.profileTargetsById.get('dup00002'), shotProfileId: window.__pb.state.selected?.profileId }));
  check('two profiles with one name and different targets are told apart by id (the variable-defined one too); the shot keeps the loaded profile\'s id', Number.isNaN(targets.byName) && targets.byId43 === 43 && targets.byId38 === 38 && targets.shotProfileId === 'demo0001', JSON.stringify(targets));
  check('profile target kept from the attached record; beverage defaults to it, not the scale', sel.target === 38 && sel.recordTarget === 38 && Math.abs(sel.scale - 40) < 0.3 && /38\.0 g out \(profile target; machine 40\.0 g\)/.test(sel.sub), JSON.stringify({ target: sel.target, recordTarget: sel.recordTarget, scale: sel.scale, sub: sel.sub }));
  check('analysis status ok with ≥ 85 % coverage', sel.status === 'ok' && sel.coverage >= 0.85, `${sel.status}, coverage ${(sel.coverage * 100).toFixed(0)} %`);
  check('mean EC and peak are plausible', sel.meanEc > 0.5 && sel.peak > sel.meanEc, `mean ${sel.meanEc.toFixed(3)} peak ${sel.peak.toFixed(3)}`);
  const finalRows = await page.evaluate(async () => (await window.__pb.store.listShots()).map((r) => ({ id: r.id, inProgress: !!r.inProgress, files: r.files?.json || null })));
  check('checkpoint replaced by the final record (no in-progress rows left)', finalRows.length === 1 && !finalRows[0].inProgress, JSON.stringify(finalRows));
  const shotFiles = await page.evaluate(() => Object.keys(window.__fakeFolderFiles || {}).filter((f) => /portal-met-bridge\/shots\//.test(f)));
  check('shot JSON and CSV written to the save folder automatically', shotFiles.some((f) => /\.json$/.test(f)) && shotFiles.some((f) => /\.csv$/.test(f)) && !!finalRows[0].files, shotFiles.join(', '));
  const autoJson = await page.evaluate(() => { const k = Object.keys(window.__fakeFolderFiles).find((f) => /shots\/.*\.json$/.test(f)); return JSON.parse(window.__fakeFolderFiles[k]); });
  check('auto-written JSON carries the machine record and the Portal samples', autoJson?.shot?.machineShotId && autoJson.shot.portal.length > 150 && autoJson.analysis?.meanEcPerG > 0, `machineShotId=${autoJson?.shot?.machineShotId} portal=${autoJson?.shot?.portal?.length}`);

  // ---- Rating and comment (v0.17): the app asks once the shot is saved; stars under the title re-rate in place
  await page.waitForSelector('#rating-dialog[open]', { timeout: 5000 });
  check('a rating dialog opens after the shot is saved, naming the shot', /^How was it\? — .*E2E coffee/.test(await page.textContent('#r-title')) && /Blooming Espresso/.test(await page.textContent('#r-sub')), `${(await page.textContent('#r-title')).trim()} | ${(await page.textContent('#r-sub')).trim()}`);
  await page.keyboard.press('4');
  check('pressing 4 lights four stars and offers "clear"', (await page.evaluate(() => document.querySelectorAll('#r-stars button.star.on').length)) === 4 && (await page.isVisible('#r-stars .star-clear')));
  await page.fill('#r-comment', 'sweet, a bit short');
  await page.click('#r-save');
  await page.waitForTimeout(400);
  const rated = await page.evaluate(() => ({ open: document.querySelector('#rating-dialog').open, rating: window.__pb.state.selected?.rating, comment: window.__pb.state.selected?.comment, header: document.querySelector('#shot-rating').textContent.replace(/\s+/g, ' ').trim(), on: document.querySelectorAll('#shot-rating button.star.on').length }));
  check('the rating and comment are saved with the shot and shown under its title', !rated.open && rated.rating === 4 && rated.comment === 'sweet, a bit short' && rated.on === 4 && /sweet, a bit short/.test(rated.header) && /Edit comment/.test(rated.header), JSON.stringify(rated));
  await page.click('#shot-rating button.star[data-star="5"]');
  await page.waitForTimeout(500);
  const rerated = await page.evaluate(() => { const k = Object.keys(window.__fakeFolderFiles).find((f) => /shots\/.*\.json$/.test(f)); return { rating: window.__pb.state.selected?.rating, on: document.querySelectorAll('#shot-rating button.star.on').length, json: JSON.parse(window.__fakeFolderFiles[k]).shot.rating, comment: JSON.parse(window.__fakeFolderFiles[k]).shot.comment }; });
  check('clicking a star under the shot title re-rates it in place and the auto-written JSON follows', rerated.rating === 5 && rerated.on === 5 && rerated.json === 5 && rerated.comment === 'sweet, a bit short', JSON.stringify(rerated));

  // History tab: list, search, filter, open, edit, delete
  await page.click('.view-tab[data-view="history"]');
  const histRows = await page.evaluate(() => [...document.querySelectorAll('#hist-rows tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()));
  check('History lists the shot with its coffee, EC/g and data tags', histRows.length === 1 && /E2E coffee/.test(histRows[0]) && /P \d+/.test(histRows[0]) && /M \d+/.test(histRows[0]), histRows.join(' | ').slice(0, 200));
  check('History has a Grind column (µm) before In → out', /420 µm.*18\.0 → 38\.0 g◎/.test(histRows[0]), histRows[0].slice(0, 160));
  check('History In → out shows the profile target with the ◎ mark and the ratio from it', /→ 38\.0 g◎\s*1 : 2\.11/.test(histRows[0]), histRows[0].slice(0, 160));
  const grindTh = await page.evaluate(() => [...document.querySelectorAll('#hist-table th')].map((th) => th.textContent.trim()));
  check('Grind header sits between Profile and In → out', grindTh.indexOf('Grind') === grindTh.indexOf('Profile') + 1 && grindTh.indexOf('In → out') === grindTh.indexOf('Grind') + 1, grindTh.join(' | '));
  check('History has a ★ column after TDS showing the rating and a comment mark', grindTh.indexOf('★') === grindTh.indexOf('TDS') + 1 && /★5💬/.test(histRows[0]) && /sweet, a bit short/.test(await page.getAttribute('#hist-rows tr td.rating button', 'title')), histRows[0].slice(0, 200));
  await page.click('#hist-table th[data-sort="rating"]');
  check('the ★ column is sortable', (await page.getAttribute('#hist-table th[data-sort="rating"]', 'aria-sort')) !== 'none');
  await page.click('#hist-table th[data-sort="startedAt"]');
  await page.fill('#hist-search', 'a bit short');
  check('History search matches the comment', (await page.evaluate(() => document.querySelectorAll('#hist-rows tr').length)) === 1);
  await page.fill('#hist-search', '');
  await page.click('#hist-rows tr td.rating button[data-act="rate"]');
  await page.waitForSelector('#rating-dialog[open]');
  check('the ★ cell opens the rating dialog with the current rating and comment', /^Your rating/.test(await page.textContent('#r-title')) && (await page.evaluate(() => document.querySelectorAll('#r-stars button.star.on').length)) === 5 && (await page.inputValue('#r-comment')) === 'sweet, a bit short');
  await page.click('#r-later');
  await page.waitForTimeout(200);
  await page.click('#hist-table th[data-sort="grind"]');
  check('Grind column is sortable', (await page.getAttribute('#hist-table th[data-sort="grind"]', 'aria-sort')) !== 'none');
  await page.click('#hist-table th[data-sort="startedAt"]');
  await page.fill('#hist-search', '420');
  check('History search matches the grind size', (await page.evaluate(() => document.querySelectorAll('#hist-rows tr').length)) === 1);
  await page.fill('#hist-search', '');
  await page.fill('#hist-search', 'zzz-nothing');
  check('History search filters rows', (await page.evaluate(() => document.querySelectorAll('#hist-rows tr').length)) === 0);
  await page.fill('#hist-search', 'E2E');
  check('History search matches the bean', (await page.evaluate(() => document.querySelectorAll('#hist-rows tr').length)) === 1);
  await page.fill('#hist-search', '');
  await page.selectOption('#hist-filter', 'reading');
  check('filter "with a refractometer reading" hides shots without one', (await page.evaluate(() => document.querySelectorAll('#hist-rows tr').length)) === 0);
  await page.selectOption('#hist-filter', 'all');
  await page.click('#hist-rows tr button[data-act="edit"]');
  await page.waitForSelector('#shot-dialog[open]');
  check('the edit dialog shows the rating and comment', (await page.evaluate(() => document.querySelectorAll('#e-stars button.star.on').length)) === 5 && (await page.inputValue('#e-comment')) === 'sweet, a bit short');
  await page.click('#e-stars button.star[data-star="3"]');
  await page.fill('#e-comment', 'sweet, a bit short; edited later');
  await page.fill('#e-bean', 'E2E coffee (edited)');
  await page.fill('#e-dose', '18.5');
  await page.fill('#e-tds', '9.1');
  await page.fill('#e-bev', '41.5');
  await page.click('#shot-dialog-save');
  await page.waitForTimeout(400);
  const edited = await page.evaluate(() => ({ row: document.querySelector('#hist-rows tr')?.textContent.replace(/\s+/g, ' '), sel: window.__pb.state.selected?.context?.beanName, tds: window.__pb.state.selected?.refractometer?.tdsPct, dose: window.__pb.state.selected?.context?.doseG, open: document.querySelector('#shot-dialog').open, bev: window.__pb.state.selected?.beverageG, ey: window.__pb.state.selected?.refractometer?.eyPct, machineW: window.__pb.state.selected?.finalWeightG, sub: document.querySelector('#shot-sub').textContent }));
  check('History → Edit updates coffee, dose and reading', /E2E coffee \(edited\)/.test(edited.row) && /18\.5 →/.test(edited.row) && edited.sel === 'E2E coffee (edited)' && edited.tds === 9.1 && edited.dose === 18.5 && !edited.open, JSON.stringify(edited).slice(0, 200));
  check('History → Edit changes the rating and comment too', /★3💬/.test(edited.row) && (await page.evaluate(() => [window.__pb.state.selected?.rating, window.__pb.state.selected?.comment].join('|'))) === '3|sweet, a bit short; edited later', edited.row.slice(0, 200));
  check('beverage weighed is editable and replaces the machine weight for yield and EY', edited.bev === 41.5 && /→ 41\.5 g⚖/.test(edited.row) && Math.abs(edited.ey - (9.1 * 41.5) / 18.5) < 0.01 && /41\.5 g out \(weighed; machine/.test(edited.sub), JSON.stringify({ bev: edited.bev, ey: edited.ey, machineW: edited.machineW, sub: edited.sub }).slice(0, 220));
  // blanking the field returns to the machine's scale
  await page.click('#hist-rows tr button[data-act="edit"]');
  await page.waitForSelector('#shot-dialog[open]');
  check('edit dialog shows the weighed value, the profile target as placeholder and both values in the hint', (await page.inputValue('#e-bev')) === '41.5' && /^38\.0 \(profile target\)$/.test(await page.getAttribute('#e-bev', 'placeholder')) && /Profile target 38\.0 g · machine's scale 40\.0 g/.test(await page.textContent('#e-bev-hint')), `${await page.getAttribute('#e-bev', 'placeholder')} | ${(await page.textContent('#e-bev-hint')).trim()}`);
  await page.fill('#e-bev', '');
  await page.click('#shot-dialog-save');
  await page.waitForTimeout(400);
  const reverted = await page.evaluate(() => ({ bev: window.__pb.state.selected?.beverageG, row: document.querySelector('#hist-rows tr')?.textContent.replace(/\s+/g, ' '), machineW: window.__pb.state.selected?.finalWeightG, ey: window.__pb.state.selected?.refractometer?.eyPct, refBev: window.__pb.state.selected?.refractometer?.beverageG }));
  check('blank beverage weighed reverts to the profile target (the reading\'s EY follows)', reverted.bev === undefined && !/⚖/.test(reverted.row) && /→ 38\.0 g◎/.test(reverted.row) && Math.abs(reverted.ey - (9.1 * 38) / 18.5) < 0.01 && reverted.refBev === undefined && Math.abs(reverted.machineW - 40) < 0.3, JSON.stringify(reverted).slice(0, 200));
  check('History shows the brew ratio (dose : beverage) after In → out', /38\.0 g◎\s*1 : 2\.05/.test(reverted.row), reverted.row.slice(0, 160));
  // Settings → Recording → Beverage weight: back to the machine's scale, for every shot
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-beverage-default', 'scale');
  await page.waitForTimeout(300);
  check('beverage-weight setting saves on change', (await page.evaluate(() => window.__pb.settings.beverageDefault)) === 'scale' && /Saved 1 setting/.test(await page.textContent('#savebar-status')), (await page.textContent('#savebar-status')).trim());
  await page.click('.view-tab[data-view="history"]');
  const scaled = await page.evaluate(() => ({ row: document.querySelector('#hist-rows tr')?.textContent.replace(/\s+/g, ' '), sub: document.querySelector('#shot-sub').textContent }));
  check('with "machine\'s scale" chosen, History and the shot header use the scale weight without a mark', /→ 40\.0 g\s*1 : 2\.16/.test(scaled.row) && !/◎/.test(scaled.row) && /40\.0 g out · 1 : 2\.16/.test(scaled.sub), JSON.stringify(scaled).slice(0, 220));
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-beverage-default', 'profile');
  await page.waitForTimeout(300);
  await page.click('.view-tab[data-view="history"]');
  check('back to "profile target" restores the target everywhere', /→ 38\.0 g◎/.test(await page.evaluate(() => document.querySelector('#hist-rows tr')?.textContent.replace(/\s+/g, ' '))));
  await page.click('#hist-rows tr button[data-act="open"]');
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => ({ shotsVisible: !document.querySelector('#view-shots').hidden, histHidden: document.querySelector('#view-history').hidden, sub: document.querySelector('#shot-sub').textContent }));
  check('History → Open shows the shot on the Shots tab', opened.shotsVisible && opened.histHidden && /E2E coffee \(edited\)/.test(opened.sub), JSON.stringify(opened).slice(0, 160));
  await page.click('.view-tab[data-view="settings"]');
  await page.click('#demo-load');
  await page.waitForTimeout(600);
  await page.click('.view-tab[data-view="history"]');
  const rowsWithDemo = await page.evaluate(() => [...document.querySelectorAll('#hist-rows tr')].map((tr) => ({ id: tr.dataset.id, demo: /demo/.test(tr.textContent) })));
  check('demo shot appears in History', rowsWithDemo.length === 2 && rowsWithDemo.some((r) => r.demo), JSON.stringify(rowsWithDemo));
  const demoId = rowsWithDemo.find((r) => r.demo).id;
  // Compare: tick both shots and overlay their graphs
  for (const r of rowsWithDemo) await page.check(`#hist-rows tr[data-id="${r.id}"] input[type="checkbox"]`);
  check('Compare selected is enabled with two ticked shots', /Compare selected \(2\)/.test(await page.textContent('#hist-compare')) && !(await page.isDisabled('#hist-compare')));
  // Export selected (v0.18): a zip of just the ticked shots, through the browser by default
  check('Export selected is enabled with the ticked shots', /Export selected \(2\)/.test(await page.textContent('#hist-export')) && !(await page.isDisabled('#hist-export')));
  const selZip = await dl('#hist-export');
  await page.waitForFunction(() => /2 shots exported/.test(document.querySelector('#dl-progress').textContent), null, { timeout: 60000 });
  check('Export selected downloads a zip named for the two shots', /portal-met-bridge-export-2-shots-.*\.zip$/.test(selZip.name) && selZip.bytes > 40000, `${selZip.name} ${selZip.bytes} B`);
  await page.click('.view-tab[data-view="history"]');
  await page.click('#hist-compare');
  await page.waitForTimeout(500);
  const cmp = await page.evaluate(() => ({ visible: !document.querySelector('#compare-panel').hidden, series: window.__pb.compareChart.u?.series.length, legendRows: document.querySelectorAll('#cmp-legend tbody tr').length, legendText: document.querySelector('#cmp-legend').textContent.replace(/\s+/g, ' ').slice(0, 300), xField: !document.querySelector('#cmp-x-field').hidden }));
  check('Compare overlays two shots on one EC-vs-mass chart with a legend', cmp.visible && cmp.series === 3 && cmp.legendRows === 2 && /E2E coffee/.test(cmp.legendText) && /1 : 2\.05/.test(cmp.legendText) && cmp.xField, JSON.stringify(cmp).slice(0, 260));
  await page.selectOption('#cmp-x', 'ratio');
  await page.waitForTimeout(300);
  const cmpRatio = await page.evaluate(() => ({ series: window.__pb.compareChart.u?.series.length, xmax: window.__pb.compareChart.u?.scales.x.max, excluded: document.querySelectorAll('#cmp-legend tr.excluded').length }));
  check('brew-ratio axis rescales both shots (x spans ~2.2 instead of ~40 g)', cmpRatio.series === 3 && cmpRatio.xmax > 1.5 && cmpRatio.xmax < 4 && cmpRatio.excluded === 0, JSON.stringify(cmpRatio));
  await page.selectOption('#cmp-series', 'pressure-time');
  await page.waitForTimeout(300);
  const cmpTime = await page.evaluate(() => ({ series: window.__pb.compareChart.u?.series.length, xField: !document.querySelector('#cmp-x-field').hidden, xmax: window.__pb.compareChart.u?.scales.x.max, ylabel: document.querySelector('#cmp-chart .u-axis:nth-of-type(2) .u-label, #cmp-chart .u-label')?.textContent }));
  check('time-based graphs hide the mass-axis option and span the shot duration', cmpTime.series === 3 && !cmpTime.xField && cmpTime.xmax > 25, JSON.stringify(cmpTime));
  await page.click('#cmp-close');
  check('Close hides the comparison', await page.evaluate(() => document.querySelector('#compare-panel').hidden));
  await page.uncheck(`#hist-rows tr[data-id="${rowsWithDemo.find((r) => r.id !== demoId).id}"] input[type="checkbox"]`);
  check('selecting a row enables Delete selected', /Delete selected \(1\)/.test(await page.textContent('#hist-delete-selected')) && !(await page.isDisabled('#hist-delete-selected')));
  await page.click('#hist-delete-selected');
  await page.waitForSelector('#confirm-dialog[open]');
  check('delete asks for confirmation in a dialog', /Delete this shot\?/.test(await page.textContent('#confirm-title')));
  await page.click('#confirm-cancel');
  await page.waitForTimeout(200);
  check('cancelling keeps the shot', (await page.evaluate(() => document.querySelectorAll('#hist-rows tr').length)) === 2);
  await page.click('#hist-delete-selected');
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-go');
  await page.waitForTimeout(400);
  const afterDelete = await page.evaluate(() => [...document.querySelectorAll('#hist-rows tr')].map((tr) => tr.dataset.id));
  check('confirming deletes the selected shot', afterDelete.length === 1 && !afterDelete.includes(demoId), afterDelete.join(','));
  await page.click('.view-tab[data-view="shots"]');

  // Refractometer reading → estimate from "this bean" vs pools (overwrites the 9.1 typed in the dialog)
  await page.fill('#ref-tds', '9.3');
  await page.click('#ref-save');
  await page.waitForTimeout(500);
  const basis = await page.textContent('#est-flags');
  check('estimate after one reading is flagged preliminary and excludes the shot itself', /Preliminary|No refractometer/.test(basis), basis.trim().slice(0, 80));

  // Per-shot files follow Settings → Files and folders → "Where the buttons send their files" (v0.18): browser by default, even with a folder ready
  const csvDl = await dl('#dl-csv');
  let folderFiles = await page.evaluate(() => Object.keys(window.__fakeFolderFiles || {}));
  check('with the default "download through the browser", CSV (samples) downloads although a folder is ready, and the note says so', /\.csv$/.test(csvDl.name) && !folderFiles.some((f) => /exports\/shot-.*\.csv$/.test(f)) && /download through the browser/.test(await page.textContent('#shot-files-where')), `${csvDl.name}; folder: ${folderFiles.join(', ')}`);
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-shot-files-via', 'folder');
  await page.selectOption('#set-exports-via', 'folder');
  await page.waitForTimeout(200);
  await page.click('.view-tab[data-view="shots"]');
  check('set to the folder, the note under the buttons names it', /write to .*portal-met-bridge\/ \(exports\/ and reports\/\)/.test(await page.textContent('#shot-files-where')), (await page.textContent('#shot-files-where')).trim());
  await page.click('#dl-csv');
  await page.waitForTimeout(800);
  folderFiles = await page.evaluate(() => Object.keys(window.__fakeFolderFiles || {}));
  check('CSV saved into the chosen folder', folderFiles.some((f) => /portal-met-bridge\/exports\/shot-.*\.csv$/.test(f)), folderFiles.join(', '));
  await page.click('.view-tab[data-view="settings"]');
  await page.click('#log-download');
  await page.waitForTimeout(800);
  folderFiles = await page.evaluate(() => Object.keys(window.__fakeFolderFiles || {}));
  check('log file written to the folder (dated .log) and the download copy', folderFiles.some((f) => /logs\/\d{4}-\d{2}-\d{2}\.log$/.test(f)) && folderFiles.some((f) => /logs\/portal-met-bridge-log-.*\.txt$/.test(f)), folderFiles.filter((f) => f.includes('logs')).join(', '));
  const logText = await page.evaluate(() => { const k = Object.keys(window.__fakeFolderFiles).find((f) => /\.log$/.test(f)); return window.__fakeFolderFiles[k]; });

  // ---- the server's data folder as the destination (v0.14): files land on the disk of the machine that serves the app
  await page.selectOption('#set-file-destination', 'server');
  await page.waitForTimeout(300);
  const srvState = await page.evaluate(() => ({ eff: window.__pb.files.effective, ready: window.__pb.files.ready, where: window.__pb.files.whereOf('exports') }));
  check('switching to the server\'s data folder takes effect at once', srvState.eff === 'server' && srvState.ready && srvState.where === `${process.env.PMB_E2E_DATA}/portal-met-bridge/exports/`, JSON.stringify(srvState));
  await page.click('.view-tab[data-view="shots"]');
  await page.click('#dl-csv');
  await page.waitForTimeout(800);
  let disk = onDisk();
  check('a CSV export is written into <data folder>/portal-met-bridge/exports/ on the server', disk.some((f) => /^portal-met-bridge\/exports\/shot-.*\.csv$/.test(f)), disk.join(', '));
  await page.click('.view-tab[data-view="settings"]');
  await page.fill('#set-dir-root', 'espresso/pmb');
  await page.fill('#set-dir-exports', ' ../CSV: out ');
  await page.click('#settings-save');
  await page.waitForTimeout(300);
  const cleaned = await page.evaluate(() => ({ root: window.__pb.settings.fileRoot, exports: window.__pb.settings.dirExports, input: document.querySelector('#set-dir-exports').value, where: window.__pb.files.whereOf('exports') }));
  check('folder names are cleaned (no .., no colon) and the layout follows them', cleaned.root === 'espresso/pmb' && cleaned.exports === 'CSV out' && cleaned.input === 'CSV out' && /\/espresso\/pmb\/CSV out\/$/.test(cleaned.where), JSON.stringify(cleaned));
  await page.click('.view-tab[data-view="shots"]');
  await page.click('#dl-csv');
  await page.waitForTimeout(800);
  await page.click('.view-tab[data-view="settings"]');
  await page.click('#log-download');
  await page.waitForTimeout(600);
  await page.click('#files-backup-now');
  await page.waitForSelector('#choice-dialog[open]');
  check('Write a backup now asks: the folder (named) or a browser download', /Write a backup now/.test(await page.textContent('#choice-title')) && /espresso\/pmb\/backups\//.test(await page.textContent('#choice-list button[data-id="folder"]')) && !(await page.isDisabled('#choice-list button[data-id="folder"]')), (await page.textContent('#choice-list')).replace(/\s+/g, ' ').slice(0, 200));
  await page.click('#choice-list button[data-id="folder"]');
  await page.waitForFunction(() => /Backup written/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  disk = onDisk();
  check('after the rename, exports, the log and a backup land under the new root and names', disk.some((f) => /^espresso\/pmb\/CSV out\/shot-.*\.csv$/.test(f)) && disk.some((f) => /^espresso\/pmb\/logs\/portal-met-bridge-log-.*\.txt$/.test(f)) && disk.some((f) => /^espresso\/pmb\/logs\/\d{4}-\d{2}-\d{2}\.log$/.test(f)) && disk.includes('espresso/pmb/backups/portal-met-bridge-latest.json') && disk.some((f) => /^espresso\/pmb\/backups\/portal-met-bridge-\d{4}-\d{2}-\d{2}\.json$/.test(f)), disk.join(', '));
  const backupDoc = JSON.parse(readFileSync(join(process.env.PMB_E2E_DATA, 'espresso/pmb/backups/portal-met-bridge-latest.json'), 'utf8'));
  check('the automatic backup is a full export (shots with samples, restorable)', backupDoc.app === 'portal-met-bridge' && Array.isArray(backupDoc.shots) && backupDoc.shots.length >= 1 && Array.isArray(backupDoc.shots[0].machine), `${backupDoc.shots?.length} shots`);
  // Back up everything downloads; Restore… offers the saved backups of the backups folder (v0.18)
  const everything = await dl('#backup-export');
  check('Back up everything (JSON) downloads through the browser', /portal-met-bridge-backup-.*\.json$/.test(everything.name) && JSON.parse(readFileSync(everything.path, 'utf8')).shots.length === backupDoc.shots.length, everything.name);
  await page.click('#backup-restore');
  await page.waitForSelector('#choice-dialog[open]');
  const restoreChoices = await page.evaluate(() => ({ title: document.querySelector('#choice-title').textContent, upload: !document.querySelector('#choice-list button[data-id="upload"]').disabled, saved: !document.querySelector('#choice-list button[data-id="saved"]').disabled, hint: document.querySelector('#choice-list button[data-id="saved"]').textContent }));
  check('Restore asks: upload a file, or pick a saved backup (counted, in the backups folder)', /Restore from a backup/.test(restoreChoices.title) && restoreChoices.upload && restoreChoices.saved && /\d+ in .*espresso\/pmb\/backups\//.test(restoreChoices.hint), JSON.stringify(restoreChoices));
  await page.click('#choice-list button[data-id="saved"]');
  await page.waitForFunction(() => /Saved backups in/.test(document.querySelector('#choice-title').textContent));
  const savedList = await page.evaluate(() => [...document.querySelectorAll('#choice-list button.choice')].map((b) => b.dataset.id));
  check('the saved backups are listed, latest and the dated copy', savedList.includes('portal-met-bridge-latest.json') && savedList.some((n) => /^portal-met-bridge-\d{4}-\d{2}-\d{2}\.json$/.test(n)), savedList.join(','));
  await page.click('#choice-list button[data-id="portal-met-bridge-latest.json"]');
  await page.waitForFunction(() => /Restored \d+ shots from portal-met-bridge-latest\.json/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  check('picking one restores it (merging by id: the shot count is unchanged)', (await page.evaluate(() => window.__pb.state.shots.filter((x) => !x.inProgress).length)) === backupDoc.shots.length, await page.textContent('#toast'));
  const refused = await page.evaluate(async () => { const codes = []; for (const p of ['../x.txt', 'a/.hidden', 'a/..%2Fb', 'bad:name']) codes.push((await fetch(`api/files/${p}`, { method: 'PUT', body: 'x' })).status); return codes; });
  check('the server refuses paths that leave the data folder or hide files', refused.every((c) => c === 400 || c === 404 || c === 405), refused.join(',')); // '../x.txt' is normalised by the browser to /x.txt: a PUT outside api/ is 405
  await page.fill('#set-dir-root', 'portal-met-bridge');
  await page.fill('#set-dir-exports', 'exports');
  await page.click('#settings-save');
  await page.waitForTimeout(200);
  await page.selectOption('#set-file-destination', 'folder');
  await page.waitForTimeout(300);
  check('back to the chosen folder', (await page.evaluate(() => window.__pb.files.effective)) === 'folder');
  check('log contains Portal GATT steps and recorder transitions', /\[portal\] state connected/.test(logText) && /\[recorder\] → recording/.test(logText) && /\[recorder\] saved shot/.test(logText), logText.split('\n').slice(0, 3).join(' | '));
  // ---- Final weight typed after each brew (Settings → Recording → Final weight: manual)
  await page.selectOption('#set-beverage-default', 'manual');
  await page.waitForTimeout(300);
  await page.click('.view-tab[data-view="history"]');
  const manualRow = await page.evaluate(() => document.querySelector('#hist-rows tr')?.textContent.replace(/\s+/g, ' '));
  check('with the typed option and nothing typed, History shows "? g" instead of a stand-in', /18\.5 → \? g/.test(manualRow) && !/◎/.test(manualRow), manualRow.slice(0, 120));
  await page.click('#hist-rows tr button[data-act="weigh"]');
  await page.waitForSelector('#weight-dialog[open]');
  check('the "? g" button opens the final-weight dialog with the scale value as a hint', /scale saw 40\.0/.test(await page.getAttribute('#w-bev', 'placeholder')) && /machine's scale 40\.0 g/.test(await page.textContent('#w-hint')), `${await page.getAttribute('#w-bev', 'placeholder')} | ${(await page.textContent('#w-hint')).trim()}`);
  await page.fill('#w-bev', '43');
  await page.press('#w-bev', 'Enter');
  await page.waitForTimeout(400);
  const typedRow = await page.evaluate(() => ({ row: document.querySelector('#hist-rows tr')?.textContent.replace(/\s+/g, ' '), bev: window.__pb.state.selected?.beverageG, sub: document.querySelector('#shot-sub').textContent, weighHidden: document.querySelector('#shot-weigh').hidden }));
  check('Enter saves the typed final weight: History shows it with ⚖, the shot header uses it, the Enter-final-weight button goes away', /→ 43\.0 g⚖\s*1 : 2\.32/.test(typedRow.row) && typedRow.bev === 43 && /43\.0 g out \(weighed; machine 40\.0 g\)/.test(typedRow.sub) && typedRow.weighHidden === true, JSON.stringify(typedRow).slice(0, 220));
  await page.click('.view-tab[data-view="shots"]');
  await page.evaluate(() => window.__pb.openWeightDialog(window.__pb.state.selected.id));
  await page.waitForSelector('#weight-dialog[open]');
  await page.fill('#w-bev', '');
  await page.click('#w-save');
  await page.waitForTimeout(400);
  check('a blank weight clears it again and the Shots tab offers Enter final weight', (await page.evaluate(() => window.__pb.state.selected?.beverageG)) === undefined && (await page.isVisible('#shot-weigh')) && /final weight not entered/.test(await page.textContent('#shot-sub')));
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-beverage-default', 'profile');
  await page.waitForTimeout(300);

  // ---- AI review: settings against the mock's OpenAI-compatible endpoint
  await page.selectOption('#set-ai-provider', 'openai');
  await page.waitForTimeout(200);
  check('choosing a provider shows only its block', (await page.isHidden('.ai-provider[data-provider="anthropic"]')) && (await page.isVisible('.ai-provider[data-provider="openai"]')));
  await page.fill('#set-ai-key-openai', 'sk-test-123');
  await page.fill('#set-ai-model-openai', 'mock-gpt-2');
  await page.fill('#set-ai-base-openai', `http://127.0.0.1:${MOCK_PORT}`);
  await page.click('#savebar .btn.primary');
  await page.waitForTimeout(300);
  check('AI settings save with the Save button and the key is shown masked', /Saved \d+ settings \([^)]*OpenAI key[^)]*\)/.test(await page.textContent('#savebar-status')) && /OpenAI · mock-gpt-2 · 127\.0\.0\.1:\d+ · key sk-tes…-123/.test(await page.textContent('#set-ai-note')), `${(await page.textContent('#savebar-status')).trim()} | ${await page.textContent('#set-ai-note')}`);
  await page.click('#set-ai-models');
  await page.waitForFunction(() => /models/.test(document.querySelector('#set-ai-test-result').textContent), null, { timeout: 5000 });
  const modelOpts = await page.evaluate(() => [...document.querySelectorAll('#ai-models-openai option')].map((o) => o.value));
  check('List models fills the picker from the endpoint (non-chat models dropped)', modelOpts.join(',') === 'mock-gpt-2,mock-gpt-1', modelOpts.join(','));
  await page.click('#set-ai-test');
  await page.waitForFunction(() => /answered|HTTP|reach/.test(document.querySelector('#set-ai-test-result').textContent), null, { timeout: 5000 });
  check('Test key gets a reply through the chat endpoint', /OpenAI answered in .* with “OK”/.test(await page.textContent('#set-ai-test-result')), (await page.textContent('#set-ai-test-result')).trim());
  await page.click('#set-ai-key-openai'); // the reveal toggle
  await page.click('button.reveal[data-reveal="set-ai-key-openai"]');
  check('Show reveals the key field', (await page.getAttribute('#set-ai-key-openai', 'type')) === 'text');
  await page.click('button.reveal[data-reveal="set-ai-key-openai"]');
  const logHasKey = await page.evaluate(() => /sk-test-123/.test(window.__pb.log.asText()));
  check('the key never appears in the debug log', logHasKey === false);

  // Settings export round-trip — always a browser download (v0.18), even with the server's folder in use
  const settingsDl = await dl('#settings-export');
  const settingsDoc = JSON.parse(readFileSync(settingsDl.path, 'utf8'));
  check('Export settings downloads through the browser rather than writing to the folder', /portal-met-bridge-settings-.*\.json$/.test(settingsDl.name) && !onDisk().some((f) => /settings-.*\.json$/.test(f)), settingsDl.name);
  check('settings export has the machine address and recording options', settingsDoc?.app === 'portal-met-bridge-settings' && settingsDoc.settings.meticulousHost === `localhost:${MOCK_PORT}` && 'settleSec' in settingsDoc.settings && 'logEnabled' in settingsDoc.settings && settingsDoc.settings.beverageDefault === 'profile', JSON.stringify(settingsDoc?.settings || {}).slice(0, 120));
  check('settings export carries the AI provider and model but never the API keys', settingsDoc?.settings.aiProvider === 'openai' && settingsDoc.settings.aiModelOpenai === 'mock-gpt-2' && !('aiKeyOpenai' in settingsDoc.settings) && !('aiKeyAnthropic' in settingsDoc.settings) && !JSON.stringify(settingsDoc).includes('sk-test-123'), Object.keys(settingsDoc?.settings || {}).filter((k) => k.startsWith('ai')).join(','));

  // ---- Analysis: three shots, one of them without Portal data
  await page.evaluate(async () => {
    const { makeDemoShot } = await import('./js/demo.js?v=' + document.querySelector('script[src*="main.js"]').src.split('v=')[1]);
    const s = { ...makeDemoShot({ seed: 9 }), id: 'machine-only', source: 'live', startedAt: Date.now() - 7200000, profileName: 'Blooming Espresso (demo)', context: { beanName: 'E2E coffee', doseG: 18, grindSize: '430 µm' } };
    s.portal = [];
    await window.__pb.store.putShot(s);
    await window.__pb.store.putShot({ ...makeDemoShot({ seed: 11 }), id: 'second-portal', source: 'live', startedAt: Date.now() - 5400000, profileName: 'Blooming Espresso (demo)', context: { beanName: 'E2E coffee', doseG: 18.2, grindSize: '425 µm' } });
    await window.__pb.refreshShotList();
  });
  await page.click('.view-tab[data-view="history"]');
  await page.waitForTimeout(300);
  const e2eShotId = rowsWithDemo.find((r) => r.id !== demoId).id;
  for (const id of [e2eShotId, 'second-portal', 'machine-only']) await page.check(`#hist-rows tr[data-id="${id}"] input[type="checkbox"]`);
  check('Analyze selected is enabled with ticked shots', /Analyze selected \(3\)/.test(await page.textContent('#hist-analyze')) && !(await page.isDisabled('#hist-analyze')));
  await page.click('#hist-analyze');
  await page.waitForTimeout(400);
  check('Analyze selected opens the Analysis tab with those shots ticked', (await page.isVisible('#view-analysis')) && (await page.textContent('#an-sel-count')).trim() === '(3)' && (await page.evaluate(() => document.querySelectorAll('#an-list input:checked').length)) === 3);
  const ratedRow = await page.evaluate(() => { const li = [...document.querySelectorAll('#an-list li')].find((x) => x.querySelector('.stars')); if (!li) return null; const r = (sel) => li.querySelector(sel).getBoundingClientRect(); const w = r('.when'); const t = r('.tags'); return { stars: li.querySelector('.stars').textContent, inTags: !!li.querySelector('.tags .stars'), sameLine: t.top < w.bottom && t.bottom > w.top, tagsRightOfWhat: t.left >= r('.what').right - 1 }; });
  check('a rated shot keeps its row on one line in the picker, the ★ chip among the tags (v0.17.1)', ratedRow && ratedRow.stars === '★3' && ratedRow.inTags && ratedRow.sameLine && ratedRow.tagsRightOfWhat, JSON.stringify(ratedRow));
  check('the size note counts shots and the one without Portal data', /About [\d,]+ tokens will be sent \(3 shots, 1 without Portal data\)/.test(await page.textContent('#an-size')), (await page.textContent('#an-size')).trim());
  const digestInfo = await page.evaluate(() => ({ blocks: document.querySelectorAll('#an-digest .an-shot').length, tables: document.querySelectorAll('#an-digest table.stages').length, noPortal: document.querySelectorAll('#an-digest .an-shot .muted').length > 0, gaps: [...document.querySelectorAll('#an-digest .gaps li')].map((li) => li.textContent).filter((t) => /No Belka Portal/.test(t)).length, stageNames: [...document.querySelectorAll('#an-digest .an-shot:last-child table.stages tbody td:first-child')].map((td) => td.textContent), chart: !!document.querySelector('#an-chart canvas') }));
  check('the local digest shows a stage table per shot, the record\'s stage names, and marks the shot without Portal data', digestInfo.blocks === 3 && digestInfo.tables === 3 && digestInfo.noPortal && digestInfo.gaps === 1 && digestInfo.stageNames.slice(0, 4).join(',') === 'Saturate,Bloom,Gentle Rebuild,Extract' && digestInfo.chart, JSON.stringify(digestInfo));
  // ---- before the review: confirm the profile and the final weight of every ticked shot (v0.13)
  const pre = await page.evaluate(() => ({ visible: !document.querySelector('#an-preflight').hidden, rows: document.querySelectorAll('#an-preflight .pf-row').length, todo: document.querySelectorAll('#an-preflight .pf-state.todo').length, runOff: document.querySelector('#an-run').disabled, hint: document.querySelector('#an-run-hint').textContent }));
  check('the pre-review panel lists every ticked shot as "to confirm" and keeps Review with AI off', pre.visible && pre.rows === 3 && pre.todo === 3 && pre.runOff && /Confirm the profile and final weight of all 3 shots/.test(pre.hint), JSON.stringify(pre));
  const liveRow = `#an-preflight .pf-row[data-id="${e2eShotId}"]`;
  const liveOpts = await page.evaluate((sel) => [...document.querySelector(`${sel} select.pf-profile`).options].map((o) => o.textContent), liveRow);
  check('the profile picker offers the machine\'s record first, then every profile on the machine with its target and temperature', /^As recorded — Blooming Espresso \(demo\) · 38 g$/.test(liveOpts[0]) && liveOpts.some((t) => /^On the machine — Blooming Espresso · 43 g · 92 °C$/.test(t)) && liveOpts.some((t) => /Hatch Supernova · 38 g · 93 °C/.test(t)) && liveOpts.length === 5, liveOpts.join(' | '));
  const liveWeights = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .pf-weight label`)].map((l) => `${l.classList.contains('off') ? 'off:' : ''}${l.querySelector('input').value}${l.querySelector('input').checked ? '*' : ''}`), liveRow);
  check('the weight choices show which sources exist for this shot and preselect the Settings default (profile target)', liveWeights.join(',') === 'off:weighed,profile*,scale,manual', liveWeights.join(','));
  await page.selectOption(`${liveRow} select.pf-profile`, '80c5ea87');
  await page.waitForFunction((sel) => /final weight 43\.0 g/.test(document.querySelector(`${sel} .pf-vars`)?.textContent || ''), liveRow, { timeout: 5000 });
  const varsLine = await page.textContent(`${liveRow} .pf-vars`);
  check('choosing a machine profile fetches it in full and lists its target, temperature, variables and stages', /^final weight 43\.0 g · 92 °C · Bloom Time 20 s · Extraction Flow 2 ml\/s · \d stages: .*Bloom.*Extract/.test(varsLine.trim()), varsLine.trim());
  check('the profile-target weight choice follows the chosen profile', /43\.0 g/.test(await page.textContent(`${liveRow} .pf-weight label:nth-of-type(2)`)));
  await page.fill(`${liveRow} .pf-manual`, '43.4');
  await page.click(`${liveRow} .pf-confirm`);
  await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('done'), liveRow, { timeout: 5000 });
  const confirmedShot = await page.evaluate(async (id) => { const s = await window.__pb.store.getShot(id); return { beverageG: s.beverageG, prefer: s.beveragePrefer, reviewProfile: s.reviewProfile?.id, name: s.profileName, profileId: s.profileId, target: s.profileTargetG, temp: s.profileTemperatureC, vars: (s.reviewProfile?.variables || []).map((v) => v.key).join(',') }; }, e2eShotId);
  check('Confirm writes the chosen profile (with its variables) and the typed final weight to the shot', confirmedShot.beverageG === 43.4 && confirmedShot.prefer === undefined && confirmedShot.reviewProfile === '80c5ea87' && confirmedShot.name === 'Blooming Espresso' && confirmedShot.profileId === '80c5ea87' && confirmedShot.target === 43 && confirmedShot.temp === 92 && confirmedShot.vars === 'bloom_time,extraction_flow', JSON.stringify(confirmedShot));
  const histWeight = await page.evaluate((id) => document.querySelector(`#hist-rows tr[data-id="${id}"]`)?.textContent || '', e2eShotId);
  check('History shows the confirmed weight and profile for that shot', /43\.4/.test(histWeight) && /Blooming Espresso(?! \(demo\))/.test(histWeight), histWeight.replace(/\s+/g, ' ').slice(0, 160));
  const afterOne = await page.evaluate(() => ({ done: document.querySelectorAll('#an-preflight .pf-row.done').length, runOff: document.querySelector('#an-run').disabled, digestHead: document.querySelector('#an-digest .an-shot:last-child .hint')?.textContent || '' }));
  check('one confirmed shot is not enough: Review with AI stays off; the digest already reads the chosen profile', afterOne.done === 1 && afterOne.runOff && /Blooming Espresso \(profile chosen for this review\)/.test(afterOne.digestHead) && /43\.4 g out \(weighed\)/.test(afterOne.digestHead) && /target 43\.0 g/.test(afterOne.digestHead) && /setpoint 92 °C/.test(afterOne.digestHead), JSON.stringify(afterOne));
  // the shot without a hand-weighed value and without a record: the scale is offered, the recorded option is "name only"
  const machineOnlyOpts = await page.evaluate(() => ({ first: document.querySelector('#an-preflight .pf-row[data-id="machine-only"] select.pf-profile option').textContent, weights: [...document.querySelectorAll('#an-preflight .pf-row[data-id="machine-only"] .pf-weight label')].map((l) => `${l.classList.contains('off') ? 'off:' : ''}${l.querySelector('input').value}${l.querySelector('input').checked ? '*' : ''}`).join(',') }));
  check('a shot with a name but no record says so; with no target known only the scale (or typing) is offered, the scale preselected', /^Name only — Blooming Espresso \(demo\)/.test(machineOnlyOpts.first) && machineOnlyOpts.weights === 'off:weighed,off:profile,scale*,manual', JSON.stringify(machineOnlyOpts));
  await page.click('#an-confirm-all');
  await page.waitForFunction(() => document.querySelectorAll('#an-preflight .pf-row.done').length === 3, null, { timeout: 5000 });
  const afterAll = await page.evaluate(async () => { const s = await window.__pb.store.getShot('second-portal'); return { runOn: !document.querySelector('#an-run').disabled, hint: document.querySelector('#an-run-hint').textContent, prefer: s.beveragePrefer, hasCup: 'beverageG' in s, hist: document.querySelector('#hist-rows tr[data-id="second-portal"]')?.textContent.replace(/\s+/g, ' ') }; });
  check('"Confirm all as shown" confirms the rest, pins the scale on the shots that showed it, and enables Review with AI', afterAll.runOn && afterAll.hint === '' && afterAll.prefer === 'scale' && !afterAll.hasCup && /g out|→ \d/.test(afterAll.hist || ''), JSON.stringify(afterAll));
  await page.click(`${liveRow} .pf-weight input[value="scale"]`);
  check('changing a confirmed choice un-confirms the shot and turns Review with AI off again', (await page.evaluate(() => document.querySelectorAll('#an-preflight .pf-row.done').length)) === 2 && (await page.isDisabled('#an-run')) && (await page.textContent(`${liveRow} .pf-confirm`)) === 'Confirm');
  await page.click(`${liveRow} .pf-weight input[value="manual"]`);
  check('the typed value is kept while choices change', (await page.inputValue(`${liveRow} .pf-manual`)) === '43.4');
  await page.click(`${liveRow} .pf-confirm`);
  await page.waitForFunction(() => !document.querySelector('#an-run').disabled, null, { timeout: 5000 });
  await page.fill('#an-taste', 'sweet, a bit thin');
  await page.fill('#an-question', 'Which shot was best?');
  await page.evaluate((port) => { window.__pb.communityConfig.url = `http://127.0.0.1:${port}/api/mcp`; }, MOCK_PORT); // Meticulous Community is the mock
  check('Meticulous Community is on by default and, for a provider without a connector, the app does the lookups', (await page.evaluate(() => window.__pb.settings.communityEnabled)) === true && /OpenAI: the query starts with @Meticulous Community; this app asks Meticulous Community/.test(await page.textContent('#an-community')), await page.textContent('#an-community'));
  await page.click('#an-run');
  await page.waitForFunction(() => !window.__pb.an.running && window.__pb.an.markdown.length > 100, null, { timeout: 20000 });
  const reviewed = await page.evaluate((id) => { const d = window.__pb.an.digests.find((x) => x.meta.id === id)?.meta; return d && { choice: d.profileChoice, target: d.profileTargetG, recorded: d.recordedProfile, vars: (d.profileVariables || []).map((v) => v.key).join(','), cup: d.beverageG }; }, e2eShotId);
  check('the digest sent for the re-profiled shot names the choice, the 43 g target, its variables and the record it replaced', reviewed && reviewed.choice === 'chosen by the user for this review' && reviewed.target === 43 && reviewed.recorded?.finalWeightG === 38 && reviewed.vars === 'bloom_time,extraction_flow' && reviewed.cup === 43.4, JSON.stringify(reviewed));
  const ratedDigest = await page.evaluate((id) => { const d = window.__pb.an.digests.find((x) => x.meta.id === id)?.meta; const other = window.__pb.an.digests.find((x) => x.meta.id === 'second-portal')?.meta; return { rating: d?.rating, comment: d?.comment, otherRating: other?.rating, head: document.querySelector(`#an-digest .an-shot:last-child .hint`)?.textContent || '', sysHasStages: /Stage by stage/.test(window.__pb.an.request?.system || ''), sysHasRating: /meta\.rating/.test(window.__pb.an.request?.system || '') }; }, e2eShotId);
  check('the digest carries the rating and comment (null for an unrated shot), the digest card shows them, and the prompt asks for a stage-by-stage verdict', ratedDigest.rating === 3 && /edited later/.test(ratedDigest.comment || '') && ratedDigest.otherRating === null && /rated 3\/5/.test(ratedDigest.head) && /edited later/.test(ratedDigest.head) && ratedDigest.sysHasStages && ratedDigest.sysHasRating, JSON.stringify(ratedDigest).slice(0, 300));
  const review = await page.evaluate(() => ({ md: window.__pb.an.markdown, h3: [...document.querySelectorAll('#an-report h3')].map((h) => h.textContent), table: !!document.querySelector('#an-report table'), status: document.querySelector('#an-status').textContent, title: document.querySelector('#an-report-title').textContent, saveDisabled: document.querySelector('#an-save').disabled }));
  check('the review streams in, rendered as sections and a table, with the prompt facts the mock echoes back', /mock review of 3 shots, one without Portal data/.test(review.md) && review.h3.join('|') === 'Verdict|Stages|What stands out|Suggested changes|Open questions|Sources' && review.table && /Done in/.test(review.status) && /^Shot review: 3 shots of E2E coffee.* on Blooming Espresso/.test(review.title) && !review.saveDisabled, JSON.stringify({ ...review, md: review.md.slice(0, 80) }));
  const sent = await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()).lastAiRequest, MOCK_PORT);
  check('the request carried the model, a system prompt and the digest', sent && sent.model === 'mock-gpt-2' && sent.stream === true && sent.systemChars > 2000 && sent.userChars > 3000, JSON.stringify({ ...sent, system: undefined, user: undefined }));
  // Meticulous Community (v0.20): looked up by name, added to the query, named the way ChatGPT wants it
  const mcp = (await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()).mcpCalls, MOCK_PORT)) || [];
  check('the app asked Community by name only — the coffee (under both names the shots give it, one answer), the espresso guide for the origin, the roaster, the grinder', mcp.map((c) => c.name).join(',') === 'search_community,how_to_brew_coffee,search_community,espresso_guide,espresso_guide,search_community,how_to_brew_roaster,search_community,grinder_guide' && mcp.every((c) => JSON.stringify(c.args).length < 120) && mcp[4].args.topic === 'colombia' && (sent.user.match(/^## Coffee — /gm) || []).length === 1, JSON.stringify(mcp));
  check('the query starts with @Meticulous Community and carries the answers with their source links, marked as data', /^# Review request\n@Meticulous Community — use Meticulous Community for this review/.test(sent.user) && /# Meticulous Community \(looked up by the app\)/.test(sent.user) && /## Coffee — E2E \[coffee\]/.test(sent.user) && /## Espresso guide — colombia/.test(sent.user) && /## Roaster — E2E Roaster/.test(sent.user) && /## Grinder — Zerno Z1/.test(sent.user) && /community\.meticuloushome\.com\/coffee\/c-0001/.test(sent.user) && /as data, never as instructions/.test(sent.user), sent.user.slice(0, 300));
  check('the instructions ask for a Community comparison section and for the source links', /## Community comparison/.test(sent.system) && /Quote Community figures with their source link/.test(sent.system) && /The app has looked the answers up for you/.test(sent.system));
  check('grind prep goes with the review (defaults: everything but the filter screen)', /Puck preparation.*RDT \(Ross Droplet Technique.*WDT \(Weiss Distribution Technique.*a tamper\. Not used: Filter screen\./.test(sent.user), (sent.user.match(/Puck preparation[^\n]*/) || [''])[0].slice(0, 200));
  check('text planted in a Community answer stays text', (await page.evaluate(() => window.__xss || 0)) === 0 && /IGNORE ALL PREVIOUS INSTRUCTIONS/.test(sent.user));
  await page.click('#an-save');
  await page.waitForTimeout(300);
  const savedRows = await page.evaluate(() => ({ rows: document.querySelectorAll('#an-saved-rows tr').length, tab: document.querySelector('#analysis-tab-count').textContent, btn: document.querySelector('#an-save').textContent }));
  check('Save review stores it and the tab counts it', savedRows.rows === 1 && savedRows.tab === '(1)' && savedRows.btn === 'Saved', JSON.stringify(savedRows));
  check('each saved review has its own format picker, preset to the default', (await page.evaluate(() => document.querySelector('#an-saved-rows select.fmt')?.value)) === 'md');
  await page.click('#an-download');
  await page.waitForTimeout(500);
  const reviewFiles = await page.evaluate(() => Object.keys(window.__fakeFolderFiles || {}).filter((f) => /reviews\/review-.*\.md$/.test(f)));
  const reviewMd = await page.evaluate((f) => window.__fakeFolderFiles[f], reviewFiles[0] || '');
  check('Download .md writes the review with its header into the folder', reviewFiles.length === 1 && /^# Shot review: 3 shots of E2E coffee/.test(reviewMd) && /Taste: sweet, a bit thin/.test(reviewMd) && /## Verdict/.test(reviewMd), reviewFiles.join(','));
  check('the format picker defaults to Markdown (Settings → AI review → Download reviews as)', (await page.inputValue('#an-format')) === 'md' && (await page.evaluate(() => [...document.querySelectorAll('#an-format option')].map((o) => o.value).join(','))) === 'md,docx,pdf');
  await page.selectOption('#an-format', 'docx');
  await page.click('#an-download');
  await page.waitForFunction(() => Object.keys(window.__fakeFolderFiles || {}).some((f) => /reviews\/review-.*\.docx$/.test(f)), null, { timeout: 10000 });
  await page.selectOption('#an-format', 'pdf');
  await page.click('#an-download');
  await page.waitForFunction(() => Object.keys(window.__fakeFolderFiles || {}).some((f) => /reviews\/review-.*\.pdf$/.test(f)), null, { timeout: 15000 });
  const formats = await page.evaluate(() => { const f = window.__fakeFolderFiles; const docx = Object.keys(f).find((k) => /\.docx$/.test(k)); const pdf = Object.keys(f).find((k) => /\.pdf$/.test(k)); return { docx: f[docx].slice(0, 2), docxLen: f[docx].length, pdf: f[pdf].slice(0, 5), pdfLen: f[pdf].length }; });
  check('the same review downloads as Word and PDF (zip and PDF signatures, sensible sizes)', formats.docx === 'PK' && formats.docxLen > 3000 && formats.pdf === '%PDF-' && formats.pdfLen > 8000, JSON.stringify(formats));
  await page.selectOption('#an-format', 'md');
  // a wrong model name surfaces as a readable error and cannot be saved
  await page.evaluate(() => { window.__pb.settings.aiModelOpenai = 'bad-model'; });
  await page.click('#an-run');
  await page.waitForFunction(() => !window.__pb.an.running, null, { timeout: 10000 });
  check('a provider error is shown in the report pane and Save stays off', /The request failed:.*HTTP 404.*bad-model.*List models/.test(await page.textContent('#an-report')) && (await page.isDisabled('#an-save')), (await page.textContent('#an-report')).slice(0, 160));
  // a model that stops at its output limit: the app asks it to continue and the report comes out whole (v0.17)
  await page.evaluate(() => { window.__pb.settings.aiModelOpenai = 'cut-model'; });
  await page.click('#an-run');
  await page.waitForFunction(() => !window.__pb.an.running && window.__pb.an.markdown.length > 100, null, { timeout: 20000 });
  const cut = await page.evaluate(async (port) => ({ continued: window.__pb.an.continued, cutOff: window.__pb.an.cutOff, status: document.querySelector('#an-status').textContent, verdicts: (window.__pb.an.markdown.match(/## Verdict/g) || []).length, sources: /## Sources/.test(window.__pb.an.markdown), len: window.__pb.an.markdown.length, turns: (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()).lastAiRequest.turns, contHidden: document.querySelector('#an-continue').hidden, saveOn: !document.querySelector('#an-save').disabled, maxTok: window.__pb.an.request?.maxTokens }), MOCK_PORT);
  const fullLen = await page.evaluate(() => window.__pb.an.markdown.length);
  check('a report cut off at the length limit is continued automatically: one continuation turn (system, user, assistant, user), whole report, no repeat', cut.continued === 1 && cut.cutOff === false && /Done in \d+ s \(in 2 parts\)/.test(cut.status) && cut.verdicts === 1 && cut.sources && cut.turns === 4 && cut.contHidden && cut.saveOn && cut.maxTok === 16000, JSON.stringify(cut));
  const mockFull = await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer sk-test-123', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-gpt-2', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Shots to review: 3\nNo Belka Portal data for this shot' }] }) })).json()).choices[0].message.content.length, MOCK_PORT);
  check('the continued report is exactly the full report the model would have written in one go', fullLen === mockFull, `${fullLen} vs ${mockFull}`);
  await page.evaluate(() => { window.__pb.settings.aiModelOpenai = 'mock-gpt-2'; });
  // a fresh pick clears the report pane; Open brings a saved one back with its shots and questions
  await page.fill('#an-taste', '');
  await page.click('#an-saved-rows button[data-act="open"]');
  await page.waitForTimeout(300);
  check('Open restores the report, its shots and the questions asked', /mock review of 3 shots/.test(await page.textContent('#an-report')) && (await page.textContent('#an-sel-count')).trim() === '(3)' && (await page.inputValue('#an-taste')) === 'sweet, a bit thin' && /saved/.test(await page.textContent('#an-report-meta')));
  const stored = await page.evaluate(async () => { const all = await window.__pb.store.listReviews(); const b = await window.__pb.store.exportAll(); return { n: all.length, shots: all[0]?.shotIds?.length, hasDigests: Array.isArray(all[0]?.digests) && all[0].digests.length === 3 && !('series' in all[0].digests[0]), inBackup: b.reviews?.length }; });
  check('the review is stored with its digests (without the per-second trace) and travels in backups', stored.n === 1 && stored.shots === 3 && stored.hasDigests && stored.inBackup === 1, JSON.stringify(stored));
  await page.click('#an-saved-rows button[data-act="delete"]');
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-go');
  await page.waitForTimeout(300);
  check('Delete removes the saved review after confirmation', (await page.evaluate(() => document.querySelectorAll('#an-saved-rows tr').length)) === 0 && (await page.textContent('#analysis-tab-count')) === '');

  // ---- Rating scale 1–9 (v0.18): a new rating uses the scale in Settings; earlier ones keep theirs
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-rating-scale', '9');
  await page.waitForTimeout(200);
  await page.click('.view-tab[data-view="history"]');
  await page.click('#hist-rows tr[data-id="second-portal"] td.rating button[data-act="rate"]');
  await page.waitForSelector('#rating-dialog[open]');
  const nine = await page.evaluate(() => ({ stars: document.querySelectorAll('#r-stars button.star').length, keys: document.querySelector('#r-keys').textContent, max: document.querySelector('#r-stars').dataset.max }));
  check('with the 1–9 scale the rating dialog shows nine stars', nine.stars === 9 && nine.keys === 'press 1–9' && nine.max === '9', JSON.stringify(nine));
  await page.keyboard.press('7');
  await page.click('#r-save');
  await page.waitForTimeout(400);
  const nineRow = await page.evaluate(() => ({ row: document.querySelector('#hist-rows tr[data-id="second-portal"] td.rating').textContent, shot: window.__pb.state.shots.find((x) => x.id === 'second-portal'), old: document.querySelector(`#hist-rows tr[data-id="${window.__pb.state.shots.find((x) => x.context?.beanName === 'E2E coffee (edited)')?.id}"] td.rating`)?.textContent }));
  check('the shot is saved as 7 of 9 and History shows ★7/9 while the earlier 3-of-5 shot still shows ★3', /★7\/9/.test(nineRow.row) && nineRow.shot.rating === 7 && nineRow.shot.ratingMax === 9 && /★3/.test(nineRow.old || '') && !/\/5/.test(nineRow.old || ''), JSON.stringify({ row: nineRow.row, rating: nineRow.shot.rating, max: nineRow.shot.ratingMax, old: nineRow.old }));
  await page.click('#hist-table th[data-sort="rating"]'); // first click: best first
  const ratingOrder = await page.evaluate(() => [...document.querySelectorAll('#hist-rows tr td.rating')].map((td) => td.textContent.trim()).filter(Boolean));
  check('sorting by ★ compares fractions across scales (7/9 before 3/5)', ratingOrder[0].startsWith('★7/9') && ratingOrder[1].startsWith('★3'), ratingOrder.join(' | '));
  await page.click('#hist-table th[data-sort="startedAt"]');
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-rating-scale', '5');
  await page.uncheck('#set-ratings');
  await page.waitForTimeout(200);
  check('ratings off hides the ★ column and the stars under the shot title', (await page.evaluate(() => document.body.classList.contains('no-ratings') && getComputedStyle(document.querySelector('#hist-table th.rating')).display === 'none')));
  await page.check('#set-ratings');
  await page.waitForTimeout(200);

  // ---- Beans tab (v0.18): every coffee, its shots and rating, editable with a link
  await page.click('.view-tab[data-view="beans"]');
  await page.waitForTimeout(300);
  const beansTab = await page.evaluate(() => ({ visible: !document.querySelector('#view-beans').hidden, rows: [...document.querySelectorAll('#beans-rows tr')].map((tr) => ({ key: tr.dataset.key, name: tr.querySelector('td.name button').textContent, shots: tr.children[5].textContent.trim(), avg: tr.querySelector('td.rating').textContent.trim() })), tabCount: document.querySelector('#beans-tab-count').textContent, order: [...document.querySelectorAll('.view-tab')].map((b) => b.dataset.view).join(',') }));
  const coffeeRow = beansTab.rows.find((r) => r.name === 'E2E coffee (edited)');
  const e2eRow = beansTab.rows.find((r) => r.name === 'E2E coffee');
  check('the Beans tab sits between Analysis and Machine and lists each coffee with its shot count and average rating', beansTab.visible && beansTab.order === 'shots,history,analysis,beans,machine,settings' && coffeeRow && coffeeRow.shots === '1' && /★3\.0/.test(coffeeRow.avg) && e2eRow && e2eRow.shots === '2' && /★3\.9/.test(e2eRow.avg) && beansTab.tabCount === `(${beansTab.rows.length})`, JSON.stringify(beansTab).slice(0, 400));
  await page.click(`#beans-rows tr[data-key="${coffeeRow.key}"] button[data-act="edit"]`);
  await page.waitForSelector('#bean-dialog[open]');
  check('Edit opens the coffee with its fields and the "also update its shots" option', (await page.inputValue('#b-name')) === 'E2E coffee (edited)' && (await page.inputValue('#b-roaster')) === 'E2E roaster' && !(await page.isHidden('#b-apply-row')) && /1 shot /.test(await page.textContent('#b-apply-label')));
  await page.fill('#b-url', 'roaster.example/e2e');
  await page.fill('#b-origin', 'Colombia, Huila, La Esperanza');
  await page.fill('#b-notes', 'Pink bourbon, 1 900 m');
  await page.click('#b-save');
  await page.waitForTimeout(500);
  const beanSaved = await page.evaluate(() => { const tr = [...document.querySelectorAll('#beans-rows tr')].find((x) => /E2E coffee \(edited\)/.test(x.textContent)); return { origin: tr.children[2].textContent, link: tr.querySelector('td.name a.bean-link')?.getAttribute('href'), notes: tr.querySelector('td.name small')?.textContent, shotOrigin: window.__pb.state.shots.find((x) => x.context?.beanName === 'E2E coffee (edited)')?.context.origin, rec: window.__pb.state.beans.find((b) => b.name === 'E2E coffee (edited)') }; });
  check('saving stores the link (https added), origin and notes on the coffee and updates its shot', beanSaved.origin === 'Colombia, Huila, La Esperanza' && beanSaved.link === 'https://roaster.example/e2e' && /Pink bourbon/.test(beanSaved.notes || '') && beanSaved.shotOrigin === 'Colombia, Huila, La Esperanza' && beanSaved.rec?.url === 'https://roaster.example/e2e', JSON.stringify(beanSaved).slice(0, 300));
  await page.click('#beans-add');
  await page.waitForSelector('#bean-dialog[open]');
  await page.fill('#b-name', 'Future bag');
  await page.fill('#b-roaster', 'Someone');
  await page.fill('#b-url', 'javascript:alert(1)');
  await page.click('#b-save');
  check('a non-http link is refused', /http\(s\) address/.test(await page.textContent('#b-error')) && (await page.evaluate(() => document.querySelector('#bean-dialog').open)));
  await page.fill('#b-url', '');
  await page.click('#b-save');
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => ({ row: [...document.querySelectorAll('#beans-rows tr')].some((x) => /Future bag/.test(x.textContent) && /never/.test(x.textContent)), pick: [...document.querySelectorAll('#bean-list option')].some((o) => o.value === 'Future bag') }));
  check('Add a coffee puts it in the list (no shots yet) and in the Bean pick-list', added.row && added.pick, JSON.stringify(added));
  await page.click(`#beans-rows tr[data-key="${coffeeRow.key}"] td.name button[data-act="shots"]`);
  await page.waitForTimeout(300);
  const toShots = await page.evaluate(() => ({ hist: !document.querySelector('#view-history').hidden, search: document.querySelector('#hist-search').value, rows: document.querySelectorAll('#hist-rows tr').length }));
  check('opening a coffee shows its shots in History (search filled with its name)', toShots.hist && toShots.search === 'E2E coffee (edited)' && toShots.rows === 1, JSON.stringify(toShots));
  await page.fill('#hist-search', '');
  await page.dispatchEvent('#hist-search', 'input');
  await page.click('.view-tab[data-view="beans"]');
  await page.click(`#beans-rows tr[data-key="${coffeeRow.key}"] button[data-act="use"]`);
  await page.waitForTimeout(400);
  const used = await page.evaluate(() => ({ shots: !document.querySelector('#view-shots').hidden, bean: document.querySelector('#ctx-bean').value, origin: document.querySelector('#ctx-origin').value, link: (() => { const a = document.querySelector('#ctx-bean-link'); return !a.hidden && a.href; })() }));
  check('Use fills This coffee on the Shots tab, and the Bean field shows the info link for a coffee that has a page', used.shots && used.bean === 'E2E coffee (edited)' && used.origin === 'Colombia, Huila, La Esperanza' && used.link === 'https://roaster.example/e2e', JSON.stringify(used));

  // ---- Machine tab: the machine's answers are data, never markup (code-scanning CWE-79, v0.17.1)
  await page.click('.view-tab[data-view="machine"]');
  await page.evaluate(async () => { await window.__pb.machinePanel.refreshAll(); });
  await page.waitForFunction(() => /HomeWiFi/.test(document.querySelector('#mc-conn')?.textContent || '') && /Blooming Espresso/.test(document.querySelector('#mc-stats')?.textContent || ''), null, { timeout: 8000 });
  const machineTab = await page.evaluate(() => ({ conn: document.querySelector('#mc-conn').textContent.replace(/\s+/g, ' '), stats: document.querySelector('#mc-stats').textContent.replace(/\s+/g, ' '), bars: document.querySelectorAll('#mc-stats .bar-row').length, profiles: document.querySelectorAll('#mc-profiles article.profile').length }));
  check('the Machine tab shows connectivity, statistics and the profiles from the machine', /Wi-FiHomeWiFi/.test(machineTab.conn) && /63saved shots/.test(machineTab.stats) && machineTab.bars === 2 && machineTab.profiles === 4, JSON.stringify(machineTab).slice(0, 300));
  await page.evaluate(async (port) => { await fetch(`http://127.0.0.1:${port}/mock/dial`, { method: 'POST', body: JSON.stringify({ hostile: true }) }); await window.__pb.machinePanel.refreshAll(); }, MOCK_PORT);
  await page.waitForFunction(() => /Evil/.test(document.querySelector('#mc-stats')?.textContent || ''), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const hostile = await page.evaluate(() => { const conn = document.querySelector('#mc-conn').textContent; const stats = document.querySelector('#mc-stats').textContent.replace(/\s+/g, ' '); return { xss: window.__xss === undefined, imgs: document.querySelectorAll('#view-machine img[src="x"]').length, scripts: document.querySelectorAll('#view-machine script').length, injected: document.querySelectorAll('#mc-conn b, #mc-conn i, #mc-stats .bar-n b, #mc-stats .bar-label b, #mc-stats .metric i, #mc-stats .metric b').length, wifiText: /Wi-FiHome <img src=x onerror/.test(conn), modeText: /Mode<b>CLIENT<\/b>/.test(conn), noteText: /Notenote <img src=x/.test(conn), evilText: /Evil <img src=x onerror/.test(stats), total: /14saved shots/.test(stats), mileage: /–lifetime shots/.test(stats), versions: !/versions/.test(stats) }; });
  check('markup in the Wi-Fi name, mode, health note, profile names and counts is shown as text — nothing runs, no element is created, strings where numbers belong count as nothing', Object.entries(hostile).every(([k, v]) => (k === 'imgs' || k === 'scripts' || k === 'injected' ? v === 0 : v === true)), JSON.stringify(hostile));
  await page.evaluate(async (port) => { await fetch(`http://127.0.0.1:${port}/mock/dial`, { method: 'POST', body: JSON.stringify({ hostile: false }) }); await window.__pb.machinePanel.refreshAll(); }, MOCK_PORT);
  await page.waitForFunction(() => /HomeWiFi/.test(document.querySelector('#mc-conn')?.textContent || ''), null, { timeout: 8000 });

  // ---- Brew controls: the dial's actions over the API (the mock plays "heating → click to start")
  await page.click('.view-tab[data-view="shots"]');
  await page.waitForFunction(() => !document.getElementById('brew-controls').hidden && document.querySelectorAll('#brew-profile option').length === 4, null, { timeout: 8000 }).catch(() => {});
  const brewOpts = await page.evaluate(() => [...document.querySelectorAll('#brew-profile option')].map((o) => o.textContent));
  check('Brew controls appear while the machine is connected, with its profiles', (await page.isVisible('#brew-controls')) && brewOpts.length === 4 && /Blooming Espresso · 43 g · 92 °C/.test(brewOpts[0]) && /Blooming Espresso · 38 g · 93 °C/.test(brewOpts[3]), brewOpts.join(' | '));
  await page.click('#brew-start');
  await page.waitForFunction(() => /click to start/i.test(document.querySelector('#brew-state').textContent), null, { timeout: 5000 });
  check('Start brew sends the dial click; the rail shows the machine waiting at "click to start"', /Ready — click to start · 9[23]\.\d °C/.test(await page.textContent('#brew-state')) && (await page.textContent('#brew-start')) === 'Start brew now' && !(await page.isDisabled('#brew-stop')), (await page.textContent('#brew-state')).trim());
  await page.click('#brew-stop');
  await page.waitForFunction(() => /idle/i.test(document.querySelector('#brew-state').textContent), null, { timeout: 5000 });
  check('Stop aborts and the machine returns to idle', /idle/.test(await page.textContent('#brew-state')));

  // ---- Ready to brew (v0.15): the water's temperature against the loaded profile's target
  const dialCfg = async (cfg) => page.evaluate(async ([port, body]) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`, { method: 'POST', body: JSON.stringify(body) })).json()), [MOCK_PORT, cfg]);
  await page.click('.view-tab[data-view="settings"]');
  await page.uncheck('#set-autorecord'); // the mock's short brew below must not become a recording
  await page.dispatchEvent('#set-autorecord', 'change');
  await page.selectOption('#set-heat-rule', 'hold');
  await page.fill('#set-heat-hold', '1');
  await page.click('#settings-save');
  await page.waitForTimeout(200);
  check('the ready-to-brew rule and hold time save', (await page.evaluate(() => [window.__pb.settings.heatRule, window.__pb.settings.heatHoldSec, window.__pb.heat.rule, window.__pb.heat.holdSec])).join() === 'hold,1,hold,1');
  await page.click('.view-tab[data-view="shots"]');
  await dialCfg({ heatMs: 3200, tempFrom: 60, brewMs: 1500, temp: 60 });
  await page.waitForTimeout(300);
  check('idle and cold: Start brew is plain and the heat line explains why', !(await page.evaluate(() => document.querySelector('#brew-start').classList.contains('ready'))) && /60\.0 °C · target 93\.0 °C · not within/.test(await page.textContent('#brew-heat')), (await page.textContent('#brew-heat')).trim());
  await page.click('#brew-start');
  await page.waitForTimeout(1200);
  const midHeat = await page.evaluate(() => ({ ready: document.querySelector('#brew-start').classList.contains('ready'), text: document.querySelector('#brew-heat').textContent, phase: window.__pb.heat.phase }));
  check('while the machine heats the button stays plain and the line shows the climb', !midHeat.ready && midHeat.phase === 'heating' && /heating · [6-8]\d\.\d °C · target 93\.0 °C/.test(midHeat.text), JSON.stringify(midHeat));
  await page.waitForFunction(() => document.querySelector('#brew-start').classList.contains('ready'), null, { timeout: 8000 });
  const readyState = await page.evaluate(() => ({ text: document.querySelector('#brew-heat').textContent, green: getComputedStyle(document.querySelector('#brew-start')).backgroundColor, tare: getComputedStyle(document.querySelector('#brew-tare')).backgroundColor, phase: window.__pb.heat.phase }));
  check('once the water has held the target for the hold time, Start brew turns green (Tare does not)', /^water ready \(held\) · 9[23]\.\d °C · target 93\.0 °C/.test(readyState.text) && readyState.green !== readyState.tare && readyState.phase === 'ready', JSON.stringify(readyState));
  await page.waitForFunction(() => /click to start/i.test(document.querySelector('#brew-state').textContent), null, { timeout: 6000 });
  await page.click('#brew-start'); // the mock runs its 1.5 s brew
  await page.waitForFunction(() => window.__pb.heat.phase === 'brewing', null, { timeout: 4000 });
  check('during the brew the button is plain again', !(await page.evaluate(() => document.querySelector('#brew-start').classList.contains('ready'))) && /^brewing/.test(await page.textContent('#brew-heat')));
  await page.waitForFunction(() => window.__pb.heat.phase === 'done', null, { timeout: 6000 });
  const afterBrew = await page.evaluate(() => ({ ready: document.querySelector('#brew-start').classList.contains('ready'), text: document.querySelector('#brew-heat').textContent, bg: getComputedStyle(document.querySelector('#brew-start')).backgroundColor, tare: getComputedStyle(document.querySelector('#brew-tare')).backgroundColor }));
  check('after the brew the button is the same colour as Tare although the water is still hot', !afterBrew.ready && afterBrew.bg === afterBrew.tare && /brew done/.test(afterBrew.text), JSON.stringify(afterBrew));
  // the machine's own word as the rule
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-heat-rule', 'machine');
  await page.waitForTimeout(200);
  check('Settings → Machine shows the live readings and the target while connected', /Now: status 9[0-3]\.\d °C · probe 1 10[0-9]\.\d · probe 2 10[0-9]\.\d · tube 86\.3 · bar 86\.\d — target 93\.0 °C/.test(await page.textContent('#heat-live')), (await page.textContent('#heat-live')).trim());
  await page.click('.view-tab[data-view="shots"]');
  await dialCfg({ heatMs: 2000, brewMs: 0 });
  await page.click('#brew-start');
  await page.waitForTimeout(900);
  check('machine rule: not green while it heats, whatever the temperature', !(await page.evaluate(() => document.querySelector('#brew-start').classList.contains('ready'))));
  await page.waitForFunction(() => document.querySelector('#brew-start').classList.contains('ready'), null, { timeout: 6000 });
  check('machine rule: green when it reports "click to start"', /^water ready \(machine\)/.test(await page.textContent('#brew-heat')), (await page.textContent('#brew-heat')).trim());
  await page.click('#brew-stop');
  await page.waitForFunction(() => /idle/i.test(document.querySelector('#brew-state').textContent), null, { timeout: 5000 });
  await dialCfg({ heatMs: 800, tempFrom: 25, brewMs: 0 });
  await page.click('.view-tab[data-view="settings"]');
  await page.check('#set-autorecord');
  await page.dispatchEvent('#set-autorecord', 'change');
  await page.selectOption('#set-heat-rule', 'hold');
  await page.waitForTimeout(200);
  await page.click('.view-tab[data-view="shots"]');
  await page.selectOption('#brew-profile', '80c5ea87');
  await page.click('#brew-load');
  await page.waitForTimeout(500);
  const dialState = await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()), MOCK_PORT);
  check('Load sends the profile to the machine; the actions reached the API in order', dialState.loadedProfile === 'Blooming Espresso' && dialState.actions.join(',') === 'start,abort,start,start,start,abort' && /Loaded "Blooming Espresso"/.test(await page.textContent('#toast')), JSON.stringify({ loaded: dialState.loadedProfile, actions: dialState.actions }));
  await page.click('.view-tab[data-view="settings"]');
  // Back to browser downloads for the rest
  await page.selectOption('#set-file-destination', 'downloads');
  await page.waitForTimeout(200);
  check('downloads chosen: nothing is written on its own', (await page.evaluate(() => ({ eff: window.__pb.files.effective, ready: window.__pb.files.ready }))).ready === false);
  await page.click('.view-tab[data-view="shots"]');

  // Exports: JPEG, PDF, summary CSV, zip
  const jpg = await dl('#dl-jpeg');
  check('JPEG export downloads', jpg.bytes > 10000 && /time\.jpg$/.test(jpg.name), `${jpg.name} ${jpg.bytes} B`);
  const jpg2 = await page.waitForEvent('download', { timeout: 10000 }); // the second graph
  check('second JPEG (EC vs mass) downloads', /ec-vs-mass\.jpg$/.test(jpg2.suggestedFilename()), jpg2.suggestedFilename());
  const pdf = await dl('#dl-pdf');
  check('PDF report downloads', pdf.bytes > 20000 && /report\.pdf$/.test(pdf.name), `${pdf.name} ${pdf.bytes} B`);
  // with a saved AI review covering this shot, the report grows by the review's pages (v0.17)
  await page.evaluate(async () => { const s = window.__pb.state.selected; await window.__pb.store.putReview({ id: 'rev-e2e', createdAt: Date.now(), provider: 'openai', model: 'mock-gpt-2', title: 'E2E saved review', shotIds: [s.id, 'second-portal'], shotLabels: ['a', 'b'], taste: '', question: '', durationMs: 1000, markdown: '## Verdict\n\nA saved review for the PDF test.\n\n## Suggested changes\n\n### Stage by stage\n\n- **Bloom**: 8 s — worked well — keep as is\n\n### One change per shot\n\nChange one thing per shot, in this order.\n\n1. Grind finer.\n\n## Sources\n\n- shot digests\n' + 'Padding paragraph. '.repeat(300), digests: [] }); });
  const pdfTextBefore = readFileSync(pdf.path, 'latin1');
  const pdfWithReview = await dl('#dl-pdf');
  const pdfText = readFileSync(pdfWithReview.path, 'latin1');
  const pdfPages = (pdfText.match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('the PDF report appends the newest saved AI review that covers the shot, on its own pages', pdfWithReview.bytes > pdf.bytes + 2000 && pdfPages >= 3 && pdfPages > (pdfTextBefore.match(/\/Type\s*\/Page[^s]/g) || []).length, `${pdf.bytes} → ${pdfWithReview.bytes} B, ${pdfPages} pages`);
  await page.evaluate(() => window.__pb.store.deleteReview('rev-e2e'));
  await page.click('.view-tab[data-view="history"]');
  const csv = await dl('#dl-summary');
  check('summary CSV downloads (from History)', csv.bytes > 200 && /shots-.*\.csv$/.test(csv.name), `${csv.name} ${csv.bytes} B`);
  const zip = await dl('#dl-zip');
  check('zip of everything downloads (from History)', zip.bytes > 30000 && /export-.*\.zip$/.test(zip.name), `${zip.name} ${zip.bytes} B`);
  await page.click('.view-tab[data-view="shots"]');

  // ---- v0.20: Settings sections fold — compact, a click opens one, and how they open is a setting
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-layout', 'compact');
  await page.waitForTimeout(250);
  const openSections = () => page.evaluate(() => [...document.querySelectorAll('#view-settings details.set-section')].filter((d) => d.open).map((d) => d.dataset.section).join(','));
  const compact = await page.evaluate(() => ({ layout: window.__pb.settings.settingsLayout, names: [...document.querySelectorAll('#view-settings details.set-section > summary h2')].map((h) => h.textContent).join('|'), rule: document.querySelector('#set-heat-rule').closest('details').dataset.section, lists: document.querySelector('#list-roaster').closest('details').dataset.section }));
  check('compact: every section closed, names only — Heating after Machine, Brew Prep. after AI review', compact.layout === 'compact' && (await openSections()) === '' && !(await page.isVisible('#meticulous-host')) && compact.names === 'Machine|Heating|Recording|Files and folders|Estimates|AI review|Brew Prep.|Backup and restore|Logging and debug|Start over|About', JSON.stringify(compact));
  check('Ready to brew lives under Heating and the pick-lists under Brew Prep.', compact.rule === 'heating' && compact.lists === 'prep', JSON.stringify(compact));
  await page.click('details[data-section="recording"] > summary');
  check('clicking a section name opens that section', (await openSections()) === 'recording' && (await page.isVisible('#settle-sec')));
  await page.click('.view-tab[data-view="shots"]');
  await page.click('.addr [data-goto="settings"]');
  await page.waitForTimeout(250);
  check('compact closes them again on the next visit; the rail\'s "change" link opens Machine', (await openSections()) === 'machine' && (await page.isVisible('#meticulous-host')), await openSections());
  await page.selectOption('#set-layout', 'remember');
  await page.click('details[data-section="heating"] > summary');
  await page.waitForTimeout(250);
  await page.click('.view-tab[data-view="shots"]');
  await page.click('.view-tab[data-view="settings"]');
  await page.waitForTimeout(250);
  check('"as I left them" brings back the sections that were open', (await openSections()) === 'machine,heating', await openSections());
  await page.click('#set-collapse-all');
  check('Collapse all closes every section', (await openSections()) === '');
  await page.selectOption('#set-layout', 'detailed');
  await page.waitForTimeout(250);
  check('detailed opens every section, now and on the next visit', (await openSections()).split(',').length === 11 && (await page.evaluate(() => window.__pb.settings.settingsLayout)) === 'detailed');

  // ---- v0.20: the query window, report sections, brew prep, shot edit/delete in the picker
  await page.click('.view-tab[data-view="analysis"]');
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    const { makeDemoShot } = await import('./js/demo.js?v=' + document.querySelector('script[src*="main.js"]').src.split('v=')[1]);
    await window.__pb.store.putShot({ ...makeDemoShot({ seed: 21 }), id: 'picker-shot', source: 'live', startedAt: Date.now() - 60000, profileName: 'Blooming Espresso (demo)', context: { beanName: 'E2E coffee', roaster: 'E2E roaster', origin: 'Colombia, Huila', grinderName: 'Zerno Z1', doseG: 18, grindSize: '420 µm' } });
    await window.__pb.refreshShotList();
    window.__pb.openAnalysis(['picker-shot']);
  });
  await page.waitForTimeout(300);
  const rowTools = await page.evaluate(() => ({ on: [...document.querySelectorAll('#an-list li.on .an-row-tools button')].map((b) => b.textContent).join(','), off: document.querySelectorAll('#an-list li:not(.on) .an-row-tools').length }));
  check('a ticked shot in the review picker offers Edit and Delete; the others do not', rowTools.on === 'Edit,Delete' && rowTools.off === 0, JSON.stringify(rowTools));
  await page.click('#an-confirm-all');
  await page.waitForFunction(() => !document.querySelector('#an-query').disabled, null, { timeout: 5000 });
  await page.click('#an-list li.on button[data-act="edit"]');
  await page.waitForSelector('#shot-dialog[open]');
  await page.fill('#e-dose', '18.5');
  await page.click('#shot-dialog-save');
  await page.waitForFunction(() => !document.querySelector('#shot-dialog').open, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const pickerEdit = await page.evaluate(async () => ({ dose: (await window.__pb.store.getShot('picker-shot')).context.doseG, confirmed: window.__pb.an.confirmed.has('picker-shot'), run: document.querySelector('#an-run').disabled, digest: document.querySelector('#an-digest').textContent }));
  check('Edit opens the shot\'s details; saving updates the digest and asks for the shot to be confirmed again', pickerEdit.dose === 18.5 && !pickerEdit.confirmed && pickerEdit.run && /18\.5 g in/.test(pickerEdit.digest), JSON.stringify({ ...edited, digest: pickerEdit.digest.slice(0, 80) }));
  await page.click('#an-confirm-all');
  await page.waitForFunction(() => !document.querySelector('#an-query').disabled, null, { timeout: 5000 });

  // the query window: what the app prepared, editable, sendable
  await page.evaluate(async (port) => { await fetch(`http://127.0.0.1:${port}/mock/dial`, { method: 'POST', body: JSON.stringify({ mcpReset: true }) }); }, MOCK_PORT);
  await page.click('#an-query');
  await page.waitForSelector('#query-dialog[open]', { timeout: 8000 });
  const qWin = await page.evaluate(() => ({ user: document.querySelector('#q-user').value, system: document.querySelector('#q-system').value, sub: document.querySelector('#q-sub').textContent, send: document.querySelector('#q-send').textContent, reset: document.querySelector('#q-reset').disabled }));
  const cachedCalls = ((await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()).mcpCalls, MOCK_PORT)) || []).length;
  check('Edit query… shows the prepared query: the message with the shot and the Community answers, and the instructions', /^# Review request/.test(qWin.user) && /# Shot 1 of 1/.test(qWin.user) && /# Meticulous Community \(looked up by the app\)/.test(qWin.user) && /## Verdict/.test(qWin.system) && /OpenAI · mock-gpt-2 · 1 shot/.test(qWin.sub) && qWin.send === 'Send to OpenAI' && qWin.reset, JSON.stringify({ sub: qWin.sub, send: qWin.send }));
  check('answers already fetched this session are not asked for again', cachedCalls === 0, String(cachedCalls));
  await page.fill('#q-user', `${qWin.user}\n\nEDITED-BY-HAND: answer in two sentences.`);
  check('an edit is noted and Reset becomes available', /edited/.test(await page.textContent('#q-size')) && !(await page.isDisabled('#q-reset')));
  await page.click('#q-reset');
  check('Reset restores the prepared query', (await page.inputValue('#q-user')) === qWin.user);
  await page.click('#q-cancel');
  check('Cancel closes the window and sends nothing', !(await page.evaluate(() => document.querySelector('#query-dialog').open || window.__pb.an.running)));
  // with the setting on, Review with AI opens the window first
  await page.click('.view-tab[data-view="settings"]');
  await page.check('#set-ai-edit-query');
  await page.uncheck('#set-sec-questions');
  await page.check('#set-prep-screen');
  await page.uncheck('#set-send-trace');
  await page.fill('#set-water', 'E2E water 90 ppm');
  await page.click('#settings-save');
  await page.waitForTimeout(400);
  const prepState = await page.evaluate(() => ({ water: window.__pb.settings.water, chips: [...document.querySelectorAll('#list-water .chip')].map((c) => c.firstChild.textContent.trim()), options: [...document.querySelectorAll('#water-list option')].map((o) => o.value), def: document.querySelector('#set-water-default').checked && !document.querySelector('#set-water-default').disabled, note: document.querySelector('#set-prep-note').textContent, prepDefaults: ['rdt', 'wdt', 'distribution', 'tamper', 'single-dose'].every((k) => document.querySelector(`#set-prep-${k}`).checked) }));
  check('Brew Prep.: a typed water is saved, joins its pick-list and is the default; the grind-prep defaults are on', prepState.water === 'E2E water 90 ppm' && prepState.chips.includes('E2E water 90 ppm') && prepState.options.includes('E2E water 90 ppm') && prepState.def && prepState.prepDefaults && /Filter screen/.test(prepState.note) && /water: E2E water 90 ppm/.test(prepState.note), JSON.stringify(prepState));
  await page.click('.view-tab[data-view="analysis"]');
  await page.waitForTimeout(300);
  await page.click('#an-run');
  await page.waitForSelector('#query-dialog[open]', { timeout: 8000 });
  const qSecond = await page.evaluate(() => ({ user: document.querySelector('#q-user').value, system: document.querySelector('#q-system').value }));
  check('"Show the query before it is sent": Review with AI opens the query window instead of sending', !(await page.evaluate(() => window.__pb.an.running)) && /^# Review request/.test(qSecond.user));
  check('the query follows Settings: a section left out, the trace not sent, the filter screen and the water included', !/## Open questions/.test(qSecond.system) && /Left out by the user: "Open questions"/.test(qSecond.system) && /## Suggested changes/.test(qSecond.system) && /the one-row-per-second trace is not sent/.test(qSecond.user) && !/Trace resampled/.test(qSecond.user) && /a filter \(puck\) screen on top of the coffee/.test(qSecond.user) && /Water the user brews with: E2E water 90 ppm\./.test(qSecond.user));
  await page.fill('#q-user', `${qSecond.user}\n\nEDITED-BY-HAND: answer in two sentences.`);
  await page.click('#q-send');
  await page.waitForFunction(() => !window.__pb.an.running && window.__pb.an.markdown.length > 100, null, { timeout: 20000 });
  const sentEdited = await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()).lastAiRequest, MOCK_PORT);
  check('Send to AI sends the query as edited, and the review says it was', /EDITED-BY-HAND: answer in two sentences\.$/.test(sentEdited.user) && (await page.evaluate(() => window.__pb.an.meta.edited === true && window.__pb.an.meta.community === 'app')));
  // Community switched off, or unreachable: the review still runs
  await page.evaluate(async (port) => { await fetch(`http://127.0.0.1:${port}/mock/dial`, { method: 'POST', body: JSON.stringify({ mcpDown: true }) }); window.__pb.communityCache.clear(); }, MOCK_PORT);
  const mcpDown20 = await page.evaluate(async () => { const q = await window.__pb.buildQuery(); return { notes: q.communityResult.notes, items: q.communityResult.items.length, block: /Not available from Meticulous Community/.test(q.user) }; });
  check('when Community cannot be reached the query says so and carries on', mcpDown20.items === 0 && mcpDown20.notes.length === 1 && /HTTP 503/.test(mcpDown20.notes[0]) && mcpDown20.block, JSON.stringify(mcpDown20));
  await page.evaluate(async (port) => { await fetch(`http://127.0.0.1:${port}/mock/dial`, { method: 'POST', body: JSON.stringify({ mcpDown: false }) }); }, MOCK_PORT);
  await page.click('.view-tab[data-view="settings"]');
  await page.uncheck('#set-ai-edit-query');
  await page.check('#set-sec-questions');
  await page.check('#set-send-trace');
  await page.uncheck('#set-prep-screen');
  await page.uncheck('#set-community-profiles');
  await page.selectOption('#set-ai-provider', 'anthropic');
  await page.waitForTimeout(300);
  const viaClaude = await page.evaluate(async () => { const q = await window.__pb.buildQuery(); return { mode: q.community.mode, mcp: q.mcp, mention: q.user.split('\n')[1], sys: /You are connected to Meticulous Community through the Meticulous Community \(Coffee\) connector/.test(q.system), block: /looked up by the app/.test(q.user), how: document.querySelector('#community-how').textContent }; });
  check('with Claude the request carries the Meticulous Community connector instead of looked-up answers', viaClaude.mode === 'connector' && viaClaude.mcp?.name === 'meticulous-community' && /\/api\/mcp$/.test(viaClaude.mcp.url) && Object.keys(viaClaude.mcp.configs).length === 0 && /^Use the Meticulous Community \(Coffee\) connector: look up the coffee “E2E coffee” by E2E roaster/.test(viaClaude.mention) && viaClaude.sys && !viaClaude.block && /carries the Meticulous Community \(Coffee\) connector/.test(viaClaude.how), JSON.stringify(viaClaude));
  await page.selectOption('#set-community-via', 'mention');
  await page.selectOption('#set-ai-provider', 'xai');
  await page.waitForTimeout(300);
  const viaGrok = await page.evaluate(async () => { const q = await window.__pb.buildQuery(); return { mode: q.community.mode, mcp: q.mcp, mention: q.user.split('\n')[1], provider: q.cfg.provider, model: q.cfg.model, profiles: /Do not bring up Community brew profiles/.test(q.system), keyField: document.querySelector('#set-ai-key-xai').offsetParent !== null }; });
  check('Grok is a provider; "name it only" mentions Meticulous Community and looks nothing up; an unticked kind is left out', viaGrok.provider === 'xai' && viaGrok.model === 'grok-4' && viaGrok.mode === 'mention' && viaGrok.mcp === null && /^Meticulous Community: look up the coffee/.test(viaGrok.mention) && viaGrok.profiles && viaGrok.keyField, JSON.stringify(viaGrok));
  await page.uncheck('#set-community');
  await page.waitForTimeout(200);
  const comOff = await page.evaluate(async () => { const q = await window.__pb.buildQuery(); return { community: q.community, any: /Meticulous Community/.test(q.user + q.system), disabled: document.querySelector('#set-community-coffee').disabled, sec: /## Community comparison/.test(q.system) }; });
  check('Meticulous Community switched off: nothing about it in the query, its options greyed', comOff.community === null && !comOff.any && comOff.disabled && !comOff.sec, JSON.stringify(comOff));
  await page.check('#set-community');
  await page.check('#set-community-profiles');
  await page.selectOption('#set-community-via', 'auto');
  await page.selectOption('#set-ai-provider', 'openai');
  await page.waitForTimeout(200);
  // Delete from the picker
  await page.click('.view-tab[data-view="analysis"]');
  await page.waitForTimeout(300);
  await page.click('#an-list li.on button[data-act="delete"]');
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-go');
  await page.waitForFunction(() => !window.__pb.state.shots.some((s) => s.id === 'picker-shot'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  check('Delete removes the shot from the app and from the review', (await page.evaluate(() => window.__pb.an.ids.length === 0 && document.querySelector('#an-preflight').hidden && !document.querySelector('#an-list input[data-id="picker-shot"]'))));

  // ---- v0.20: cleaning & maintenance, the piston check, the heating graph
  await page.click('.view-tab[data-view="machine"]');
  await page.waitForTimeout(600);
  const maint0 = await page.evaluate(() => ({ shown: !document.querySelector('#maint-panel').hidden, rows: [...document.querySelectorAll('#maint-rows tr')].map((tr) => `${tr.dataset.task}:${tr.dataset.state}`).join(','), names: [...document.querySelectorAll('#maint-rows tr td:first-child b')].map((b) => b.textContent).join('|'), next: document.querySelector('#maint-next').textContent, rail: document.querySelector('#maint-reminder-text').textContent, source: document.querySelector('#maint-source a').href, routine: /Routine cleaning \(not tracked here\)/.test(document.querySelector('#maint-extra').textContent) }));
  check('the Machine tab shows the cleaning & maintenance schedule (weekly, monthly, three-monthly — not the routine cleaning), with no dates yet', maint0.shown && maint0.rows === 'weekly:never,monthly:never,deep:never' && maint0.names === 'Internal cleaning|Chamber cleaning|Deep cleaning' && /No cleaning dates entered yet/.test(maint0.next) && /enter your dates/.test(maint0.rail) && maint0.source === 'https://meticuloushome.com/pages/maintenance-and-repairs' && maint0.routine, JSON.stringify(maint0));
  await page.click('#maint-rows tr[data-task="weekly"] button[data-act="now"]');
  await page.waitForTimeout(300);
  const tenDaysAgo = await page.evaluate(() => new Date(Date.now() - 40 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  await page.fill('#maint-rows tr[data-task="monthly"] .maint-when', tenDaysAgo);
  await page.click('#maint-rows tr[data-task="monthly"] button[data-act="save"]');
  await page.waitForTimeout(300);
  const maint1 = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#maint-rows tr')].map((tr) => `${tr.dataset.task}:${tr.dataset.state}`).join(','), next: document.querySelector('#maint-next').textContent, state: document.querySelector('#maint-next').dataset.state, rail: document.querySelector('#maint-reminder-text').textContent, brews: document.querySelector('#maint-rows tr[data-task="monthly"] td.num').textContent, stored: window.__pb.maintenance }));
  check('entered dates give each job a next-due date; the reminder names the overdue one and counts the brews since', maint1.rows === 'weekly:ok,monthly:due,deep:never' && maint1.state === 'due' && /^Overdue: Chamber cleaning — it was due \d+ days ago/.test(maint1.next) && /brews? since it was last done/.test(maint1.next) && /No date yet for: deep cleaning/.test(maint1.next) && /^Overdue: chamber cleaning/.test(maint1.rail) && Number(maint1.brews) >= 1 && maint1.stored.weekly.length === 1 && maint1.stored.monthly.length === 1, JSON.stringify({ ...maint1, stored: undefined }));
  await page.click('#maint-rows tr[data-task="deep"] button[data-act="now"]');
  await page.waitForTimeout(300);
  const maint2 = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#maint-rows tr')].map((tr) => `${tr.dataset.task}:${tr.dataset.state}`).join(','), monthly: document.querySelector('#maint-rows tr[data-task="monthly"]').textContent, next: document.querySelector('#maint-next').textContent }));
  check('a deep cleaning counts as the chamber and the internal cleaning too', maint2.rows === 'weekly:ok,monthly:ok,deep:ok' && /done with the deep cleaning/.test(maint2.monthly) && /^Next: Internal cleaning — due in 7 days/.test(maint2.next), JSON.stringify(maint2));
  await page.click('#maint-rows tr[data-task="deep"] button[data-act="undo"]');
  await page.waitForTimeout(300);
  check('Undo removes the last date entered', (await page.evaluate(() => window.__pb.maintenance.deep.length)) === 0 && (await page.getAttribute('#maint-rows tr[data-task="monthly"]', 'data-state')) === 'due');
  const pistonUi = await page.evaluate(() => ({ last: window.__pb.pistonLast, badge: document.querySelector('#maint-piston-badge').textContent, text: document.querySelector('#maint-piston').textContent }));
  check('the piston was checked after the brew: it travelled, came back to rest, all operating OK', pistonUi.last?.ok === true && pistonUi.last.returned && pistonUi.last.brewSec > 3 && pistonUi.badge === 'all operating OK' && /All operating OK/.test(pistonUi.text), JSON.stringify(pistonUi));
  const backupMaint = await page.evaluate(async () => (await window.__pb.store.exportAll()).maintenance);
  check('the cleaning dates travel in a backup', backupMaint.weekly.length === 1 && backupMaint.monthly.length === 1 && backupMaint.deep.length === 0, JSON.stringify(backupMaint));
  // heating graph: off by default, then three files through the browser
  const heat0 = await page.evaluate(() => ({ on: window.__pb.settings.heatSaveGraph, tools: document.querySelector('#heat-save-tools').hidden, window: window.__pb.machinePanel.windowSec, note: document.querySelector('#temps-note').textContent }));
  check('saving the heating graph is off by default: no buttons, five minutes of history', heat0.on === false && heat0.tools && heat0.window === 300 && /Last 5 minutes/.test(heat0.note), JSON.stringify(heat0));
  await page.click('.view-tab[data-view="settings"]');
  await page.check('#set-heat-save');
  await page.uncheck('#set-maintenance');
  await page.waitForTimeout(200);
  await page.click('.view-tab[data-view="machine"]');
  await page.waitForTimeout(1500);
  const heat1 = await page.evaluate(() => ({ tools: !document.querySelector('#heat-save-tools').hidden, window: window.__pb.machinePanel.windowSec, note: document.querySelector('#temps-note').textContent, info: document.querySelector('#heat-brew-info').textContent, maint: document.querySelector('#maint-panel').hidden && document.querySelector('#maint-reminder').hidden }));
  check('switched on: the buttons appear, the graph keeps 30 minutes and says which brew it will be saved with; the maintenance part can be switched off', heat1.tools && heat1.window === 1800 && /Last 30 minutes/.test(heat1.note) && /Saved with the graph: Blooming Espresso · target 92\.0 °C/.test(heat1.info) && heat1.maint, JSON.stringify(heat1));
  const hj = await dl('#heat-save-jpeg');
  check('the heating graph downloads as a JPEG', hj.bytes > 20000 && /^heating-.*-blooming-espresso\.jpg$/.test(hj.name), `${hj.name} ${hj.bytes} B`);
  const hp = await dl('#heat-save-pdf');
  const hpText = readFileSync(hp.path, 'latin1');
  check('…as a PDF with the brew it belongs to', hp.bytes > 20000 && /^%PDF/.test(hpText) && /^heating-.*\.pdf$/.test(hp.name), `${hp.name} ${hp.bytes} B`);
  const hc = await dl('#heat-save-csv');
  const hcText = readFileSync(hc.path, 'utf8').split('\n');
  check('…and its data as CSV: one row per reading with the state, the profile and its target', hcText[0].trim() === 'time_iso,t_s,external_1_c,external_2_c,bar_up_c,bar_mid_c,bar_down_c,tube_c,motor_c,status_temp_c,target_c,ready,heater_power_pct,motor_power_pct,piston_position,state,stage,profile' && hcText.length > 10 && /,92,(yes|no),.*,Blooming Espresso\s*$/.test(hcText[hcText.length - 2] || hcText[hcText.length - 1]), `${hcText.length} lines · ${hcText[1]}`);
  check('none of them was written to the data folder: they go through the browser', !onDisk().some((f) => /heating-/.test(f)));
  await page.click('.view-tab[data-view="settings"]');
  await page.check('#set-maintenance');
  await page.uncheck('#set-heat-save');
  await page.click('.view-tab[data-view="shots"]');

  // Disconnect path
  await page.click('#portal-disconnect');
  await page.waitForTimeout(300);
  check('disconnect clears the link', (await page.getAttribute('#link-portal .dot', 'data-state')) === 'disconnected');

  // Start over: typed confirmation, folder wipe, database gone, reload into defaults
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-file-destination', 'folder');
  await page.click('#files-pick-folder'); // re-attach the fake folder so there is something to wipe
  await page.waitForTimeout(200);
  await page.click('#log-download');
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => Object.keys(window.__fakeFolderFiles).length);
  await page.click('#reset-all');
  await page.waitForSelector('#reset-dialog[open]');
  const listText = await page.textContent('#reset-list');
  check('erase dialog lists shots, beans, reviews, settings (with the API key), log and pairing', /\d+ shots?/.test(listText) && /bean/.test(listText) && /0 saved AI reviews/.test(listText) && /including 1 API key/.test(listText) && /debug log/.test(listText), listText.replace(/\s+/g, ' ').slice(0, 160));
  check('erase button disabled until ERASE is typed', await page.isDisabled('#reset-go'));
  await page.fill('#reset-confirm', 'erase');
  check('typing ERASE (any case) enables it', !(await page.isDisabled('#reset-go')));
  check('folder wipe offered and ticked', await page.isChecked('#reset-folder'));
  const navigation = page.waitForNavigation({ timeout: 15000 });
  await page.click('#reset-go');
  await page.waitForFunction(() => /Restarting|database deleted/.test(document.querySelector('#reset-progress')?.textContent || ''), null, { timeout: 10000 });
  const progress = await page.textContent('#reset-progress');
  const removed = await page.evaluate(() => window.__fakeFolderRemoved || []);
  check('erase report: database deleted and folder subfolder removed', /database deleted/.test(progress) && removed.includes('portal-met-bridge'), `${progress.trim()} | removed: ${removed.join(',')} | files before: ${before}`);
  await navigation;
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  const after = await page.evaluate(async () => ({
    shots: window.__pb.state.shots.length,
    host: document.querySelector('#meticulous-host').value,
    addr: document.querySelector('#meticulous-addr').textContent,
    logOn: document.querySelector('#log-enabled').checked,
    beans: document.querySelectorAll('#bean-list option').length,
    hash: location.hash,
    dbs: (await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]))).map((d) => d.name),
  }));
  check('after restart: no shots, no beans, default address, log off, opens on Shots', after.shots === 0 && after.beans === 0 && after.host === '127.0.0.1' && after.addr === '127.0.0.1' && after.logOn === false && (after.hash === '' || after.hash === '#shots'), JSON.stringify(after));
  await page.evaluate(async () => { window.__pb.settings.settingsLayout = 'detailed'; await window.__pb.store.setSetting('settingsLayout', 'detailed'); }); // the rest of the run works in open sections
  // Recovery: a checkpoint left behind by a tab closed mid-shot becomes a shot on the next start
  await page.evaluate(async () => {
    const t0 = Date.now() - 600000;
    const machine = Array.from({ length: 40 }, (_, i) => ({ t: i * 0.5, p: 6 + Math.sin(i / 5), f: 2, w: i * 1.1, temp: 92, status: 'Extract' }));
    const portal = Array.from({ length: 160 }, (_, i) => ({ t: i * 0.125, ec: 3 - i / 100, tOut: 60, tInt: 30, status: 1 }));
    await window.__pb.store.putShot({ id: 'ckpt-test', startedAt: t0, inProgress: true, checkpointAt: t0 + 20000, source: 'live', manual: false, profileName: 'Interrupted', machine, portal, finalWeightG: 43, durationSec: 19.5, context: { beanName: 'Interrupted bean' } });
    // Two pre-v0.10 shots: one whose cup was weighed with the reading (differs from the scale), one whose reading just carried the scale's value
    const legacy = { startedAt: t0 - 86400000, source: 'live', manual: false, profileName: 'Old', machine, portal, durationSec: 19.5, context: { beanName: 'Legacy bean', doseG: 18 } };
    await window.__pb.store.putShot({ ...legacy, id: 'legacy-weighed', finalWeightG: 41, refractometer: { tdsPct: 9, beverageG: 39.2, eyPct: 19.6, at: t0 } });
    await window.__pb.store.putShot({ ...legacy, id: 'legacy-scale', startedAt: t0 - 86000000, finalWeightG: 41, refractometer: { tdsPct: 9, beverageG: 41, eyPct: 20.5, at: t0 } });
    await window.__pb.store.setSetting('beveragePromoted', false); // as a browser upgrading from v0.9 would have it
    await window.__pb.store.putReview({ id: 'rev-restart', createdAt: t0, title: 'Shot review: restart test', shotIds: ['legacy-weighed'], shotLabels: ['x'], provider: 'openai', model: 'mock-gpt-2', markdown: '## Verdict\n\nkept', digests: [] });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const recovered = await page.evaluate(async () => { const r = (await window.__pb.store.listShots()).find((x) => x.id === 'ckpt-test'); return r ? { inProgress: !!r.inProgress, recovered: !!r.recovered, duration: r.durationSec, weight: r.finalWeightG, cache: !!r.analysisCache, toast: document.querySelector('#toast')?.textContent } : null; });
  const promoted = await page.evaluate(async () => { const rows = await window.__pb.store.listShots(); const w = rows.find((x) => x.id === 'legacy-weighed'); const sc = rows.find((x) => x.id === 'legacy-scale'); return { weighed: w?.beverageG, scale: sc?.beverageG, flag: await window.__pb.store.getSetting('beveragePromoted', false) }; });
  check('upgrade: a cup weighed with a reading on an older version becomes the shot\'s own weighed value; a scale-equal one does not', promoted.weighed === 39.2 && promoted.scale === undefined && promoted.flag === true, JSON.stringify(promoted));
  check('unfinished checkpoint recovered as a shot after restart', recovered && !recovered.inProgress && recovered.recovered && recovered.duration === 19.5 && recovered.weight === 43 && recovered.cache, JSON.stringify(recovered));
  await page.click('.view-tab[data-view="analysis"]');
  await page.waitForTimeout(300);
  check('a saved review survives a restart and is listed with its title', (await page.evaluate(() => [...document.querySelectorAll('#an-saved-rows tr')].map((tr) => tr.textContent))).some((t) => /Shot review: restart test/.test(t)) && (await page.textContent('#analysis-tab-count')) === '(1)');
  // ---- Security (v0.19): hostile data stays text everywhere, the policy blocks inline script, a settings file cannot repoint the API key
  const pol = await page.evaluate(async () => {
    const d = document.createElement('div');
    d.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="window.__inline=1" onload="window.__inline=1"><svg onload="window.__inline=1"></svg>';
    document.body.appendChild(d);
    const s = document.createElement('script');
    s.textContent = 'window.__inline = 2';
    document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 400));
    d.remove();
    s.remove();
    return { meta: !!document.querySelector('meta[http-equiv="Content-Security-Policy"]'), inline: window.__inline, header: (await fetch(location.href)).headers.get('content-security-policy') || '' };
  });
  check('the Content-Security-Policy is in force: an injected inline handler and an inline script do not run', pol.meta && pol.inline === undefined && /script-src 'self'/.test(pol.header) && !/unsafe-eval/.test(pol.header) && /frame-ancestors 'none'/.test(pol.header), JSON.stringify(pol).slice(0, 300));
  const EVIL = `"><img src=x onerror="window.__xss=(window.__xss||0)+1"><script>window.__xss=9</script>'`;
  const hostileBackup = {
    app: 'portal-met-bridge', version: 4, exportedAt: EVIL,
    shots: [0, 1].map((i) => ({
      id: `evil-${i}${EVIL}`, startedAt: Date.now() - 86400000 * (9 + i), durationSec: EVIL, finalWeightG: 36, beverageG: i ? EVIL : 37.5, profileName: EVIL, profileTargetG: EVIL, source: EVIL, machineShotId: EVIL, comment: EVIL, rating: i ? EVIL : 4, ratingMax: EVIL,
      context: { beanName: `Evil${i} ${EVIL}`, roaster: EVIL, origin: EVIL, grindSize: EVIL, grinderName: EVIL, note: EVIL, process: EVIL, roastLevel: EVIL, doseG: i ? EVIL : 18, nested: { a: EVIL } },
      files: { json: EVIL, csv: EVIL }, refractometer: { tdsPct: EVIL, eyPct: EVIL }, machineSource: { id: EVIL, profile: { name: EVIL, final_weight: EVIL, temperature: EVIL, variables: [{ name: EVIL, key: EVIL, type: EVIL, value: EVIL }], stages: [{ name: EVIL, key: EVIL, type: EVIL, dynamics: { over: EVIL, points: [[0, EVIL]] }, exit_triggers: [{ type: EVIL, value: EVIL }], limits: [] }] } },
      machine: Array.from({ length: 60 }, (_, k) => ({ t: k * 0.5, w: k * 0.6, p: 6, f: 2, stage: EVIL, state: EVIL })).concat([EVIL, null]),
      portal: i ? { length: EVIL } : Array.from({ length: 60 }, (_, k) => ({ t: k * 0.5, ec: 2 + k / 60, temp: 60 })),
    })),
    beans: [{ key: `evil${EVIL}`.toLowerCase(), name: `EvilBean ${EVIL}`, roaster: EVIL, origin: EVIL, process: EVIL, roastLevel: EVIL, url: 'javascript:window.__xss=7', notes: EVIL, lastGrind: EVIL, lastDoseG: EVIL, uses: EVIL }],
    lists: ['roaster', 'origin', 'grinder'].map((kind) => ({ key: `${kind}:${EVIL}`, kind, value: EVIL, uses: EVIL, lastUsed: EVIL })),
    reviews: [{ id: `rev${EVIL}`, createdAt: Date.now(), provider: EVIL, model: EVIL, title: EVIL, shotIds: [`evil-0${EVIL}`], shotLabels: [EVIL], taste: EVIL, question: EVIL, markdown: `## Verdict ${EVIL}\n\n${EVIL} [x](javascript:window.__xss=8) [y](https://example.org/"onmouseover="window.__xss=6)\n\n| a | b |\n| --- | --- |\n| ${EVIL} | 2 |\n\n1. ${EVIL}\n`, digests: [EVIL] }],
  };
  await page.click('.view-tab[data-view="settings"]');
  await page.setInputFiles('#backup-import', { name: 'hostile-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostileBackup)) });
  await page.waitForFunction(() => /Restored 2 shots from hostile-backup\.json/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
  const evilIds = await page.evaluate(() => window.__pb.state.shots.filter((x) => String(x.id).startsWith('evil-')).map((x) => x.id));
  // walk every view that shows shots, beans and reviews with the hostile records on screen
  await page.click('.view-tab[data-view="history"]');
  await page.fill('#hist-search', 'Evil');
  await page.waitForTimeout(300);
  const histEvil = await page.evaluate(() => document.querySelectorAll('#hist-rows tr').length);
  for (const n of [1, 2]) await page.check(`#hist-rows tr:nth-child(${n}) input[type="checkbox"]`);
  await page.click('#hist-compare');
  await page.waitForTimeout(600);
  await page.click('#cmp-close');
  await page.click('#hist-rows tr button[data-act="edit"]');
  await page.waitForSelector('#shot-dialog[open]');
  await page.keyboard.press('Escape');
  await page.click('#hist-rows tr td.rating button');
  await page.waitForSelector('#rating-dialog[open]');
  await page.click('#r-later');
  await page.click('#hist-rows tr button[data-act="open"]');
  await page.waitForTimeout(700);
  await page.click('.view-tab[data-view="history"]');
  for (const n of [1, 2]) await page.check(`#hist-rows tr:nth-child(${n}) input[type="checkbox"]`); // the dialogs re-rendered the rows
  await page.click('#hist-analyze');
  await page.waitForTimeout(700);
  const digestShots = await page.evaluate(() => document.querySelectorAll('#an-digest .an-shot').length); // the panel that wrote the profile name unescaped before 0.19
  await page.evaluate(() => { const tr = [...document.querySelectorAll('#an-saved-rows tr')].find((r) => String(r.dataset.id).startsWith('rev"')); tr?.querySelector('button[data-act="open"]')?.click(); });
  await page.waitForTimeout(500);
  await page.click('.view-tab[data-view="beans"]');
  await page.fill('#beans-search', 'Evil');
  await page.waitForTimeout(300);
  const beanLinks = await page.evaluate(() => [...document.querySelectorAll('#beans-rows a')].map((a) => a.getAttribute('href')));
  await page.evaluate(() => document.querySelector('#beans-rows button[data-act="edit"]')?.click());
  await page.waitForSelector('#bean-dialog[open]');
  await page.click('#b-cancel');
  await page.fill('#beans-search', '');
  await page.dispatchEvent('#beans-search', 'input');
  await page.click('.view-tab[data-view="settings"]');
  await page.waitForTimeout(400);
  const hostileData = await page.evaluate(() => ({
    xss: window.__xss,
    imgs: document.querySelectorAll('img[src="x"]').length,
    scripts: document.querySelectorAll('script:not([src])').length,
    handlers: document.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length,
    jsLinks: [...document.querySelectorAll('a[href]')].filter((a) => /^\s*javascript:/i.test(a.getAttribute('href'))).length,
    report: (document.querySelector('#an-report')?.textContent || '').includes('<img src=x'),
    shot: window.__pb.state.shots.find((x) => String(x.id).startsWith('evil-1')),
  }));
  check('a backup with markup in every field restores as text: History, Compare, the dialogs, Shots, Analysis, a saved review, Beans and Settings show it and nothing runs or is injected', histEvil === 2 && evilIds.length === 2 && digestShots === 2 && hostileData.xss === undefined && hostileData.imgs === 0 && hostileData.scripts === 0 && hostileData.handlers === 0 && hostileData.jsLinks === 0 && hostileData.report && beanLinks.every((h) => !/javascript/i.test(h || '')), JSON.stringify({ ...hostileData, shot: undefined, histEvil, digestShots, beanLinks }));
  check('the restore brought the records to the app\'s own types (a portal that was not a list is empty, text where numbers belong is dropped)', Array.isArray(hostileData.shot.portal) && hostileData.shot.portal.length === 0 && !('durationSec' in hostileData.shot) && !('rating' in hostileData.shot) && hostileData.shot.context.nested === undefined && hostileData.shot.machine.every((m) => m && typeof m === 'object'), JSON.stringify({ portal: hostileData.shot.portal, keys: Object.keys(hostileData.shot).join(',') }).slice(0, 300));
  await page.evaluate(async (ids) => {
    for (const id of ids) await window.__pb.store.deleteShot(id);
    for (const r of await window.__pb.store.listReviews({ limit: 1000 })) if (String(r.id).startsWith('rev"')) await window.__pb.store.deleteReview(r.id);
    for (const b of await window.__pb.store.listBeans({ limit: 1000 })) if (/^EvilBean/.test(b.name)) await window.__pb.store.deleteBean(b.name);
    await window.__pb.refreshShotList();
  }, evilIds);
  await page.click('.view-tab[data-view="history"]');
  await page.fill('#hist-search', '');
  await page.dispatchEvent('#hist-search', 'input');
  // a settings file from someone else: it may not move the endpoint the stored key is sent to, nor set a key
  await page.click('.view-tab[data-view="settings"]');
  const beforeImport = await page.evaluate(() => ({ base: window.__pb.settings.aiBaseOpenai, key: window.__pb.settings.aiKeyOpenai }));
  await page.setInputFiles('#settings-import', { name: 'their-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ app: 'portal-met-bridge-settings', version: 1, settings: { aiBaseOpenai: 'https://collector.example/v1', aiKeyOpenai: 'sk-planted', aiKeyAnthropic: 'sk-planted', settleSec: 6 } })) });
  await page.waitForFunction(() => /Imported \d+ settings/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
  const afterImport = await page.evaluate(() => ({ base: window.__pb.settings.aiBaseOpenai, key: window.__pb.settings.aiKeyOpenai, settle: window.__pb.settings.settleSec, toast: document.querySelector('#toast').textContent }));
  check('importing settings applies the ordinary ones but leaves the OpenAI-compatible endpoint and the API keys alone, and says so', afterImport.base === beforeImport.base && afterImport.key === beforeImport.key && afterImport.settle === 6 && /collector\.example.*was not applied/.test(afterImport.toast), JSON.stringify(afterImport).slice(0, 300));
  await page.selectOption('#set-ai-provider', 'openai');
  await page.fill('#set-ai-base-openai', 'http://api.example.com/v1');
  await page.dispatchEvent('#set-ai-base-openai', 'input');
  const insecureNote = await page.textContent('#set-ai-base-note');
  await page.fill('#set-ai-base-openai', beforeImport.base || '');
  await page.dispatchEvent('#set-ai-base-openai', 'input');
  await page.evaluate(() => window.__pb.store.setSetting('settleSec', 7).then(() => { window.__pb.settings.settleSec = 7; }));
  check('a plain-http endpoint on the internet is called out before a key is sent to it', /plain http on the internet/.test(insecureNote), insecureNote);

  // ---- Stop (v0.15): one confirmation, then everything stops; the server only when asked
  await page.click('.view-tab[data-view="settings"]'); // the wipe above reset the address to the default
  await page.fill('#meticulous-host', `localhost:${MOCK_PORT}`);
  // ---- the machine through the server's /machine/ proxy (v0.16): what an https page has to do
  await page.selectOption('#set-machine-via', 'server');
  await page.click('#settings-save');
  await page.waitForTimeout(200);
  check('Settings → Machine explains the relay when "through the server" is chosen', /through the server that serves it \(localhost:\d+ → localhost:\d+\)/.test(await page.textContent('#machine-via-note')), (await page.textContent('#machine-via-note')).trim());
  await page.click('#meticulous-test');
  await page.waitForFunction(() => /MeticulousMock|saved shots/.test(document.querySelector('#meticulous-test-result').textContent), null, { timeout: 8000 });
  check('Test connection works through the relay', /MeticulousMock/.test(await page.textContent('#meticulous-test-result')), (await page.textContent('#meticulous-test-result')).trim().slice(0, 160));
  await page.click('.view-tab[data-view="shots"]');
  await page.click('#meticulous-connect');
  await page.waitForFunction(() => window.__pb.meticulous?.connected && window.__pb.meticulous.lastStatus, null, { timeout: 8000 });
  const viaServer = await page.evaluate(() => ({ via: window.__pb.meticulous.via, base: window.__pb.meticulous.baseUrl, status: window.__pb.meticulous.lastStatus?.name, profiles: window.__pb.state.profileList?.length }));
  check('the live socket and the REST calls flow through /machine/<address>/ on the serving host', viaServer.via === 'server' && new RegExp(`^http://localhost:\\d+/machine/localhost:${MOCK_PORT}$`).test(viaServer.base) && typeof viaServer.status === 'string' && viaServer.profiles >= 4, JSON.stringify(viaServer));
  check('GET api/cert without TLS says so', (await page.evaluate(async () => (await fetch('api/cert')).status)) === 404);
  check('the relay refuses a public host', (await page.evaluate(async () => (await fetch('machine/example.com/api/v1/machine')).status)) === 400);
  await page.click('.view-tab[data-view="settings"]');
  await page.selectOption('#set-machine-via', 'auto');
  await page.click('#settings-save');
  await page.waitForFunction(() => window.__pb.meticulous?.via === 'direct' && window.__pb.meticulous.connected, null, { timeout: 8000 });
  check('back to automatic on an http page: the browser talks to the machine directly again', /^http:\/\/localhost:\d+$/.test(await page.evaluate(() => window.__pb.meticulous.baseUrl)));
  await page.click('.view-tab[data-view="shots"]');
  await page.click('#portal-connect');
  await page.waitForFunction(() => window.__pb.portal.connected, null, { timeout: 8000 });
  const serverInfo = await page.evaluate(async () => (await (await fetch('api/server')).json()));
  check('GET api/server names the server and allows a stop from this computer', serverInfo.app === 'portal-met-bridge' && serverInfo.quit === true && serverInfo.local === true && Number.isFinite(serverInfo.pid), JSON.stringify(serverInfo));
  await page.click('#app-stop');
  await page.waitForTimeout(200);
  const stopDlg = await page.evaluate(() => ({ open: document.querySelector('#stop-dialog').open, items: [...document.querySelectorAll('#stop-list li')].map((li) => li.textContent), serverRow: !document.querySelector('#stop-server-row').hidden, serverChecked: document.querySelector('#stop-server').checked, label: document.querySelector('#stop-server-label').textContent }));
  check('Stop asks first: the dialog lists the Portal link, the machine and the background work, and offers the server unticked', stopDlg.open && stopDlg.items.some((t) => /Bluetooth link/.test(t)) && stopDlg.items.some((t) => /connection to the machine/.test(t)) && stopDlg.items.some((t) => /timers and background work/.test(t)) && stopDlg.serverRow && !stopDlg.serverChecked && /pid \d+/.test(stopDlg.label), JSON.stringify(stopDlg));
  await page.click('#stop-cancel');
  check('Cancel keeps everything running', !(await page.evaluate(() => document.querySelector('#stop-dialog').open)) && (await page.evaluate(() => window.__pb.portal.connected && !!window.__pb.meticulous?.connected && !window.__pb.state.stopped)));
  await page.click('#app-stop');
  await page.click('#stop-go');
  await page.waitForFunction(() => !document.querySelector('#stopped').hidden, null, { timeout: 8000 });
  const stopped = await page.evaluate(() => ({ stopped: window.__pb.state.stopped, portal: window.__pb.portal.connected, machine: window.__pb.meticulous, items: [...document.querySelectorAll('#stopped-list li')].map((li) => li.textContent), again: document.querySelector('#stopped-again').disabled, note: document.querySelector('#stopped-note').textContent, title: document.title, portalDot: document.querySelector('#link-portal .dot').dataset.state }));
  check('confirmed: the Portal and the machine are disconnected, timers cleared, the log flushed, and the page says so', stopped.stopped && !stopped.portal && stopped.machine === null && stopped.items.some((t) => /Portal disconnected/.test(t)) && stopped.items.some((t) => /machine disconnected/.test(t)) && stopped.items.some((t) => /timers cleared, log flushed/.test(t)) && !stopped.again && /Start again reloads/.test(stopped.note) && /stopped/.test(stopped.title) && stopped.portalDot !== 'connected', JSON.stringify(stopped));
  check('the server was left running (the box was not ticked)', (await page.evaluate(async () => (await fetch('api/server')).ok)));
  // the server part, against a second server so this one survives for the checks above
  const { spawn: spawn2 } = await import('node:child_process');
  const spare = spawn2('node', [join(root, 'serve.mjs')], { env: { ...process.env, PORT: '8799' }, stdio: 'ignore' });
  const spareExit = new Promise((r) => spare.on('exit', (code) => r(code)));
  await new Promise((r) => setTimeout(r, 700));
  const quitRes = await fetch('http://127.0.0.1:8799/api/quit', { method: 'POST' }).then((r) => r.json());
  const exitCode = await Promise.race([spareExit, new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
  check('POST api/quit stops the server process (what "Also stop the local server" does)', quitRes.stopping === true && exitCode === 0, JSON.stringify({ quitRes, exitCode }));
  const unexpected = errors.filter((e) => !/bad-model|404 \(Not Found\)|400 \(Bad Request\)|405 \(Method Not Allowed\)|503 \(Service Unavailable\)|Refused to execute inline|violates the following Content Security Policy directive:? ['"]script-src/.test(e)); // …and the policy check injects inline script on purpose // the deliberate wrong-model request logs a 404, the refused file paths 400s, the Community-is-down check a 503
  check('no page errors', unexpected.length === 0, unexpected.join(' | ').slice(0, 300));

  if (headed) await page.waitForTimeout(5000);
  await browser.close();
} catch (err) {
  failures++;
  console.error('  FAIL', err);
} finally {
  server.kill();
  mock.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
