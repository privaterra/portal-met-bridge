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
import { readFileSync, existsSync, statSync } from 'node:fs';

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
const server = spawn('node', [join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(APP_PORT) }, stdio: 'ignore' });
const mock = spawn('node', [join(here, 'mock-meticulous.mjs')], { env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
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
  // Machine address lives under Settings; typing + Enter saves it and the rail follows.
  await page.click('.view-tab[data-view="settings"]');
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
  await page.click('#log-pick-folder');
  await page.waitForTimeout(300);
  check('log folder chosen and writable', /writable/.test(await page.textContent('#log-folder')), (await page.textContent('#log-folder')).trim());
  await page.check('#log-save-exports');
  await page.dispatchEvent('#log-save-exports', 'change');
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

  // History tab: list, search, filter, open, edit, delete
  await page.click('.view-tab[data-view="history"]');
  const histRows = await page.evaluate(() => [...document.querySelectorAll('#hist-rows tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()));
  check('History lists the shot with its coffee, EC/g and data tags', histRows.length === 1 && /E2E coffee/.test(histRows[0]) && /P \d+/.test(histRows[0]) && /M \d+/.test(histRows[0]), histRows.join(' | ').slice(0, 200));
  check('History has a Grind column (µm) before In → out', /420 µm.*18\.0 → 38\.0 g◎/.test(histRows[0]), histRows[0].slice(0, 160));
  check('History In → out shows the profile target with the ◎ mark and the ratio from it', /→ 38\.0 g◎\s*1 : 2\.11/.test(histRows[0]), histRows[0].slice(0, 160));
  const grindTh = await page.evaluate(() => [...document.querySelectorAll('#hist-table th')].map((th) => th.textContent.trim()));
  check('Grind header sits between Profile and In → out', grindTh.indexOf('Grind') === grindTh.indexOf('Profile') + 1 && grindTh.indexOf('In → out') === grindTh.indexOf('Grind') + 1, grindTh.join(' | '));
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
  await page.fill('#e-bean', 'E2E coffee (edited)');
  await page.fill('#e-dose', '18.5');
  await page.fill('#e-tds', '9.1');
  await page.fill('#e-bev', '41.5');
  await page.click('#shot-dialog-save');
  await page.waitForTimeout(400);
  const edited = await page.evaluate(() => ({ row: document.querySelector('#hist-rows tr')?.textContent.replace(/\s+/g, ' '), sel: window.__pb.state.selected?.context?.beanName, tds: window.__pb.state.selected?.refractometer?.tdsPct, dose: window.__pb.state.selected?.context?.doseG, open: document.querySelector('#shot-dialog').open, bev: window.__pb.state.selected?.beverageG, ey: window.__pb.state.selected?.refractometer?.eyPct, machineW: window.__pb.state.selected?.finalWeightG, sub: document.querySelector('#shot-sub').textContent }));
  check('History → Edit updates coffee, dose and reading', /E2E coffee \(edited\)/.test(edited.row) && /18\.5 →/.test(edited.row) && edited.sel === 'E2E coffee (edited)' && edited.tds === 9.1 && edited.dose === 18.5 && !edited.open, JSON.stringify(edited).slice(0, 200));
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
  await page.click('#demo-load');
  await page.waitForTimeout(600);
  await page.click('.view-tab[data-view="history"]');
  const rowsWithDemo = await page.evaluate(() => [...document.querySelectorAll('#hist-rows tr')].map((tr) => ({ id: tr.dataset.id, demo: /demo/.test(tr.textContent) })));
  check('demo shot appears in History', rowsWithDemo.length === 2 && rowsWithDemo.some((r) => r.demo), JSON.stringify(rowsWithDemo));
  const demoId = rowsWithDemo.find((r) => r.demo).id;
  // Compare: tick both shots and overlay their graphs
  for (const r of rowsWithDemo) await page.check(`#hist-rows tr[data-id="${r.id}"] input[type="checkbox"]`);
  check('Compare selected is enabled with two ticked shots', /Compare selected \(2\)/.test(await page.textContent('#hist-compare')) && !(await page.isDisabled('#hist-compare')));
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

  // Exports with "save to folder" on: files land in the fake folder, no browser download
  await page.click('#dl-csv');
  await page.waitForTimeout(800);
  let folderFiles = await page.evaluate(() => Object.keys(window.__fakeFolderFiles || {}));
  check('CSV saved into the chosen folder', folderFiles.some((f) => /portal-met-bridge\/exports\/shot-.*\.csv$/.test(f)), folderFiles.join(', '));
  await page.click('.view-tab[data-view="settings"]');
  await page.click('#log-download');
  await page.waitForTimeout(800);
  folderFiles = await page.evaluate(() => Object.keys(window.__fakeFolderFiles || {}));
  check('log file written to the folder (dated .log) and the download copy', folderFiles.some((f) => /logs\/\d{4}-\d{2}-\d{2}\.log$/.test(f)) && folderFiles.some((f) => /logs\/portal-met-bridge-log-.*\.txt$/.test(f)), folderFiles.filter((f) => f.includes('logs')).join(', '));
  const logText = await page.evaluate(() => { const k = Object.keys(window.__fakeFolderFiles).find((f) => /\.log$/.test(f)); return window.__fakeFolderFiles[k]; });
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
  check('AI settings save with the Save button and the key is shown masked', /Saved [345] settings/.test(await page.textContent('#savebar-status')) && /OpenAI · mock-gpt-2 · 127\.0\.0\.1:\d+ · key sk-tes…-123/.test(await page.textContent('#set-ai-note')), `${(await page.textContent('#savebar-status')).trim()} | ${await page.textContent('#set-ai-note')}`);
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

  // Settings export round-trip
  await page.click('#settings-export');
  await page.waitForTimeout(500);
  const settingsDoc = await page.evaluate(() => { const k = Object.keys(window.__fakeFolderFiles).find((f) => /backups\/portal-met-bridge-settings-.*\.json$/.test(f)); return k ? JSON.parse(window.__fakeFolderFiles[k]) : null; });
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
  check('the size note counts shots and the one without Portal data', /About [\d,]+ tokens will be sent \(3 shots, 1 without Portal data\)/.test(await page.textContent('#an-size')), (await page.textContent('#an-size')).trim());
  const digestInfo = await page.evaluate(() => ({ blocks: document.querySelectorAll('#an-digest .an-shot').length, tables: document.querySelectorAll('#an-digest table.stages').length, noPortal: document.querySelectorAll('#an-digest .an-shot .muted').length > 0, gaps: [...document.querySelectorAll('#an-digest .gaps li')].map((li) => li.textContent).filter((t) => /No Belka Portal/.test(t)).length, stageNames: [...document.querySelectorAll('#an-digest .an-shot:last-child table.stages tbody td:first-child')].map((td) => td.textContent), chart: !!document.querySelector('#an-chart canvas') }));
  check('the local digest shows a stage table per shot, the record\'s stage names, and marks the shot without Portal data', digestInfo.blocks === 3 && digestInfo.tables === 3 && digestInfo.noPortal && digestInfo.gaps === 1 && digestInfo.stageNames.slice(0, 4).join(',') === 'Saturate,Bloom,Gentle Rebuild,Extract' && digestInfo.chart, JSON.stringify(digestInfo));
  await page.fill('#an-taste', 'sweet, a bit thin');
  await page.fill('#an-question', 'Which shot was best?');
  await page.click('#an-run');
  await page.waitForFunction(() => !window.__pb.an.running && window.__pb.an.markdown.length > 100, null, { timeout: 20000 });
  const review = await page.evaluate(() => ({ md: window.__pb.an.markdown, h3: [...document.querySelectorAll('#an-report h3')].map((h) => h.textContent), table: !!document.querySelector('#an-report table'), status: document.querySelector('#an-status').textContent, title: document.querySelector('#an-report-title').textContent, saveDisabled: document.querySelector('#an-save').disabled }));
  check('the review streams in, rendered as sections and a table, with the prompt facts the mock echoes back', /mock review of 3 shots, one without Portal data/.test(review.md) && review.h3.join('|') === 'Verdict|Stages|What stands out|Suggested changes|Open questions|Sources' && review.table && /Done in/.test(review.status) && /^Shot review: 3 shots of E2E coffee.* on Blooming Espresso/.test(review.title) && !review.saveDisabled, JSON.stringify({ ...review, md: review.md.slice(0, 80) }));
  const sent = await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()).lastAiRequest, MOCK_PORT);
  check('the request carried the model, a system prompt and the digest', sent && sent.model === 'mock-gpt-2' && sent.stream === true && sent.systemChars > 2000 && sent.userChars > 3000, JSON.stringify(sent));
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

  // ---- Brew controls: the dial's actions over the API (the mock plays "heating → click to start")
  await page.click('.view-tab[data-view="shots"]');
  await page.waitForFunction(() => !document.getElementById('brew-controls').hidden && document.querySelectorAll('#brew-profile option').length === 4, null, { timeout: 8000 }).catch(() => {});
  const brewOpts = await page.evaluate(() => [...document.querySelectorAll('#brew-profile option')].map((o) => o.textContent));
  check('Brew controls appear while the machine is connected, with its profiles', (await page.isVisible('#brew-controls')) && brewOpts.length === 4 && /Blooming Espresso · 43 g · 92 °C/.test(brewOpts[0]) && /Blooming Espresso · 38 g · 93 °C/.test(brewOpts[3]), brewOpts.join(' | '));
  await page.click('#brew-start');
  await page.waitForFunction(() => /click to start/i.test(document.querySelector('#brew-state').textContent), null, { timeout: 5000 });
  check('Start brew sends the dial click; the rail shows the machine waiting at "click to start"', /Ready — click to start · 93\.4 °C/.test(await page.textContent('#brew-state')) && (await page.textContent('#brew-start')) === 'Start brew now' && !(await page.isDisabled('#brew-stop')), (await page.textContent('#brew-state')).trim());
  await page.click('#brew-stop');
  await page.waitForFunction(() => /idle/i.test(document.querySelector('#brew-state').textContent), null, { timeout: 5000 });
  check('Stop aborts and the machine returns to idle', /idle/.test(await page.textContent('#brew-state')));
  await page.selectOption('#brew-profile', '80c5ea87');
  await page.click('#brew-load');
  await page.waitForTimeout(500);
  const dialState = await page.evaluate(async (port) => (await (await fetch(`http://127.0.0.1:${port}/mock/dial`)).json()), MOCK_PORT);
  check('Load sends the profile to the machine; the actions reached the API in order', dialState.loadedProfile === 'Blooming Espresso' && dialState.actions.join(',') === 'start,abort' && /Loaded "Blooming Espresso"/.test(await page.textContent('#toast')), JSON.stringify({ loaded: dialState.loadedProfile, actions: dialState.actions }));
  await page.click('.view-tab[data-view="settings"]');
  // Back to browser downloads for the rest
  await page.uncheck('#log-save-exports');
  await page.dispatchEvent('#log-save-exports', 'change');
  await page.click('.view-tab[data-view="shots"]');

  // Exports: JPEG, PDF, summary CSV, zip
  const keep = process.env.E2E_OUT; // set to a folder to keep the exported files
  const dl = async (sel) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(sel)]);
    const p = await d.path();
    if (keep) await d.saveAs(join(keep, d.suggestedFilename()));
    return { name: d.suggestedFilename(), bytes: statSync(p).size };
  };
  const jpg = await dl('#dl-jpeg');
  check('JPEG export downloads', jpg.bytes > 10000 && /time\.jpg$/.test(jpg.name), `${jpg.name} ${jpg.bytes} B`);
  const jpg2 = await page.waitForEvent('download', { timeout: 10000 }); // the second graph
  check('second JPEG (EC vs mass) downloads', /ec-vs-mass\.jpg$/.test(jpg2.suggestedFilename()), jpg2.suggestedFilename());
  const pdf = await dl('#dl-pdf');
  check('PDF report downloads', pdf.bytes > 20000 && /report\.pdf$/.test(pdf.name), `${pdf.name} ${pdf.bytes} B`);
  await page.click('.view-tab[data-view="history"]');
  const csv = await dl('#dl-summary');
  check('summary CSV downloads (from History)', csv.bytes > 200 && /shots-.*\.csv$/.test(csv.name), `${csv.name} ${csv.bytes} B`);
  const zip = await dl('#dl-zip');
  check('zip of everything downloads (from History)', zip.bytes > 30000 && /export-.*\.zip$/.test(zip.name), `${zip.name} ${zip.bytes} B`);
  await page.click('.view-tab[data-view="shots"]');

  // Disconnect path
  await page.click('#portal-disconnect');
  await page.waitForTimeout(300);
  check('disconnect clears the link', (await page.getAttribute('#link-portal .dot', 'data-state')) === 'disconnected');

  // Start over: typed confirmation, folder wipe, database gone, reload into defaults
  await page.click('.view-tab[data-view="settings"]');
  await page.click('#log-pick-folder'); // re-attach the fake folder so there is something to wipe
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
  const unexpected = errors.filter((e) => !/bad-model|404 \(Not Found\)/.test(e)); // the deliberate wrong-model request above logs a 404
  check('no page errors', unexpected.length === 0, unexpected.join(' | ').slice(0, 300));

  if (headed) await page.waitForTimeout(5000);
  await browser.close();
} catch (err) {
  failures++;
  console.error('  FAIL', err);
} finally {
  server.kill();
  mock.kill();
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
