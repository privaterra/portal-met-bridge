// main.js — wires the devices, the recorder, storage, charts and export together.

import { PortalBle, bluetoothSupported, environmentCheck, STEPS } from './portal-ble.js';
import { MeticulousClient, machineSamplesFromSavedShot, normalizeBaseUrl, extractionEndSec, DEFAULT_HOST } from './meticulous.js';
import { MachinePanel } from './machine-panel.js';
import { ShotRecorder } from './recorder.js';
import { Store, coffeeKey } from './store.js';
import { TimeChart, MassChart, CalibrationChart } from './charts.js';
import { analyzeShot, fitCalibration, fitForCoffee, estimateForShot, extractionYield, predictTds, DEFAULTS } from './analysis.js';
import { buildEnvelope, encodeHandoff, encodeForQr } from './beanconqueror.js';
import { makeDemoShot } from './demo.js';
import { chartToJpeg, legendOf, shotReportPdf, shotSamplesCsv, summaryRow, SUMMARY_COLUMNS, rowsToCsv, buildZip, download, stamp, slug } from './export.js';
import { log, Logger, formatLine } from './log.js';
import qrcode from '../vendor/qrcode.mjs';

const $ = (id) => document.getElementById(id);

const store = new Store();
const portal = new PortalBle();
let meticulous = null;
const recorder = new ShotRecorder();
const timeChart = new TimeChart($('chart-time'));
const massChart = new MassChart($('chart-mass'));
const calChart = new CalibrationChart($('chart-cal'));
const machinePanel = new MachinePanel($('view-machine'));

const VIEWS = ['shots', 'machine', 'settings'];

function showView(name) {
  if (!VIEWS.includes(name)) name = 'shots';
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('.view-tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  if (name === 'machine') machinePanel.onShown();
  else if (name === 'shots') {
    timeChart.u.setSize({ width: Math.max(320, $('chart-time').clientWidth), height: 320 });
    massChart.u.setSize({ width: Math.max(320, $('chart-mass').clientWidth), height: 300 });
  } else if (name === 'settings') renderLogTail();
  store.setSetting('view', name);
  try {
    history.replaceState(null, '', '#' + name);
  } catch {
    /* ignore */
  }
}

const state = {
  shots: [],
  selected: null,
  analysis: null,
  fit: null,
  estimate: null,
  liveTimer: null,
  liveDirty: false,
  autoGraphSent: false,
};

// ---------------------------------------------------------------- settings --

/** Every user setting, its default, and the input it is bound to. */
const SETTINGS = {
  meticulousHost: { def: DEFAULT_HOST, el: 'meticulous-host' },
  autoConnectMeticulous: { def: false, el: 'set-autoconnect', bool: true },
  autoAttach: { def: true, el: 'set-autoattach', bool: true },
  attachDelaySec: { def: 4, el: 'set-attach-delay', num: true, min: 1, max: 60 },
  autoRecord: { def: true, el: 'set-autorecord', bool: true },
  settleSec: { def: 6, el: 'settle-sec', num: true, min: 0, max: 60 },
  lagSec: { def: 0, el: 'lag-sec', num: true, min: -2, max: 3 },
  minShotSec: { def: 5, el: 'set-min-shot', num: true, min: 0, max: 60 },
  autoGraph: { def: true, el: 'portal-auto-graph', bool: true },
  minCalibrationShots: { def: 5, el: 'set-min-cal', num: true, min: 2, max: 20 },
  estimatePool: { def: 'auto', el: 'est-pool' },
  logEnabled: { def: false, el: 'log-enabled', bool: true },
  logLevel: { def: 'info', el: 'log-level' },
  logPackets: { def: false, el: 'log-packets', bool: true },
  logSaveExports: { def: false, el: 'log-save-exports', bool: true },
  logShowTail: { def: true, el: 'log-show', bool: true },
};
const settings = {}; // live values

async function loadSettings() {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    let v = await store.getSetting(key, spec.def);
    if (key === 'meticulousHost' && v === 'meticulous.local:8080') v = DEFAULT_HOST; // v0.1 default
    settings[key] = v;
  }
  writeSettings();
}

/** Push the live values into the inputs. */
function writeSettings() {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    const el = $(spec.el);
    if (!el) continue;
    if (spec.bool) el.checked = !!settings[key];
    else el.value = settings[key] ?? '';
  }
  $('meticulous-addr').textContent = settings.meticulousHost || DEFAULT_HOST;
}

/** Read one input, clamp, persist, apply. Returns the stored value. */
async function settingChanged(key) {
  const spec = SETTINGS[key];
  const el = $(spec.el);
  let v = spec.bool ? el.checked : el.value;
  if (spec.num) {
    v = Number(v);
    if (!Number.isFinite(v)) v = spec.def;
    v = Math.min(spec.max, Math.max(spec.min, v));
    el.value = v;
  }
  if (typeof v === 'string') v = v.trim();
  if (settings[key] === v) return v; // e.g. a second 'change' event for the same value
  settings[key] = v;
  await store.setSetting(key, v);
  applySetting(key, v);
  log.info('settings', `${key} = ${JSON.stringify(v)}`);
  return v;
}

/** Side effects of a setting taking a new value. */
function applySetting(key, v) {
  switch (key) {
    case 'meticulousHost':
      $('meticulous-addr').textContent = v || DEFAULT_HOST;
      if (meticulous) {
        try {
          const url = normalizeBaseUrl(v);
          if (url !== meticulous.baseUrl) connectMeticulous();
        } catch {
          /* bad address; leave the connection alone */
        }
      }
      break;
    case 'settleSec':
      recorder.settleSec = v;
      break;
    case 'autoRecord':
      recorder.autoStart = v;
      $('meticulous-hint').textContent = v ? 'Shots start recording on their own when the machine begins extracting.' : 'Automatic recording is off; use "Start recording now".';
      break;
    case 'lagSec':
      if (state.selected) {
        state.selected.lagSec = v;
        store.putShot(state.selected).then(() => renderShot());
      }
      break;
    case 'estimatePool':
    case 'minCalibrationShots':
      if (state.selected) renderShot();
      break;
    case 'logEnabled':
    case 'logLevel':
    case 'logPackets':
      log.configure({ enabled: settings.logEnabled, level: settings.logLevel, packets: settings.logPackets });
      renderLogStatus();
      break;
    case 'logShowTail':
      renderLogTail();
      break;
    default:
      break;
  }
}

/** Settings as a portable JSON document (no file handles, no shots). */
function settingsDocument() {
  const out = { app: 'portal-met-bridge-settings', version: 1, exportedAt: new Date().toISOString(), settings: {}, context: readContext() };
  for (const key of Object.keys(SETTINGS)) out.settings[key] = settings[key];
  return out;
}

async function importSettingsDocument(doc) {
  if (!doc || doc.app !== 'portal-met-bridge-settings' || typeof doc.settings !== 'object') throw new Error('Not a portal-met-bridge settings file.');
  let n = 0;
  for (const [key, spec] of Object.entries(SETTINGS)) {
    if (!(key in doc.settings)) continue;
    let v = doc.settings[key];
    if (spec.bool) v = !!v;
    else if (spec.num) {
      v = Number(v);
      if (!Number.isFinite(v)) continue;
      v = Math.min(spec.max, Math.max(spec.min, v));
    } else v = String(v ?? spec.def);
    settings[key] = v;
    await store.setSetting(key, v);
    n++;
  }
  writeSettings();
  for (const key of Object.keys(SETTINGS)) applySetting(key, settings[key]);
  if (doc.context && typeof doc.context === 'object') {
    writeContext(doc.context);
    await store.setSetting('context', readContext());
  }
  return n;
}

async function resetSettings() {
  for (const [key, spec] of Object.entries(SETTINGS)) {
    settings[key] = spec.def;
    await store.setSetting(key, spec.def);
  }
  writeSettings();
  for (const key of Object.keys(SETTINGS)) applySetting(key, settings[key]);
}

// ------------------------------------------------------------------- setup --

async function init() {
  await loadSettings();
  const hashView = location.hash.replace('#', '');
  const view = VIEWS.includes(hashView) ? hashView : await store.getSetting('view', 'shots');
  showView(view);
  const ctx = await store.getSetting('context', {});
  writeContext(ctx);
  recorder.settleSec = settings.settleSec;
  recorder.autoStart = settings.autoRecord;
  log.configure({ enabled: settings.logEnabled, level: settings.logLevel, packets: settings.logPackets });
  await restoreLogFolder();
  renderLogStatus();
  $('about-version').textContent = 'v0.4.0';
  log.info('app', `portal-met-bridge v0.4.0 started · ${navigator.userAgent}`);

  const env = await environmentCheck();
  renderPortalSteps({ secure: env.secure, api: env.api, adapter: env.adapter });
  if (!env.secure || !env.api) {
    $('portal-connect').disabled = true;
    $('portal-hint').textContent = env.hint;
  } else if (env.adapter === false) {
    $('portal-hint').textContent = env.hint;
  }

  await refreshBeanLists();
  await refreshShotList();
  if (state.shots.length) selectShot(state.shots[0].id);
  if (await store.getSetting('autoConnectMeticulous', false)) connectMeticulous();
}

// ------------------------------------------------------------- Meticulous --

function connectMeticulous() {
  const host = settings.meticulousHost || $('meticulous-host').value;
  let url;
  try {
    url = normalizeBaseUrl(host);
  } catch {
    toast('That address does not look right. Set it under Settings → Machine.', 'error');
    return;
  }
  if (meticulous) {
    machinePanel.detach();
    meticulous.disconnect();
  }
  log.info('machine', `connecting to ${url}`);
  meticulous = new MeticulousClient(url);
  meticulous.addEventListener('state', (e) => {
    const d = e.detail;
    log.info('machine', `socket ${d.state}${d.error ? ': ' + d.error : ''}${d.reason ? ' (' + d.reason + ')' : ''}`);
    setLink('meticulous', d.state, d.state === 'connected' ? url.replace(/^https?:\/\//, '') : d.state === 'error' ? d.error : d.state);
    $('meticulous-connect').disabled = d.state === 'connected' || d.state === 'connecting';
    $('meticulous-disconnect').disabled = d.state === 'disconnected';
    $('mach-last').disabled = d.state !== 'connected';
    $('shot-refresh').disabled = d.state !== 'connected' || !state.selected;
  });
  meticulous.addEventListener('status', (e) => onStatus(e.detail));
  meticulous.connect();
  machinePanel.attach(meticulous);
  meticulous.ping().then(
    (s) => {
      log.info('machine', `REST answered: ${s?.totalSavedShots ?? '?'} saved shots`);
      $('meticulous-hint').textContent = `Machine answered: ${s?.totalSavedShots ?? '?'} saved shots. ${settings.autoRecord ? 'Recording starts on its own when extraction begins.' : 'Automatic recording is off.'}`;
    },
    (err) => {
      log.warn('machine', `REST ping failed: ${err?.message || err}`);
      $('meticulous-hint').textContent = 'No answer on /api/v1. Check the address under Settings (the machine serves on port 80) and that this Mac is on the same network.';
    },
  );
}

/** Settings → Test connection: REST ping + device info, without touching the live socket. */
async function testMeticulous() {
  const out = $('meticulous-test-result');
  let url;
  try {
    url = normalizeBaseUrl($('meticulous-host').value);
  } catch {
    out.textContent = 'That address does not look right.';
    return;
  }
  out.textContent = `Trying ${url} …`;
  const probe = new MeticulousClient(url);
  try {
    const t0 = performance.now();
    const [stats, info] = await Promise.all([probe.ping(), probe.machineInfo().catch(() => null)]);
    const ms = Math.round(performance.now() - t0);
    out.textContent = `OK in ${ms} ms — ${info?.name || 'machine'} · firmware ${info?.firmware || '?'} · ${stats?.totalSavedShots ?? '?'} saved shots`;
    log.info('machine', `test ${url}: ok ${ms} ms`, { firmware: info?.firmware, shots: stats?.totalSavedShots });
  } catch (err) {
    out.textContent = `No answer: ${err?.message || err}. The machine serves on port 80; check the IP and that you are on the same network.`;
    log.warn('machine', `test ${url} failed: ${err?.message || err}`);
  }
}

function disconnectMeticulous() {
  log.info('machine', 'disconnect requested');
  machinePanel.detach();
  meticulous?.disconnect();
  meticulous = null;
  setLink('meticulous', 'idle', 'not connected');
  $('meticulous-connect').disabled = false;
  $('meticulous-disconnect').disabled = true;
}

let lastStatusLog = 0;
function onStatus(s) {
  if (settings.logPackets) log.packet('machine', `status ${s.name}/${s.state} ext=${s.extracting} t=${s.timeMs} p=${fmt(s.p, 2)} f=${fmt(s.f, 2)} w=${fmt(s.w, 2)} T=${fmt(s.temp, 1)}`);
  else if (s.extracting && performance.now() - lastStatusLog > 1000) {
    lastStatusLog = performance.now();
    log.debug('machine', `${s.name} t=${(s.timeMs / 1000).toFixed(1)} p=${fmt(s.p, 1)} f=${fmt(s.f, 2)} w=${fmt(s.w, 1)}`);
  }
  setText('ro-weight', fmt(s.w, 1));
  setText('ro-flow', fmt(s.f, 2));
  setText('ro-pressure', fmt(s.p, 1));
  if (recorder.isRecording) {
    setText('ro-time', fmt((performance.now() - recorder.wallZero) / 1000, 1));
    setText('ro-stage', s.name || s.state || 'extracting');
  } else {
    setText('ro-stage', s.state || s.name || 'idle');
  }
  recorder.onStatus(s);
}

// ----------------------------------------------------------------- Portal --

portal.addEventListener('state', (e) => {
  const d = e.detail;
  log.info('portal', `state ${d.state}${d.name ? ' ' + d.name : ''}${d.error ? ': ' + d.error : ''}`);
  // Connected (or reconnected) while a shot is already running: switch the screen now.
  if (d.state === 'connected' && recorder.isRecording && settings.autoGraph && !state.autoGraphSent) {
    state.autoGraphSent = true;
    portal.showGraph().catch((err) => log.warn('portal', `show-graph failed: ${err?.message || err}`));
  }
  setLink('portal', d.state, d.state === 'connected' ? d.name : d.state === 'lost' ? 'connection lost' : d.state);
  const on = d.state === 'connected';
  $('portal-disconnect').disabled = !on;
  $('portal-show-graph').disabled = !on || !portal.command;
  $('portal-hide-graph').disabled = !on || !portal.command;
  if (!on) {
    setText('ro-ec', '–');
    setText('ro-tout', '–');
  }
});
portal.addEventListener('measurement', (e) => {
  const m = e.detail;
  setText('ro-ec', m.ec.toFixed(3));
  setText('ro-tout', m.tOut.toFixed(1));
  $('portal-detail').textContent = `${portal.device?.name || 'Portal'} · status ${m.status}`;
  log.packet('portal', `ec ${m.ec.toFixed(4)} tInt ${m.tInt.toFixed(2)} tOut ${m.tOut.toFixed(2)} status ${m.status}`);
  if (portal.packetCount % 8 === 1) {
    $('portal-raw').textContent = `Last packet: EC ${m.ec.toFixed(4)} · internal ${m.tInt.toFixed(1)} °C · outlet ${m.tOut.toFixed(1)} °C · status ${m.status} · bytes ${m.raw.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`;
    $('portal-rate').textContent = `· ${portal.packetRate().toFixed(1)}/s`;
  }
  recorder.onPortal(m);
});
portal.addEventListener('malformed', (e) => {
  log.warn('portal', `notification of unexpected length ${e.detail.byteLength} B`);
});
portal.addEventListener('step', (e) => {
  log.debug('portal', `step ${e.detail.name}: ${JSON.stringify(e.detail.value)}`);
  renderPortalSteps(e.detail.steps);
});

/** Paint the connection-check list: true ✓, false ✗, string = note, null = pending. */
function renderPortalSteps(steps) {
  let ok = 0;
  let bad = false;
  for (const name of STEPS) {
    const li = document.querySelector(`#portal-steps li[data-step="${name}"]`);
    if (!li) continue;
    const v = steps[name];
    li.querySelector('.why')?.remove();
    if (v === true) {
      li.dataset.ok = 'true';
      ok++;
    } else if (v === false) {
      li.dataset.ok = 'false';
      bad = true;
    } else if (typeof v === 'string') {
      const soft = name === 'command' || name === 'device';
      li.dataset.ok = soft ? (name === 'device' ? 'true' : 'warn') : 'false';
      if (name === 'device') ok++;
      else if (!soft) bad = true;
      const span = document.createElement('span');
      span.className = 'why' + (soft ? ' warn' : '');
      span.textContent = '— ' + v;
      li.appendChild(span);
    } else {
      delete li.dataset.ok;
    }
  }
  const all = steps.packet === true;
  $('portal-check-summary').textContent = all ? '— connected to the Portal, packets flowing' : bad ? '— a step failed' : ok ? `— ${ok}/${STEPS.length}` : '';
  if (all || bad) $('portal-check').open = true;
}

async function connectPortal() {
  try {
    await portal.pick({ acceptAll: $('portal-accept-all').checked });
    toast(`Connected to ${portal.device?.name || 'the Portal'} — the connection check shows each step.`);
  } catch (err) {
    if (err?.name === 'NotFoundError') {
      // The chooser closed with nothing picked: either cancelled, or no Portal was visible.
      $('portal-hint').textContent = 'No device picked. If the Portal was missing from Chrome’s list: wake it, close the Belka app on your phone, and try "Show every nearby Bluetooth device".';
      return;
    }
    toast(err.message || String(err), 'error');
  }
}

// --------------------------------------------------------------- recorder --

recorder.addEventListener('state', (e) => {
  const d = e.detail;
  log.info('recorder', `→ ${d.state}${d.t !== undefined ? ' at ' + d.t.toFixed(1) + ' s' : ''}`);
  const ind = $('rec-indicator');
  ind.dataset.state = d.state;
  $('rec-text').textContent = d.state === 'recording' ? 'Recording' : d.state === 'settling' ? 'Pump stopped — catching the last drips' : 'Waiting for a shot';
  $('rec-manual').textContent = d.state === 'idle' ? 'Start recording now' : 'Stop and save';
  if (d.state === 'recording') {
    $('shot-title').textContent = 'Live shot';
    $('shot-sub').textContent = d.shot?.profileName ? `Profile: ${d.shot.profileName}` : '';
    massChart.setAnalysis(null);
    startLiveLoop();
    if (portal.connected && settings.autoGraph && !state.autoGraphSent) {
      state.autoGraphSent = true;
      portal.showGraph().then(() => log.info('portal', 'show-graph sent')).catch((err) => log.warn('portal', `show-graph failed: ${err?.message || err}`));
    }
  }
  if (d.state === 'idle') {
    stopLiveLoop();
    if (state.autoGraphSent) {
      state.autoGraphSent = false;
      if (portal.connected) portal.hideGraph().then(() => log.info('portal', 'hide-graph sent')).catch((err) => log.warn('portal', `hide-graph failed: ${err?.message || err}`));
    }
  }
});
recorder.addEventListener('sample', () => {
  state.liveDirty = true;
});
recorder.addEventListener('shot', async (e) => {
  const shot = e.detail;
  if (shot.machine.length + shot.portal.length < 5 || (!shot.manual && shot.durationSec < settings.minShotSec)) {
    log.info('recorder', `discarded a ${shot.durationSec.toFixed(1)} s recording (${shot.machine.length} machine, ${shot.portal.length} Portal samples; minimum ${settings.minShotSec} s)`);
    toast(`Recording was shorter than ${settings.minShotSec} s and was not kept (change this under Settings → Recording).`);
    return;
  }
  shot.context = readContext();
  shot.lagSec = settings.lagSec || 0;
  recomputeCache(shot);
  await store.putShot(shot);
  await store.rememberBean(shot.context);
  await refreshBeanLists();
  await refreshShotList();
  selectShot(shot.id);
  log.info('recorder', `saved shot ${shot.id}: ${fmt(shot.finalWeightG, 1)} g in ${fmt(shot.durationSec, 1)} s, ${shot.machine.length} machine + ${shot.portal.length} Portal samples`);
  toast(`Saved shot — ${fmt(shot.finalWeightG, 1)} g in ${fmt(shot.durationSec, 1)} s`);
  if (settings.autoAttach && meticulous?.connected && !shot.manual) setTimeout(() => refreshFromMachine(shot.id, true), settings.attachDelaySec * 1000);
});

function startLiveLoop() {
  stopLiveLoop();
  state.liveTimer = setInterval(() => {
    if (!state.liveDirty || !recorder.shot) return;
    state.liveDirty = false;
    timeChart.setShot(recorder.shot.machine, recorder.shot.portal);
    if (recorder.shot.portal.length > 5 && recorder.shot.machine.length > 5) {
      const a = analyzeShot(recorder.shot.portal, recorder.shot.machine.map((s) => ({ t: s.t, w: s.w })), { lagSec: settings.lagSec || 0 });
      if (a.curve?.length) massChart.setAnalysis(a);
    }
  }, 250);
}
function stopLiveLoop() {
  if (state.liveTimer) clearInterval(state.liveTimer);
  state.liveTimer = null;
}

// ------------------------------------------------------------------ shots --

async function refreshShotList() {
  state.shots = await store.listShots();
  const ul = $('shot-list');
  ul.innerHTML = '';
  $('shot-count').textContent = state.shots.length ? `(${state.shots.length})` : '';
  for (const s of state.shots) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (s.id === state.selected?.id) li.classList.add('selected');
    const a = s.analysisCache;
    const meanEc = a?.meanEcPerG;
    li.innerHTML = `<span class="when">${fmtDate(s.startedAt)}</span><span class="ec">${Number.isFinite(meanEc) ? meanEc.toFixed(2) : '—'}</span>` +
      `<span class="what">${s.refractometer?.tdsPct ? `<b>TDS ${s.refractometer.tdsPct.toFixed(2)}</b> · ` : ''}${esc(s.context?.beanName || 'no bean')} · ${fmt(s.finalWeightG, 1)} g · ${fmt(s.durationSec, 0)} s${s.source === 'demo' ? ' · demo' : s.source === 'machine' ? ' · machine only' : ''}</span>`;
    li.addEventListener('click', () => selectShot(s.id));
    ul.appendChild(li);
  }
}

async function selectShot(id) {
  const shot = await store.getShot(id);
  if (!shot) return;
  state.selected = shot;
  document.querySelectorAll('.shot-list li').forEach((li) => li.classList.toggle('selected', li.dataset.id === id));
  renderShot();
}

function renderShot() {
  const shot = state.selected;
  const ctx = shot.context || {};
  $('shot-title').textContent = `${fmtDate(shot.startedAt)}${shot.profileName ? ' — ' + shot.profileName : ''}`;
  $('shot-sub').textContent = [
    ctx.beanName,
    ctx.doseG ? `${ctx.doseG} g in` : null,
    `${fmt(shot.finalWeightG, 1)} g out`,
    `${fmt(shot.durationSec, 1)} s`,
    `${shot.machine.length} machine · ${shot.portal.length} Portal samples`,
    shot.machineSource ? 'machine record attached' : null,
  ].filter(Boolean).join(' · ');
  $('shot-delete').disabled = false;
  $('shot-refresh').disabled = !meticulous?.connected;
  for (const id of ['bc-copy', 'bc-open', 'bc-json', 'dl-csv', 'dl-json', 'dl-jpeg', 'dl-pdf', 'ref-save']) $(id).disabled = false;
  $('ref-clear').disabled = !shot.refractometer;
  $('ref-tds').value = shot.refractometer?.tdsPct ?? '';
  $('ref-bev').value = shot.refractometer?.beverageG ?? '';
  $('ref-bev').placeholder = fmt(shot.finalWeightG, 1);

  timeChart.setShot(shot.machine, shot.portal);
  const lag = Number.isFinite(shot.lagSec) ? shot.lagSec : settings.lagSec || 0;
  state.analysis = analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w })), { doseG: Number(ctx.doseG) || 0, lagSec: lag, stopTimeSec: shot.durationSec });
  massChart.setAnalysis(state.analysis);
  renderMetrics(state.analysis);
  renderCalibration();
  renderExport();
  updateRefEy();
}

function renderMetrics(a) {
  const m = $('metrics');
  const cells = [];
  const cell = (v, unit, k) => cells.push(`<div class="metric"><div class="v">${v}<small>${unit}</small></div><div class="k">${k}</div></div>`);
  if (a.status === 'no-portal-data') {
    m.innerHTML = '';
    setStatus('analysis-status', 'No Portal samples in this shot, so there is nothing to integrate. Machine data only.', 'warn');
    return;
  }
  cell(fmt(a.meanEcPerG, 3), 'mS/cm', 'mean EC per gram');
  cell(fmt(a.integralEcG, 1), 'mS·g/cm', '∫EC dm over the cup');
  cell(fmt(a.mainPeakEc, 3), 'mS/cm', `peak EC at ${fmt(a.mainPeakMassG, 1)} g`);
  cell(fmt(a.tail.last5g?.mean, 3), 'mS/cm', 'mean over the last 5 g');
  cell(fmt(a.tail.last5g?.slopePerG, 3), 'mS/cm per g', 'slope over the last 5 g');
  cell(fmt((a.tail.last5g?.share ?? 0) * 100, 0), '%', 'of ∫ from the last 5 g');
  cell(fmt(a.massAt90PctG, 1), 'g', 'cup mass at 90% of ∫');
  cell(fmt(a.coverageRatio * 100, 0), '%', 'of cup mass covered by the Portal');
  cell(fmt(a.firstDropTimeSec, 1), 's', 'first drop');
  cell(fmt(a.meanTempC, 1), '°C', `at the Portal (max ${fmt(a.maxTempC, 1)})`);
  m.innerHTML = cells.join('');
  const level = a.status === 'ok' ? 'ok' : 'warn';
  const msg = a.status === 'ok' ? 'Shot is usable for calibration and estimates.' + (a.reasons.length ? ' ' + a.reasons.join(' ') : '') : a.reasons.join(' ') || a.status;
  setStatus('analysis-status', msg, level);
}

/** Every shot with a refractometer reading, as a calibration point carrying its coffee identity. */
function allCalibrationPoints(shots = state.shots) {
  return shots
    .filter((s) => s.refractometer?.tdsPct && s.analysisCache && s.analysisCache.meanEcPerG > 0)
    .map((s) => ({
      id: s.id,
      meanEcPerG: s.analysisCache.meanEcPerG,
      tdsPct: s.refractometer.tdsPct,
      reliable: s.analysisCache.status === 'ok',
      meanTempC: s.analysisCache.meanTempC,
      when: s.startedAt,
      coffeeKey: s.coffeeKey || coffeeKey(s.context?.beanName),
      roasterKey: s.roasterKey || coffeeKey(s.context?.roaster),
      roastLevel: s.context?.roastLevel || '',
      beanName: s.context?.beanName || '',
    }));
}

function coffeeIdentity(shot) {
  const c = shot.context || {};
  return { coffeeKey: coffeeKey(c.beanName), roasterKey: coffeeKey(c.roaster), roastLevel: c.roastLevel || '' };
}

/** Fit + estimate for any shot under the current "estimate from" setting. */
function estimateShot(shot, analysis, { excludeSelf = true, points } = {}) {
  const mode = settings.estimatePool || 'auto';
  const fit = fitForCoffee(points || allCalibrationPoints(), coffeeIdentity(shot), mode, { excludeId: excludeSelf ? shot.id : undefined, minShots: settings.minCalibrationShots });
  const estimate = estimateForShot(analysis, fit, { beverageG: shot.refractometer?.beverageG || shot.finalWeightG, doseG: Number(shot.context?.doseG) || 0, poolLabel: fit.poolLabel });
  if (fit.calibrated && fit.pool !== 'bean') estimate.flags.unshift(`Borrowed from ${fit.poolLabel}: ${fit.shotCount} shot${fit.shotCount === 1 ? '' : 's'} of ${fit.distinctCoffees} coffee${fit.distinctCoffees === 1 ? '' : 's'}${fit.fallbackFrom ? ' (no readings for this bean yet)' : ''}.`);
  return { fit, estimate };
}

function renderCalibration() {
  const shot = state.selected;
  const key = coffeeKey(shot.context?.beanName);
  // Each reviewed shot is excluded from its own fit (leave-one-out for the estimate).
  const { fit, estimate } = estimateShot(shot, state.analysis);
  state.fit = fit;
  state.estimate = estimate;
  $('cal-coffee').textContent = fit.pool === 'bean' ? shot.context?.beanName || 'this coffee' : fit.poolLabel;

  // The chart shows the chosen pool including this shot, so the point you just saved is visible.
  const poolPts = fitForCoffee(allCalibrationPoints(), coffeeIdentity(shot), fit.pool, { minShots: settings.minCalibrationShots }).poolPoints;
  calChart.setFit(poolPts, fitCalibration(poolPts), predictTds);

  const dl = $('cal-stats');
  const rows = [];
  if (!key) rows.push(['Bean', 'Give this shot a bean name so its reading can be grouped.']);
  rows.push(['Pool', `${fit.poolLabel}${fit.mode === 'auto' ? ' (auto)' : ''} — ${poolPts.length} reference shot${poolPts.length === 1 ? '' : 's'}${fit.distinctCoffees > 1 ? ` across ${fit.distinctCoffees} coffees` : ''}${poolPts.length !== fit.shotCount ? ` (${fit.shotCount} used; this shot is left out)` : ''}`]);
  if (fit.calibrated) {
    const p = fit.proportional;
    rows.push(['Proportional k', `${p.k.toFixed(3)} %TDS per (mS/cm) — leave-one-out error ${isFinite(p.loocvRmse) ? '±' + p.loocvRmse.toFixed(2) + '% TDS' : 'n/a'}`]);
    if (fit.affine) rows.push(['Affine', `${fit.affine.a.toFixed(3)}·x + ${fit.affine.b.toFixed(2)} — leave-one-out ±${fit.affine.loocvRmse.toFixed(2)}% TDS`]);
    rows.push(['Active model', fit.activeModel + (fit.preliminary ? ' (preliminary)' : '')]);
    rows.push(['Measured EC/g range', `${fit.minX.toFixed(3)} – ${fit.maxX.toFixed(3)}`]);
    if (fit.tempCorrelation !== null) rows.push(['Residual vs outlet temp', `r = ${fit.tempCorrelation.toFixed(2)}`]);
  }
  dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  setText('est-tds', Number.isFinite(estimate.tdsPct) ? estimate.tdsPct.toFixed(2) : '–');
  setText('est-ey', Number.isFinite(estimate.eyPct) ? estimate.eyPct.toFixed(1) : '–');
  $('est-basis').textContent = fit.calibrated ? `Based on ${fit.poolLabel} · ${fit.activeModel} model · ${fit.shotCount} reference shot${fit.shotCount === 1 ? '' : 's'}` : '';
  $('est-flags').innerHTML = estimate.flags.map((f) => `<li>${esc(f)}</li>`).join('');
}

async function saveRefractometer() {
  const shot = state.selected;
  const tds = Number($('ref-tds').value);
  if (!(tds > 0 && tds < 30)) {
    toast('Enter the refractometer TDS as a percentage, e.g. 9.2.', 'error');
    return;
  }
  const bev = Number($('ref-bev').value) || shot.finalWeightG;
  const dose = Number(shot.context?.doseG) || 0;
  shot.refractometer = { tdsPct: tds, beverageG: bev, eyPct: extractionYield(tds, bev, dose), at: Date.now() };
  shot.analysisCache = summarize(state.analysis);
  await store.putShot(shot);
  await refreshShotList();
  renderShot();
  toast('Reading saved; calibration updated.');
}

async function clearRefractometer() {
  const shot = state.selected;
  delete shot.refractometer;
  await store.putShot(shot);
  await refreshShotList();
  renderShot();
}

function updateRefEy() {
  const shot = state.selected;
  const tds = Number($('ref-tds').value);
  const bev = Number($('ref-bev').value) || shot?.finalWeightG;
  const dose = Number(shot?.context?.doseG) || 0;
  const ey = extractionYield(tds, bev, dose);
  $('ref-ey').textContent = tds > 0 ? (ey ? `→ EY ${ey.toFixed(1)}% at ${dose} g in` : 'Add a dose to get EY') : '';
}

async function deleteShot() {
  const shot = state.selected;
  if (!shot || !confirm('Delete this shot and its readings?')) return;
  await store.deleteShot(shot.id);
  state.selected = null;
  await refreshShotList();
  if (state.shots.length) selectShot(state.shots[0].id);
  else {
    $('shot-title').textContent = 'No shot selected';
    $('shot-sub').textContent = '';
    timeChart.setShot([], []);
    massChart.setAnalysis(null);
    $('metrics').innerHTML = '';
    $('qr').innerHTML = '';
  }
}

/** Keep the numbers the list and calibration need without re-running analysis per shot. */
function summarize(a) {
  if (!a) return null;
  return { status: a.status, meanEcPerG: a.meanEcPerG, integralEcG: a.integralEcG, coverageRatio: a.coverageRatio, mainPeakEc: a.mainPeakEc, meanTempC: a.meanTempC, totalMassG: a.totalMassG };
}

function recomputeCache(shot) {
  const lag = Number.isFinite(shot.lagSec) ? shot.lagSec : 0;
  const a = analyzeShot(shot.portal || [], (shot.machine || []).map((s) => ({ t: s.t, w: s.w })), { doseG: Number(shot.context?.doseG) || 0, lagSec: lag, stopTimeSec: shot.durationSec });
  shot.analysisCache = summarize(a);
  return a;
}

// --------------------------------------------------------- machine record --

async function fetchLastFromMachine() {
  if (!meticulous) return;
  try {
    const saved = await meticulous.lastShot();
    if (!saved) {
      $('mach-info').textContent = 'The machine has no saved shot yet.';
      return;
    }
    const samples = machineSamplesFromSavedShot(saved);
    const startedAt = saved.time * 1000;
    // Attach to a live recording from the same moment, else store as its own entry.
    const match = state.shots.find((s) => s.source === 'live' && Math.abs(s.startedAt - startedAt) < 45000);
    if (match) {
      await attachMachineRecord(match, saved, samples);
      $('mach-info').textContent = `Attached the machine's record to the ${fmtDate(match.startedAt)} shot.`;
      await refreshShotList();
      selectShot(match.id);
    } else {
      if (state.shots.some((s) => s.machineShotId === saved.id)) {
        $('mach-info').textContent = 'That machine shot is already in the list.';
        return;
      }
      const shot = {
        id: 'machine-' + saved.id,
        machineShotId: saved.id,
        startedAt,
        endedAt: startedAt + (samples.at(-1)?.t ?? 0) * 1000,
        profileName: saved.name || saved.profile_name || saved.profile?.name || null,
        profileTemperatureC: saved.profile?.temperature,
        finalWeightG: Math.max(0, ...samples.map((s) => s.w || 0)),
        durationSec: extractionEndSec(samples),
        machine: samples,
        portal: [],
        source: 'machine',
        machineSource: saved,
        context: readContext(),
      };
      await store.putShot(shot);
      await refreshShotList();
      selectShot(shot.id);
      $('mach-info').textContent = 'Added the machine’s last shot (no Portal data).';
    }
  } catch (err) {
    toast('Could not read the machine’s history: ' + (err.message || err), 'error');
  }
}

async function refreshFromMachine(id, quiet = false) {
  if (!meticulous) return;
  const shot = await store.getShot(id);
  if (!shot) return;
  try {
    const saved = await meticulous.lastShot();
    if (saved && Math.abs(saved.time * 1000 - shot.startedAt) < 45000) {
      await attachMachineRecord(shot, saved, machineSamplesFromSavedShot(saved));
      await refreshShotList();
      if (state.selected?.id === id) selectShot(id);
      if (!quiet) toast('Replaced the live machine samples with the machine’s saved record.');
    } else if (!quiet) {
      toast('The machine’s last saved shot is from a different time.');
    }
  } catch (err) {
    if (!quiet) toast('Could not reach the machine: ' + (err.message || err), 'error');
  }
}

async function attachMachineRecord(shot, saved, samples) {
  if (samples.length >= 2) {
    // Live machine samples already use the machine's own time, so no shift is
    // needed. The saved record has no per-sample brew temperature, so carry the
    // live temperature series over by nearest time.
    const live = (shot.machine || []).filter((s) => Number.isFinite(s.t) && Number.isFinite(s.temp));
    if (live.length) {
      let j = 0;
      for (const s of samples) {
        while (j < live.length - 1 && live[j + 1].t <= s.t) j++;
        const a = live[j];
        const b = live[Math.min(j + 1, live.length - 1)];
        s.temp = Math.abs(a.t - s.t) <= Math.abs(b.t - s.t) ? a.temp : b.temp;
      }
    }
    shot.machine = samples;
    shot.finalWeightG = Math.max(shot.finalWeightG || 0, ...samples.map((s) => s.w || 0));
    // The machine's record ends with a "retracting" stage; the extraction proper ends before it.
    shot.durationSec = Math.max(shot.durationSec || 0, extractionEndSec(samples));
  }
  shot.machineShotId = saved.id;
  shot.profileName = saved.profile_name || saved.profile?.name || shot.profileName;
  shot.profileTemperatureC = saved.profile?.temperature ?? shot.profileTemperatureC;
  shot.machineSource = { id: saved.id, time: saved.time, profile: saved.profile ?? null, profile_name: saved.profile_name ?? null };
  recomputeCache(shot);
  await store.putShot(shot);
}

// ----------------------------------------------------------------- export --

async function renderExport() {
  const shot = state.selected;
  const ctx = shot.context || {};
  const qrEl = $('qr');
  qrEl.innerHTML = '';
  $('qr-info').textContent = 'Building…';
  try {
    const qr = await encodeForQr(shot, state.analysis, state.estimate, ctx);
    if (qr) {
      const q = qrcode(0, 'L');
      q.addData(qr.url, 'Byte');
      q.make();
      qrEl.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      const pts = qr.envelope.flow?.t?.length ?? 0;
      $('qr-info').textContent = `${qr.urlChars} characters · ${pts} flow points${qr.envelope.metrics ? ' · ' + qr.envelope.metrics.map((m) => m.name).join(', ') : ''}.`;
    } else {
      $('qr-info').textContent = 'Too large for a QR code; use the link.';
    }
  } catch (err) {
    $('qr-info').textContent = 'QR failed: ' + (err.message || err);
  }
}

async function fullLink() {
  const shot = state.selected;
  const env = buildEnvelope(shot, state.analysis, state.estimate, shot.context || {});
  return { env, ...(await encodeHandoff(env)) };
}

async function copyFullLink() {
  try {
    const { url, urlChars, chunks } = await fullLink();
    await navigator.clipboard.writeText(url);
    toast(`Copied the Beanconqueror link (${urlChars} characters, ${chunks} chunks). Paste it into Notes or Messages and tap it on the phone.`);
  } catch (err) {
    toast('Copy failed: ' + (err.message || err), 'error');
  }
}

async function openLink() {
  const { url } = await fullLink();
  window.location.href = url;
}

async function downloadEnvelope() {
  const { env } = await fullLink();
  deliver(`beanconqueror-${stamp(state.selected.startedAt)}.json`, JSON.stringify(env, null, 2), 'application/json');
}

// ---------------------------------------------------------- files out --

/**
 * Hand a file to the user: into the chosen folder (Settings → Logging) when
 * "save exports there" is on and the folder is writable, else a browser download.
 */
async function deliver(name, data, type, sub = 'exports') {
  if (settings.logSaveExports && log.folder && log.folderState === 'granted') {
    try {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
      const path = await log.saveFile(sub, name, blob);
      log.info('export', `saved ${path} (${blob.size} B)`);
      toast(`Saved ${path}`);
      return path;
    } catch (err) {
      log.warn('export', `folder save failed for ${name}: ${err?.message || err}; downloading instead`);
    }
  }
  log.info('export', `download ${name}`);
  download(name, data, type);
  return null;
}

const fileBase = (shot) => `shot-${stamp(shot.startedAt)}-${slug(shot.context?.beanName)}`;

function shotJson(shot, analysis, estimate) {
  return JSON.stringify({ app: 'portal-met-bridge', version: 2, shot, analysis, estimate }, null, 2);
}

function downloadShotJson() {
  const shot = state.selected;
  deliver(`${fileBase(shot)}.json`, shotJson(shot, state.analysis, state.estimate), 'application/json');
}

function downloadCsv() {
  const shot = state.selected;
  deliver(`${fileBase(shot)}.csv`, shotSamplesCsv(shot), 'text/csv');
}

/** Render both charts for a shot to JPEG. Charts must be visible (Shots view). */
async function chartImages(shot, analysis) {
  const c = shot.context || {};
  const sub = [fmtDate(shot.startedAt), shot.profileName, c.beanName, c.doseG ? `${c.doseG} g in` : null, `${fmt(shot.finalWeightG, 1)} g out`, `${fmt(shot.durationSec, 1)} s`].filter(Boolean).join(' · ');
  const time = await chartToJpeg(timeChart.u, { title: 'Shot against time', subtitle: sub, legend: legendOf(timeChart.u) });
  let mass = null;
  if (analysis?.curve?.length) {
    const sub2 = `mean EC ${fmt(analysis.meanEcPerG, 3)} mS/cm · ∫EC dm ${fmt(analysis.integralEcG, 1)} · peak ${fmt(analysis.mainPeakEc, 3)} at ${fmt(analysis.mainPeakMassG, 1)} g · 90 % of ∫ at ${fmt(analysis.massAt90PctG, 1)} g`;
    mass = await chartToJpeg(massChart.u, { title: 'Conductivity against cup mass', subtitle: sub2, legend: legendOf(massChart.u) });
  }
  return { time, mass };
}

async function downloadJpegs() {
  const shot = state.selected;
  if ($('view-shots').hidden) showView('shots');
  const { time, mass } = await chartImages(shot, state.analysis);
  await deliver(`${fileBase(shot)}-time.jpg`, time.blob);
  if (mass) {
    await new Promise((r) => setTimeout(r, 300));
    await deliver(`${fileBase(shot)}-ec-vs-mass.jpg`, mass.blob);
  }
}

function reportFor(shot, analysis, estimate, fit, images) {
  const c = shot.context || {};
  const a = analysis || {};
  const metrics = [
    ['Profile', shot.profileName || '–'],
    ['Bean', c.beanName || '–'],
    ['Roaster', c.roaster || '–'],
    ['Roast · process · origin', [c.roastLevel, c.process, c.origin].filter(Boolean).join(' · ') || '–'],
    ['Dose', c.doseG ? `${c.doseG} g` : '–'],
    ['Grind · grinder', [c.grindSize, c.grinderName].filter(Boolean).join(' · ') || '–'],
    ['Beverage', `${fmt(shot.finalWeightG, 1)} g`],
    ['Extraction', `${fmt(shot.durationSec, 1)} s`],
    ['Samples', `${shot.machine?.length ?? 0} machine · ${shot.portal?.length ?? 0} Portal`],
    ['Analysis', a.status || '–'],
    ['Mean EC per g', `${fmt(a.meanEcPerG, 3)} mS/cm`],
    ['∫EC dm', `${fmt(a.integralEcG, 1)} mS·g/cm`],
    ['Peak EC', `${fmt(a.mainPeakEc, 3)} at ${fmt(a.mainPeakMassG, 1)} g`],
    ['Last 5 g', `mean ${fmt(a.tail?.last5g?.mean, 3)} · slope ${fmt(a.tail?.last5g?.slopePerG, 3)}/g`],
    ['Mass at 90 % of ∫', `${fmt(a.massAt90PctG, 1)} g`],
    ['Portal coverage', `${fmt((a.coverageRatio ?? 0) * 100, 0)} %`],
    ['First drop', `${fmt(a.firstDropTimeSec, 1)} s`],
    ['Portal temperature', `${fmt(a.meanTempC, 1)} °C mean · ${fmt(a.maxTempC, 1)} max`],
  ];
  const est = [
    ['Refractometer TDS', shot.refractometer?.tdsPct ? `${shot.refractometer.tdsPct.toFixed(2)} %` : '–'],
    ['Refractometer EY', Number.isFinite(shot.refractometer?.eyPct) ? `${shot.refractometer.eyPct.toFixed(1)} %` : '–'],
    ['Estimated TDS', Number.isFinite(estimate?.tdsPct) ? `${estimate.tdsPct.toFixed(2)} %` : '–'],
    ['Estimated EY', Number.isFinite(estimate?.eyPct) ? `${estimate.eyPct.toFixed(1)} %` : '–'],
    ['Based on', fit?.calibrated ? `${fit.poolLabel} · ${fit.activeModel} · ${fit.shotCount} shots` : 'no calibration'],
    ['k (proportional)', fit?.proportional ? `${fit.proportional.k.toFixed(3)} ± ${isFinite(fit.proportional.loocvRmse) ? fit.proportional.loocvRmse.toFixed(2) : '–'} % TDS` : '–'],
  ];
  const notes = [...(estimate?.flags || [])];
  if (c.note) notes.push(c.note);
  notes.push('EC is a conductivity proxy; TDS/EY here are estimates from refractometer calibration unless a refractometer reading is shown.');
  const imgs = [];
  if (images.time) imgs.push({ ...images.time, caption: 'Pressure, flow, weight and Portal EC against time; dotted lines mark the machine’s stages.' });
  if (images.mass) imgs.push({ ...images.mass, caption: 'Portal EC against cumulative cup mass; the shaded area is ∫EC dm, the dashed line its running share.' });
  return {
    title: `${fmtDate(shot.startedAt)}${shot.profileName ? ' — ' + shot.profileName : ''}`,
    subtitle: [c.beanName, c.roaster, c.doseG ? `${c.doseG} g → ${fmt(shot.finalWeightG, 1)} g in ${fmt(shot.durationSec, 1)} s` : null].filter(Boolean).join(' · '),
    images: imgs,
    metrics,
    estimate: est,
    notes,
  };
}

async function downloadPdf() {
  const shot = state.selected;
  if ($('view-shots').hidden) showView('shots');
  toast('Building the PDF…');
  try {
    const images = await chartImages(shot, state.analysis);
    const blob = await shotReportPdf(reportFor(shot, state.analysis, state.estimate, state.fit, images));
    deliver(`${fileBase(shot)}-report.pdf`, blob);
  } catch (err) {
    toast('PDF failed: ' + (err.message || err), 'error');
  }
}

/** Analysis + estimate for every shot, computed once for the summary and the zip. */
async function analyseAll() {
  const shots = await store.listShots({ limit: 100000 });
  const points = allCalibrationPoints(shots);
  return shots.map((shot) => {
    const analysis = recomputeCache(shot);
    const mode = settings.estimatePool || 'auto';
    const fit = fitForCoffee(points, coffeeIdentity(shot), mode, { excludeId: shot.id, minShots: settings.minCalibrationShots });
    const estimate = estimateForShot(analysis, fit, { beverageG: shot.refractometer?.beverageG || shot.finalWeightG, doseG: Number(shot.context?.doseG) || 0, poolLabel: fit.poolLabel });
    return { shot, analysis, estimate, fit };
  });
}

async function downloadSummaryCsv() {
  const all = await analyseAll();
  const rows = [SUMMARY_COLUMNS, ...all.map(({ shot, analysis, estimate }) => summaryRow(shot, analysis, estimate))];
  deliver(`portal-met-bridge-shots-${stamp(Date.now())}.csv`, rowsToCsv(rows), 'text/csv');
}

async function downloadZip() {
  const all = await analyseAll();
  if (!all.length) {
    toast('No shots to export yet.');
    return;
  }
  if ($('view-shots').hidden) showView('shots');
  const prog = $('dl-progress');
  const files = {};
  files['shots-summary.csv'] = rowsToCsv([SUMMARY_COLUMNS, ...all.map(({ shot, analysis, estimate }) => summaryRow(shot, analysis, estimate))]);
  files['backup.json'] = JSON.stringify(await store.exportAll());
  files['README.txt'] = `portal-met-bridge export — ${new Date().toString()}\n\nshots-summary.csv   one row per shot (EC metrics, refractometer reading, estimate)\nbackup.json         full backup; restore it with the Restore button\nshots/<shot>/       samples.csv, shot.json, time.jpg, ec-vs-mass.jpg, report.pdf per shot\n\nEC is a conductivity proxy; TDS/EY are estimates from refractometer calibration unless a refractometer reading is present.\n`;
  const selectedId = state.selected?.id;
  let i = 0;
  for (const { shot, analysis, estimate, fit } of all) {
    i++;
    prog.textContent = `Rendering ${i}/${all.length}…`;
    const dir = `shots/${fileBase(shot)}`;
    files[`${dir}/samples.csv`] = shotSamplesCsv(shot);
    files[`${dir}/shot.json`] = shotJson(shot, analysis, estimate);
    // Render this shot's charts, then capture.
    timeChart.setShot(shot.machine, shot.portal);
    massChart.setAnalysis(analysis);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    try {
      const images = await chartImages(shot, analysis);
      files[`${dir}/time.jpg`] = images.time.blob;
      if (images.mass) files[`${dir}/ec-vs-mass.jpg`] = images.mass.blob;
      files[`${dir}/report.pdf`] = await shotReportPdf(reportFor(shot, analysis, estimate, fit, images));
    } catch (err) {
      files[`${dir}/ERROR.txt`] = String(err?.message || err);
    }
  }
  prog.textContent = 'Zipping…';
  try {
    const blob = await buildZip(files);
    deliver(`portal-met-bridge-export-${stamp(Date.now())}.zip`, blob);
    prog.textContent = `${all.length} shots exported.`;
  } catch (err) {
    toast('Zip failed: ' + (err.message || err), 'error');
    prog.textContent = '';
  }
  if (selectedId) selectShot(selectedId);
  setTimeout(() => (prog.textContent = ''), 6000);
}

// ------------------------------------------------------------------- demo --

async function addDemoShot() {
  const shot = makeDemoShot({ seed: Math.floor(Math.random() * 1000) });
  shot.context = { ...readContext(), beanName: readContext().beanName || 'Demo coffee' };
  shot.analysisCache = summarize(analyzeShot(shot.portal, shot.machine.map((s) => ({ t: s.t, w: s.w }))));
  await store.putShot(shot);
  await refreshShotList();
  selectShot(shot.id);
}

let replayTimer = null;
function replayDemoLive() {
  if (replayTimer) return;
  const shot = makeDemoShot({ seed: Math.floor(Math.random() * 1000) });
  const speed = 2; // 2× real time
  const t0 = performance.now();
  let mi = 0;
  let pi = 0;
  // one idle status first so the recorder sees extracting rise
  recorder.onStatus({ extracting: false, timeMs: 0, w: 0, f: 0, p: 0, temp: 25, g: 0, name: 'idle', state: 'idle', profile: null, at: t0 });
  replayTimer = setInterval(() => {
    const elapsed = ((performance.now() - t0) / 1000) * speed;
    while (mi < shot.machine.length && shot.machine[mi].t <= elapsed) {
      const s = shot.machine[mi++];
      const extracting = s.t < shot.durationSec;
      onStatus({ extracting, timeMs: Math.round(s.t * 1000), w: s.w, f: s.f, p: s.p, temp: s.temp, g: s.g, name: s.status, state: extracting ? 'brewing' : 'idle', profile: shot.profileName, setpoints: null, at: performance.now() });
    }
    while (pi < shot.portal.length && shot.portal[pi].t <= elapsed) {
      const m = shot.portal[pi++];
      setText('ro-ec', m.ec.toFixed(3));
      setText('ro-tout', m.tOut.toFixed(1));
      recorder.onPortal({ ...m, at: performance.now() });
    }
    if (mi >= shot.machine.length && pi >= shot.portal.length) {
      // final idle status ends the recording through the normal path
      onStatus({ extracting: false, timeMs: -1, w: shot.finalWeightG, f: 0, p: 0, temp: 25, g: 0, name: 'idle', state: 'idle', profile: null, setpoints: null, at: performance.now() });
      clearInterval(replayTimer);
      replayTimer = null;
    }
  }, 50);
  toast('Replaying a synthetic shot at 2× speed.');
}

// --------------------------------------------------------------- context --

const CONTEXT_KEYS = ['beanName', 'roaster', 'roastLevel', 'process', 'origin', 'doseG', 'grindSize', 'grinderName', 'note'];

function readContext() {
  return {
    beanName: $('ctx-bean').value.trim(),
    roaster: $('ctx-roaster').value.trim(),
    roastLevel: $('ctx-roast').value,
    process: $('ctx-process').value,
    origin: $('ctx-origin').value.trim(),
    doseG: Number($('ctx-dose').value) || 0,
    grindSize: $('ctx-grind').value ? `${$('ctx-grind').value} µm` : '',
    grinderName: $('ctx-grinder').value.trim(),
    note: $('ctx-note').value.trim(),
  };
}

function writeContext(ctx) {
  $('ctx-bean').value = ctx.beanName ?? '';
  $('ctx-roaster').value = ctx.roaster ?? '';
  $('ctx-roast').value = ctx.roastLevel ?? '';
  $('ctx-process').value = ctx.process ?? '';
  $('ctx-origin').value = ctx.origin ?? '';
  $('ctx-dose').value = ctx.doseG || '';
  $('ctx-grind').value = (ctx.grindSize ?? '').replace(/\s*µm$/, '');
  $('ctx-grinder').value = ctx.grinderName ?? 'Zerno Z1';
  $('ctx-note').value = ctx.note ?? '';
}

/** Rebuild the bean / roaster pick-lists from the bean library. */
async function refreshBeanLists() {
  const beans = await store.listBeans();
  state.beans = beans;
  $('bean-list').innerHTML = beans.map((b) => `<option value="${esc(b.name)}">${esc([b.roaster, b.roastLevel, b.origin].filter(Boolean).join(' · '))}</option>`).join('');
  const roasters = [...new Set(beans.map((b) => b.roaster).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('roaster-list').innerHTML = roasters.map((r) => `<option value="${esc(r)}"></option>`).join('');
  $('bean-count').textContent = beans.length ? `(${beans.length} known)` : '';
}

/** A previous bean was picked (or typed exactly): fill in what we know about it. */
async function beanPicked() {
  const b = await store.getBean($('ctx-bean').value);
  if (!b) return false;
  if (!$('ctx-roaster').value.trim() || b.roaster) $('ctx-roaster').value = b.roaster || '';
  if (b.roastLevel) $('ctx-roast').value = b.roastLevel;
  if (b.process) $('ctx-process').value = b.process;
  if (b.origin) $('ctx-origin').value = b.origin;
  if (!$('ctx-dose').value && b.lastDoseG) $('ctx-dose').value = b.lastDoseG;
  if (!$('ctx-grind').value && b.lastGrind) $('ctx-grind').value = String(b.lastGrind).replace(/\s*µm$/, '');
  return true;
}

async function contextChanged(ev) {
  if (ev?.target?.id === 'ctx-bean') await beanPicked();
  const ctx = readContext();
  await store.setSetting('context', ctx);
  if (ctx.beanName) {
    await store.rememberBean(ctx);
    await refreshBeanLists();
  }
  // Apply to the selected shot too, so a bag name typed after the shot still counts.
  if (state.selected && state.selected.source !== 'demo') {
    const prev = state.selected.context || {};
    const changed = CONTEXT_KEYS.some((k) => (prev[k] ?? '') !== (ctx[k] ?? ''));
    if (changed) {
      state.selected.context = ctx;
      state.selected.analysisCache = summarize(state.analysis);
      await store.putShot(state.selected);
      await refreshShotList();
      renderShot();
    }
  }
}

// ---------------------------------------------------------------- helpers --

function setLink(which, st, detail) {
  const el = $(`link-${which}`);
  el.querySelector('.dot').dataset.state = st;
  $(`${which}-detail`).textContent = detail || st;
}
function setText(id, v) {
  $(id).textContent = v;
}
function setStatus(id, msg, level) {
  const el = $(id);
  el.textContent = msg;
  el.dataset.level = level;
}
const fmt = (x, d) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function fmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
let toastTimer = null;
function toast(msg, level = 'info') {
  if (level === 'error') log.error('ui', msg);
  else log.debug('ui', msg);
  const el = $('toast');
  el.textContent = msg;
  el.dataset.level = level;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), level === 'error' ? 7000 : 4500);
}

// ------------------------------------------------------------ log & debug --

const LOG_FOLDER_KEY = 'logFolderHandle';

async function restoreLogFolder() {
  try {
    const handle = await store.getSetting(LOG_FOLDER_KEY, null);
    if (handle && typeof handle.queryPermission === 'function') await log.useFolder(handle);
  } catch (err) {
    log.warn('log', `could not restore the log folder: ${err?.message || err}`);
  }
  renderLogFolder();
}

async function pickLogFolder() {
  try {
    const handle = await log.pickFolder();
    try {
      await store.setSetting(LOG_FOLDER_KEY, handle); // Chrome can persist the handle
    } catch (err) {
      log.warn('log', `folder handle could not be saved for next time: ${err?.message || err}`);
    }
    renderLogFolder();
    toast(`Log folder set to ${handle.name}`);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    toast(err.message || String(err), 'error');
  }
}

async function reallowLogFolder() {
  if (!log.folder) return;
  await log.useFolder(log.folder, { request: true });
  renderLogFolder();
}

async function forgetLogFolder() {
  await log.flush().catch(() => {});
  log.forgetFolder();
  await store.setSetting(LOG_FOLDER_KEY, null);
  renderLogFolder();
}

function renderLogFolder() {
  const name = log.folder?.name;
  const st = log.folderState;
  const el = $('log-folder');
  $('log-reallow-folder').hidden = st !== 'prompt';
  $('log-forget-folder').hidden = !log.folder;
  if (!log.folder) el.textContent = Logger.canPickFolder ? 'No folder chosen — the log stays in the page.' : 'Folder picking needs Chrome or Edge; use Download instead.';
  else if (st === 'granted') el.textContent = `${name}/portal-met-bridge/ — writable${log.bytesWritten ? ` · ${(log.bytesWritten / 1024).toFixed(1)} kB written this session` : ''}${log.lastFlushError ? ' · last error: ' + log.lastFlushError : ''}`;
  else if (st === 'prompt') el.textContent = `${name} — Chrome needs you to re-allow it (click Re-allow folder).`;
  else el.textContent = `${name} — not writable (${st}${log.lastFlushError ? ': ' + log.lastFlushError : ''}).`;
  renderLogStatus();
}

function renderLogStatus() {
  const bits = [];
  bits.push(log.enabled ? `on · ${settings.logLevel}${settings.logPackets ? ' + packets' : ''}` : 'off');
  bits.push(`${log.ring.length} lines in memory${log.dropped ? ` (${log.dropped} dropped)` : ''}`);
  if (log.folder && log.folderState === 'granted') bits.push(`writing to ${log.folder.name}`);
  $('log-status').textContent = bits.join(' · ');
  const tab = document.querySelector('.view-tab[data-view="settings"]');
  let badge = tab.querySelector('.badge');
  if (log.enabled && !badge) {
    badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'debug';
    tab.appendChild(badge);
  } else if (!log.enabled && badge) badge.remove();
}

let tailDirty = true;
function renderLogTail() {
  const el = $('log-tail');
  if (!settings.logShowTail || $('view-settings').hidden) return;
  if (!tailDirty) return;
  tailDirty = false;
  const lines = log.ring.slice(-300);
  el.innerHTML = lines.map((e) => `<span class="lvl-${e.level}">${esc(formatLine(e))}</span>`).join('\n');
  el.scrollTop = el.scrollHeight;
  renderLogStatus();
}
log.addEventListener('entry', () => {
  tailDirty = true;
});
log.addEventListener('cleared', () => {
  tailDirty = true;
  renderLogTail();
});
log.addEventListener('folder', () => renderLogFolder());
setInterval(renderLogTail, 700);
window.addEventListener('beforeunload', () => {
  log.flush().catch(() => {});
});

async function downloadLog(json = false) {
  await log.flush().catch(() => {});
  const name = `portal-met-bridge-log-${stamp(Date.now())}.${json ? 'jsonl' : 'txt'}`;
  await deliver(name, json ? log.asJsonLines() : log.asText(), 'text/plain', 'logs');
}

async function copyLogTail() {
  try {
    await navigator.clipboard.writeText(log.ring.slice(-200).map(formatLine).join('\n'));
    toast('Copied the last 200 log lines.');
  } catch (err) {
    toast('Copy failed: ' + (err.message || err), 'error');
  }
}

// ---------------------------------------------------------------- events --

document.querySelectorAll('.view-tab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('mc-refresh-profiles').addEventListener('click', () => machinePanel.refreshProfiles());
$('mc-refresh-stats').addEventListener('click', () => machinePanel.refreshStats());
$('meticulous-connect').addEventListener('click', connectMeticulous);
$('meticulous-disconnect').addEventListener('click', disconnectMeticulous);
$('portal-connect').addEventListener('click', connectPortal);
$('portal-disconnect').addEventListener('click', () => portal.disconnect());
$('portal-show-graph').addEventListener('click', () => portal.showGraph().then(() => toast('Portal acknowledged the graph-on command.')).catch((e) => toast(e.message, 'error')));
$('portal-hide-graph').addEventListener('click', () => portal.hideGraph().then(() => toast('Portal acknowledged the graph-off command.')).catch((e) => toast(e.message, 'error')));

$('rec-manual').addEventListener('click', () => (recorder.isRecording ? recorder.stopManual() : recorder.startManual()));
for (const [key, spec] of Object.entries(SETTINGS)) {
  const el = $(spec.el);
  if (el) el.addEventListener('change', () => settingChanged(key));
}
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.goto)));
$('meticulous-test').addEventListener('click', testMeticulous);
$('settings-export').addEventListener('click', () => deliver(`portal-met-bridge-settings-${stamp(Date.now())}.json`, JSON.stringify(settingsDocument(), null, 2), 'application/json', 'backups'));
$('settings-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const n = await importSettingsDocument(JSON.parse(await file.text()));
    toast(`Imported ${n} settings.`);
    log.info('settings', `imported ${n} settings from ${file.name}`);
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  e.target.value = '';
});
$('settings-reset').addEventListener('click', async () => {
  if (!confirm('Reset every setting to its default? Shots, beans and the log folder are kept.')) return;
  await resetSettings();
  toast('Settings reset to defaults.');
});
$('log-pick-folder').addEventListener('click', pickLogFolder);
$('log-reallow-folder').addEventListener('click', reallowLogFolder);
$('log-forget-folder').addEventListener('click', forgetLogFolder);
$('log-download').addEventListener('click', () => downloadLog(false));
$('log-download-json').addEventListener('click', () => downloadLog(true));
$('log-copy').addEventListener('click', copyLogTail);
$('log-clear').addEventListener('click', () => log.clear());
for (const id of ['ctx-bean', 'ctx-roaster', 'ctx-roast', 'ctx-process', 'ctx-origin', 'ctx-dose', 'ctx-grind', 'ctx-grinder', 'ctx-note']) $(id).addEventListener('change', contextChanged);

$('ref-tds').addEventListener('input', updateRefEy);
$('ref-bev').addEventListener('input', updateRefEy);
$('ref-save').addEventListener('click', saveRefractometer);
$('ref-clear').addEventListener('click', clearRefractometer);
$('shot-delete').addEventListener('click', deleteShot);
$('shot-refresh').addEventListener('click', () => state.selected && refreshFromMachine(state.selected.id));
$('mach-last').addEventListener('click', fetchLastFromMachine);
$('bc-copy').addEventListener('click', copyFullLink);
$('bc-open').addEventListener('click', openLink);
$('bc-json').addEventListener('click', downloadEnvelope);
$('dl-csv').addEventListener('click', downloadCsv);
$('dl-json').addEventListener('click', downloadShotJson);
$('dl-jpeg').addEventListener('click', downloadJpegs);
$('dl-pdf').addEventListener('click', downloadPdf);
$('dl-summary').addEventListener('click', downloadSummaryCsv);
$('dl-zip').addEventListener('click', downloadZip);
$('demo-load').addEventListener('click', addDemoShot);
$('demo-replay').addEventListener('click', replayDemoLive);
$('backup-export').addEventListener('click', async () => {
  const doc = await store.exportAll();
  await deliver(`portal-met-bridge-backup-${stamp(Date.now())}.json`, JSON.stringify(doc), 'application/json', 'backups');
  $('backup-note').textContent = `${doc.shots.length} shots, ${doc.beans.length} beans.`;
});
$('backup-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const n = await store.importAll(JSON.parse(await file.text()));
    await refreshBeanLists();
    await refreshShotList();
    toast(`Restored ${n} shots.`);
  } catch (err) {
    toast(err.message || String(err), 'error');
  }
  e.target.value = '';
});

// Handy in the console while debugging: window.__pb.state.selected, .massChart.u, ...
window.__pb = { state, store, portal, recorder, timeChart, massChart, calChart, machinePanel, settings, log, get meticulous() { return meticulous; } };

init().catch((err) => {
  console.error(err);
  toast('Start-up problem: ' + (err.message || err), 'error');
});
