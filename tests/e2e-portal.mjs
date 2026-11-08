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
  await page.fill('#ctx-roaster', 'E2E roaster');
  await page.selectOption('#ctx-roast', 'light');
  await page.fill('#ctx-dose', '18');
  await page.dispatchEvent('#ctx-dose', 'change');
  // Machine address lives under Settings; test connection there, then connect from the rail.
  await page.click('.view-tab[data-view="settings"]');
  await page.fill('#meticulous-host', `localhost:${MOCK_PORT}`);
  await page.dispatchEvent('#meticulous-host', 'change');
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
  await page.waitForTimeout(2000);
  const writes = await page.evaluate(() => window.__fakePortalWrites || []);
  const dbg = await page.evaluate(() => ({ autoGraph: window.__pb.settings.autoGraph, connected: window.__pb.portal.connected, cmd: !!window.__pb.portal.command, log: window.__pb.log.ring.filter((e) => /graph|command/i.test(e.msg)).map((e) => e.msg) }));
  check('show-graph command written at shot start (40 00 01 2D)', JSON.stringify(writes).includes('[64,0,1,45]'), JSON.stringify(writes) + ' ' + JSON.stringify(dbg));
  await page.waitForFunction(() => document.querySelector('#rec-indicator')?.dataset.state === 'idle' && document.querySelectorAll('#shot-list li').length >= 1, null, { timeout: 90000 });
  await page.waitForTimeout(6000); // machine-record swap
  const writes2 = await page.evaluate(() => window.__fakePortalWrites || []);
  check('hide-graph command written at shot end (40 00 01 2E)', JSON.stringify(writes2).includes('[64,0,1,46]'));

  const sel = await page.evaluate(() => {
    const s = window.__pb.state.selected;
    const a = window.__pb.state.analysis;
    return { portal: s.portal.length, machine: s.machine.length, status: a.status, coverage: a.coverageRatio, meanEc: a.meanEcPerG, peak: a.mainPeakEc, machineRecord: !!s.machineShotId };
  });
  check('shot has Portal samples at ~8 Hz', sel.portal > 150, `${sel.portal} samples`);
  check('machine record attached', sel.machineRecord);
  check('analysis status ok with ≥ 85 % coverage', sel.status === 'ok' && sel.coverage >= 0.85, `${sel.status}, coverage ${(sel.coverage * 100).toFixed(0)} %`);
  check('mean EC and peak are plausible', sel.meanEc > 0.5 && sel.peak > sel.meanEc, `mean ${sel.meanEc.toFixed(3)} peak ${sel.peak.toFixed(3)}`);

  // Refractometer reading → estimate from "this bean" vs pools
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
  // Settings export round-trip
  await page.click('#settings-export');
  await page.waitForTimeout(500);
  const settingsDoc = await page.evaluate(() => { const k = Object.keys(window.__fakeFolderFiles).find((f) => /backups\/portal-met-bridge-settings-.*\.json$/.test(f)); return k ? JSON.parse(window.__fakeFolderFiles[k]) : null; });
  check('settings export has the machine address and recording options', settingsDoc?.app === 'portal-met-bridge-settings' && settingsDoc.settings.meticulousHost === `localhost:${MOCK_PORT}` && 'settleSec' in settingsDoc.settings && 'logEnabled' in settingsDoc.settings, JSON.stringify(settingsDoc?.settings || {}).slice(0, 120));
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
  const csv = await dl('#dl-summary');
  check('summary CSV downloads', csv.bytes > 200 && /shots-.*\.csv$/.test(csv.name), `${csv.name} ${csv.bytes} B`);
  const zip = await dl('#dl-zip');
  check('zip of everything downloads', zip.bytes > 30000 && /export-.*\.zip$/.test(zip.name), `${zip.name} ${zip.bytes} B`);

  // Disconnect path
  await page.click('#portal-disconnect');
  await page.waitForTimeout(300);
  check('disconnect clears the link', (await page.getAttribute('#link-portal .dot', 'data-state')) === 'disconnected');
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));

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
